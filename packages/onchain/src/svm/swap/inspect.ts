import type { RejectCode } from '@defimind/shared'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenInstruction,
} from '@solana/spl-token'
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  PublicKey,
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
}

// A route needs far more compute than a transfer. The priority fee is bounded in lamports rather
// than per unit, so a high limit cannot multiply it: at the cap it costs 0.001 SOL.
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000
export const MAX_PRIORITY_LAMPORTS = 1_000_000n
const CREATE_IDEMPOTENT = 1

/**
 * The swap transaction, with its lookup tables written out, read against every inspectTransfer
 * rule. Jupiter is untrusted, so what it routes through is left to the test run; this only refuses
 * what no swap of ours needs: another signer, a standing authority over the hot wallet's tokens, a
 * program outside the list, or a priority fee past the cap. Wrapped SOL stays wrapped, so no System
 * instruction belongs here either.
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
  for (const ix of expanded.instructions) {
    const program = ix.programId
    if (program.equals(JUPITER_PROGRAM_ID)) {
      routes++
    } else if (program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID)) {
      reasons.add(tokenReason(ix))
    } else if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (!createsOwnAccount(ix, sides)) reasons.add('SIM_UNEXPECTED_EFFECT')
    } else if (program.equals(ComputeBudgetProgram.programId)) {
      const budget = computeBudget(ix)
      if (budget === undefined) reasons.add('SIM_UNEXPECTED_EFFECT')
      else if (budget.units !== undefined) units = budget.units
      else microLamports = budget.microLamports
    } else if (program.equals(SystemProgram.programId)) {
      reasons.add('SIM_UNEXPECTED_EFFECT')
    } else {
      reasons.add('UNKNOWN_PROGRAM_DETECTED')
    }
  }
  // One route: a second could be a second trade the quote never showed.
  if (routes !== 1) reasons.add('SIM_UNEXPECTED_EFFECT')
  if (
    units > BigInt(MAX_COMPUTE_UNIT_LIMIT) ||
    (units * microLamports) / 1_000_000n > MAX_PRIORITY_LAMPORTS
  ) {
    reasons.add('SIM_UNEXPECTED_EFFECT')
  }
  return [...reasons]
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
