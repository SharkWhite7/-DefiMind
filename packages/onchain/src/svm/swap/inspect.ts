import type { RejectCode } from '@defimind/shared'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenInstruction,
} from '@solana/spl-token'
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  type TransactionInstruction,
  type TransactionMessage,
  type VersionedMessage,
} from '@solana/web3.js'

/** Jupiter's aggregator, v6: the only venue (CR-021). */
export const JUPITER_PROGRAM_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')

export interface SwapSides {
  hotWallet: PublicKey
  tokenIn: PublicKey
  tokenOut: PublicKey
  amountIn: bigint
  /** What the owner or the policy approved: the route itself must refuse to deliver less. */
  minAmountOut: bigint
}

// Jupiter v6's exact-in routes (Anchor: sha256("global:<name>")[..8]). The token-ledger and exact-out
// variants spend an amount the instruction does not state, so they are not ours to sign.
// Each with where its accounts sit: who signs, what it spends from, where the output lands, and
// for route the optional destination_token_account, which is Jupiter's own id when unset.
const EXACT_IN_ROUTES = [
  {
    discriminator: Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]),
    signer: 1,
    source: 2,
    destination: 3,
    override: 4,
  }, // route
  {
    discriminator: Buffer.from([193, 32, 155, 51, 65, 214, 156, 129]),
    signer: 2,
    source: 3,
    destination: 6,
  }, // shared_accounts_route
]
// Both end with in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u8.
const TERMS_BYTES = 19

// A route needs far more compute than a transfer. The priority fee is bounded in lamports rather
// than per unit, so a high limit cannot multiply it: at the cap it costs 0.001 SOL.
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000
export const MAX_PRIORITY_LAMPORTS = 1_000_000n
const SIGNATURE_FEE = 5_000n
const CREATE_IDEMPOTENT = 1

/**
 * The swap transaction, with its lookup tables written out, read against every inspectTransfer
 * rule. Jupiter is untrusted, so what it routes through is left to the test run; this only refuses
 * what no swap of ours needs: another signer, a standing authority over the hot wallet's tokens, a
 * program outside the list, or a priority fee past the cap. A SOL leg (CR-026) adds one shape only:
 * the hot wallet's own wSOL account, amountIn moved into it and synced when SOL is sold, and that
 * account closed back to the hot wallet.
 */
export function inspectSwap(
  signed: VersionedMessage,
  expanded: TransactionMessage,
  sides: SwapSides,
): RejectCode[] {
  const reasons = new Set<RejectCode>()
  if (!expanded.payerKey.equals(sides.hotWallet) || signed.header.numRequiredSignatures !== 1) {
    reasons.add('SIM_UNEXPECTED_EFFECT')
  }
  let routes = 0
  let units = 200_000n
  let microLamports = 0n
  // Where each piece of a SOL leg sits, in order: the wrap must come before the route, the close after.
  const at = {
    create: [] as number[],
    transfer: [] as number[],
    sync: [] as number[],
    route: [] as number[],
    close: [] as number[],
  }
  const solIn = sides.tokenIn.equals(NATIVE_MINT)
  const sol = solIn || sides.tokenOut.equals(NATIVE_MINT)
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, sides.hotWallet)
  expanded.instructions.forEach((ix, i) => {
    const program = ix.programId
    if (program.equals(JUPITER_PROGRAM_ID)) {
      routes++
      at.route.push(i)
      const reason = routeReason(ix, sides)
      if (reason) reasons.add(reason)
    } else if (sol && program.equals(TOKEN_PROGRAM_ID) && isSync(ix, wsol)) {
      at.sync.push(i)
    } else if (sol && program.equals(TOKEN_PROGRAM_ID) && isClose(ix, wsol, sides.hotWallet)) {
      at.close.push(i)
    } else if (program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID)) {
      reasons.add(tokenReason(ix))
    } else if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (!createsOwnAccount(ix, sides)) reasons.add('SIM_UNEXPECTED_EFFECT')
      else if (ix.keys[3]!.pubkey.equals(NATIVE_MINT)) at.create.push(i)
    } else if (program.equals(ComputeBudgetProgram.programId)) {
      const budget = computeBudget(ix)
      if (budget === undefined) reasons.add('SIM_UNEXPECTED_EFFECT')
      else if (budget.units !== undefined) units = budget.units
      else microLamports = budget.microLamports
    } else if (solIn && isWrap(ix, sides.hotWallet, wsol, sides.amountIn)) {
      at.transfer.push(i)
    } else if (program.equals(SystemProgram.programId)) {
      reasons.add('SIM_UNEXPECTED_EFFECT')
    } else {
      reasons.add('UNKNOWN_PROGRAM_DETECTED')
    }
  })
  // One route: a second could be a second trade the quote never showed.
  if (routes !== 1) reasons.add('SIM_UNEXPECTED_EFFECT')
  if (sol && !wrapShape(at, solIn)) reasons.add('SIM_UNEXPECTED_EFFECT')
  if (
    units > BigInt(MAX_COMPUTE_UNIT_LIMIT) ||
    (units * microLamports) / 1_000_000n > MAX_PRIORITY_LAMPORTS
  ) {
    reasons.add('SIM_UNEXPECTED_EFFECT')
  }
  return [...reasons]
}

/**
 * The route's own terms, held to the swap: the test run proves the output only at simulation time,
 * so a route whose slippage lets it deliver less than the approved minimum would hand the
 * difference to whoever moves the price before it lands.
 */
function routeReason(ix: TransactionInstruction, sides: SwapSides): RejectCode | undefined {
  const data = ix.data
  const layout = EXACT_IN_ROUTES.find((r) => data.subarray(0, 8).equals(r.discriminator))
  if (!layout || data.length < 8 + 4 + TERMS_BYTES) return 'SIM_UNEXPECTED_EFFECT'
  // The hot wallet spends from its own tokenIn account, and the output lands in its own tokenOut
  // account: a route cannot park the proceeds where the test run would not look for them.
  const key = (i: number | undefined) => (i === undefined ? undefined : ix.keys[i]?.pubkey)
  const own = (account: PublicKey | undefined, mint: PublicKey) =>
    !!account && owned(sides.hotWallet, mint).some((ata) => ata.equals(account))
  const override = key(layout.override)
  if (
    !key(layout.signer)?.equals(sides.hotWallet) ||
    !own(key(layout.source), sides.tokenIn) ||
    !own(key(layout.destination), sides.tokenOut) ||
    (layout.override !== undefined && !override?.equals(JUPITER_PROGRAM_ID))
  ) {
    return 'SIM_UNEXPECTED_EFFECT'
  }
  const terms = data.subarray(data.length - TERMS_BYTES)
  const inAmount = terms.readBigUInt64LE(0)
  const quotedOut = terms.readBigUInt64LE(8)
  const slippageBps = BigInt(terms.readUInt16LE(16))
  const feeBps = terms.readUInt8(18)
  if (inAmount !== sides.amountIn || feeBps !== 0 || slippageBps > 10_000n) {
    return 'SIM_UNEXPECTED_EFFECT'
  }
  // Rounded up, as Jupiter rounds the threshold it quotes: the two agree to the atomic unit.
  const enforced = (quotedOut * (10_000n - slippageBps) + 9_999n) / 10_000n
  if (enforced < sides.minAmountOut) return 'SLIPPAGE_TOO_HIGH'
  return undefined
}

/** No token instruction belongs at the top level of a swap: the route moves tokens itself. */
function tokenReason(ix: TransactionInstruction): RejectCode {
  switch (ix.data[0]) {
    case TokenInstruction.Approve:
    case TokenInstruction.ApproveChecked:
      return 'DELEGATE_DETECTED'
    case TokenInstruction.SetAuthority:
      return 'AUTHORITY_CHANGE_DETECTED'
    case TokenInstruction.CloseAccount:
      return 'ACCOUNT_CLOSE_DETECTED'
    default:
      return 'SIM_UNEXPECTED_EFFECT'
  }
}

/** The hot wallet's associated account for a mint, under either token program. */
const owned = (hot: PublicKey, mint: PublicKey) =>
  [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((program) =>
    getAssociatedTokenAddressSync(mint, hot, false, program),
  )

/**
 * The one SOL-leg shape, in order. Selling SOL: create the wSOL account, move amountIn in, sync,
 * route, close. Buying SOL: create, route, close. Each once.
 */
function wrapShape(
  at: { create: number[]; transfer: number[]; sync: number[]; route: number[]; close: number[] },
  solIn: boolean,
) {
  const one = (list: number[]) => (list.length === 1 ? list[0]! : undefined)
  const [create, route, close] = [one(at.create), one(at.route), one(at.close)]
  if (create === undefined || route === undefined || close === undefined) return false
  if (!solIn)
    return at.transfer.length === 0 && at.sync.length === 0 && create < route && route < close
  const [transfer, sync] = [one(at.transfer), one(at.sync)]
  return (
    transfer !== undefined &&
    sync !== undefined &&
    create < transfer &&
    transfer < sync &&
    sync < route &&
    route < close
  )
}

/** What the transaction pays in fees: the signature, and the priority on the units it asks for. */
export function swapFee(expanded: TransactionMessage): bigint {
  let units = 200_000n
  let microLamports = 0n
  for (const ix of expanded.instructions) {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) continue
    const budget = computeBudget(ix)
    if (budget?.units !== undefined) units = budget.units
    else if (budget) microLamports = budget.microLamports
  }
  return SIGNATURE_FEE + (units * microLamports + 999_999n) / 1_000_000n
}

/** amountIn, exactly, from the hot wallet into its own wSOL account. */
function isWrap(ix: TransactionInstruction, hot: PublicKey, wsol: PublicKey, amount: bigint) {
  if (!ix.programId.equals(SystemProgram.programId)) return false
  try {
    if (SystemInstruction.decodeInstructionType(ix) !== 'Transfer') return false
    const { fromPubkey, toPubkey, lamports } = SystemInstruction.decodeTransfer(ix)
    return fromPubkey.equals(hot) && toPubkey.equals(wsol) && BigInt(lamports) === amount
  } catch {
    return false
  }
}

const isSync = (ix: TransactionInstruction, wsol: PublicKey) =>
  ix.data.length === 1 &&
  ix.data[0] === TokenInstruction.SyncNative &&
  ix.keys.length === 1 &&
  ix.keys[0]!.pubkey.equals(wsol)

/** The hot wallet's wSOL account closed back to it: the unwrap, and nothing else closes. */
const isClose = (ix: TransactionInstruction, wsol: PublicKey, hot: PublicKey) => {
  const [account, destination, owner] = ix.keys.map((key) => key.pubkey)
  return (
    ix.data.length === 1 &&
    ix.data[0] === TokenInstruction.CloseAccount &&
    ix.keys.length === 3 &&
    !!account?.equals(wsol) &&
    !!destination?.equals(hot) &&
    !!owner?.equals(hot)
  )
}

/** The hot wallet creating its own account for one side of the swap, and paying for it. */
function createsOwnAccount(
  ix: TransactionInstruction,
  { hotWallet, tokenIn, tokenOut }: SwapSides,
) {
  const [payer, , owner, mint] = ix.keys.map((key) => key.pubkey)
  return (
    ix.data.length === 1 &&
    ix.data[0] === CREATE_IDEMPOTENT &&
    !!payer?.equals(hotWallet) &&
    !!owner?.equals(hotWallet) &&
    (!!mint?.equals(tokenIn) || !!mint?.equals(tokenOut))
  )
}

function computeBudget(ix: TransactionInstruction) {
  try {
    switch (ComputeBudgetInstruction.decodeInstructionType(ix)) {
      case 'SetComputeUnitLimit':
        return { units: BigInt(ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units) }
      case 'SetComputeUnitPrice':
        return {
          microLamports: BigInt(
            ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports,
          ),
        }
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}
