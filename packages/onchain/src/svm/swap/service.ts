import type { Amount, PayIntent, RejectCode, SwapQuote } from '@defimind/shared'
import {
  ACCOUNT_SIZE,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token'
import {
  PublicKey,
  type AccountInfo,
  type Connection,
  type Keypair,
  type VersionedTransaction,
} from '@solana/web3.js'
import type { SimulationOutcome } from '../../ChainAdapter.js'
import { gasMinimum } from '../gas.js'
import { confirm } from '../squads.js'
import { fromSimulation, holding, TOKEN_PROGRAMS } from './accounts.js'
import { swapEffects, type Holding } from './effects.js'
import { inspectSwap, swapFee } from './inspect.js'
import type { Venue } from './jupiter.js'
import { expand } from './lookup.js'
import { mintFacts } from './mint.js'
import { checkQuote } from './quote.js'
import { exitImpact } from './risk.js'

export interface SwapDeps {
  connection: Connection
  hotWallet: Keypair
  /** The chain's dollar: one side of every swap (CR-021, phase 1). */
  dollar: PublicKey
  venue: Venue
}

const CHECKED_TTL_MS = 90_000

/**
 * Swaps through an untrusted venue. Every quote is held to its request and every transaction is
 * inspected with its lookup tables written out, then run; send() signs only the transaction whose
 * run matched the intent, and only once.
 */
export function swaps({ connection, hotWallet, dollar, venue }: SwapDeps) {
  const hot = hotWallet.publicKey
  // A checked transaction is good until its blockhash expires, about a minute; kept no longer.
  const checked = new Map<
    string,
    { tx: VersionedTransaction; at: number; cost: bigint; exempt: boolean }
  >()
  const fresh = (entry?: { at: number }) => !!entry && Date.now() - entry.at < CHECKED_TTL_MS

  async function quoteSwap(req: {
    tokenIn: string
    tokenOut: string
    amountIn: Amount
    slippageBps: number
  }): Promise<SwapQuote> {
    const request = {
      inputMint: new PublicKey(req.tokenIn).toBase58(),
      outputMint: new PublicKey(req.tokenOut).toBase58(),
      amount: positive(req.amountIn),
      slippageBps: slippage(req.slippageBps),
    }
    // Any pair (CR-026). Whatever is bought, unless it is the dollar, meets the buy's checks.
    const buy = request.outputMint !== dollar.toBase58()
    const quote = checkQuote(await venue.quote(request), request)
    const mints = [new PublicKey(request.inputMint), new PublicKey(request.outputMint)]
    const [infoIn, infoOut] = await connection.getMultipleAccountsInfo(mints)
    const factsIn = mintFacts(mints[0]!, infoIn ?? null)
    const factsOut = mintFacts(mints[1]!, infoOut ?? null)
    const risks: RejectCode[] = []
    let exitImpactBps: number | null = null
    if (buy) {
      risks.push(...factsOut.risks)
      exitImpactBps = await exitImpact(
        venue,
        dollar,
        request.outputMint,
        quote.expectedOut,
        request.slippageBps,
      )
      if (exitImpactBps === null) risks.push('NO_EXIT_ROUTE')
    }
    return {
      venue: 'jupiter',
      tokenIn: request.inputMint,
      amountIn: request.amount.toString(),
      tokenOut: request.outputMint,
      expectedOut: quote.expectedOut.toString(),
      minAmountOut: quote.minAmountOut.toString(),
      slippageBps: request.slippageBps,
      priceImpactBps: quote.priceImpactBps,
      exitImpactBps,
      risks,
      flags: buy && factsOut.mintAuthority ? ['MINT_AUTHORITY'] : [],
      decimalsIn: factsIn.decimals,
      decimalsOut: factsOut.decimals,
      quotedAt: new Date().toISOString(),
    }
  }

  async function simulate(intent: PayIntent): Promise<SimulationOutcome> {
    for (const [id, entry] of checked) if (!fresh(entry)) checked.delete(id)
    checked.delete(intent.id)
    const swap = intent.swap
    if (!swap || swap.venue !== 'jupiter') return refused('VENUE_NOT_ALLOWED', 'not a Jupiter swap')
    const request = {
      inputMint: intent.token,
      outputMint: swap.tokenOut,
      amount: positive(intent.amount),
      slippageBps: slippage(swap.slippageBps),
    }
    const minAmountOut = positive(swap.minAmountOut)
    const quote = await venue.quote(request)
    // Re-quoted for a fresh transaction: it must still promise what was approved, or it is not
    // the swap the owner or the policy agreed to.
    if (checkQuote(quote, request).minAmountOut < minAmountOut) {
      return refused('SLIPPAGE_TOO_HIGH', 'the market moved past the approved minimum')
    }
    const tx = await venue.swap(quote, hot.toBase58())
    const expanded = await expand(connection, tx.message)
    if (!expanded) return refused('HIDDEN_ACCOUNTS_DETECTED', 'a lookup table could not be trusted')
    const sides = {
      hotWallet: hot,
      tokenIn: new PublicKey(request.inputMint),
      tokenOut: new PublicKey(request.outputMint),
      amountIn: request.amount,
      minAmountOut,
    }
    const inspected = inspectSwap(tx.message, expanded, sides)
    if (inspected.length > 0) return { simulation: describe(intent, []), rejectReasons: inspected }

    const watched = await watch(expanded.instructions.flatMap((ix) => ix.keys))
    const before = await connection.getMultipleAccountsInfo(watched)
    const { value } = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: 'base64', addresses: watched.map((key) => key.toBase58()) },
    })
    if (value.err || !value.accounts) {
      const summary = `simulation failed: ${JSON.stringify(value.err ?? 'no accounts returned')}`
      return { simulation: { summary, balanceChanges: [] }, rejectReasons: ['SIM_FAILED'] }
    }
    const after = value.accounts.map(fromSimulation)
    const fee = swapFee(expanded)
    const { effects, hadDollar } = await holdings(watched, before, after, {
      ...request,
      minAmountOut,
      fee,
    })
    // What the hot wallet's own lamports pay, kept to check the gas reserve again at send time.
    // The test run has already taken the fee from the hot wallet's lamports.
    const cost = BigInt(before[0]?.lamports ?? 0) - BigInt(after[0]?.lamports ?? 0)
    const exempt = await sellOut(request.outputMint, cost, fee, hadDollar)
    const short = !exempt && BigInt(after[0]?.lamports ?? 0) < (await gasFloor())
    const reasons: RejectCode[] = [...effects.reasons, ...(short ? (['GAS_RESERVE'] as const) : [])]
    const outcome = { simulation: describe(intent, effects.changes), rejectReasons: reasons }
    if (reasons.length === 0) checked.set(intent.id, { tx, at: Date.now(), cost, exempt })
    return outcome
  }

  /** The hot wallet, its token accounts now, and every writable account the transaction names. */
  async function watch(keys: { pubkey: PublicKey; isWritable: boolean }[]) {
    const owned = await Promise.all(
      TOKEN_PROGRAMS.map((programId) => connection.getTokenAccountsByOwner(hot, { programId })),
    )
    const all = [
      hot,
      ...owned.flatMap(({ value }) => value.map(({ pubkey }) => pubkey)),
      ...keys.filter((key) => key.isWritable).map((key) => key.pubkey),
    ]
    return [...new Map(all.map((key) => [key.toBase58(), key])).values()]
  }

  /** The hot wallet must still pay for the next sell after a swap's fees (CR-026). */
  const gasFloor = async () =>
    gasMinimum(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE))

  /**
   * A sell to the dollar whose SOL cost is its fee, and at most one token account's rent when the
   * hot wallet has no dollar account yet, is exempt from the gas reserve (SPEC v0.20): Close
   * positions must stay the way out of a wallet already short of gas.
   */
  async function sellOut(tokenOut: string, cost: bigint, fee: bigint, hadDollar: boolean) {
    if (tokenOut !== dollar.toBase58()) return false
    const rent = hadDollar
      ? 0n
      : BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE))
    return cost <= fee + rent
  }

  async function holdings(
    watched: PublicKey[],
    before: (AccountInfo<Buffer> | null)[],
    after: (AccountInfo<Buffer> | null)[],
    deal: {
      inputMint: string
      outputMint: string
      amount: bigint
      minAmountOut: bigint
      fee: bigint
    },
  ) {
    const was = new Map<string, Holding | null>()
    const now = new Map<string, Holding | null>()
    const opened: number[] = []
    watched.forEach((address, i) => {
      const prior = holding(address, before[i] ?? null)
      const next = holding(address, after[i] ?? null)
      const ours = (h: Holding | null) => h?.owner === hot.toBase58()
      if (!ours(prior) && !ours(next)) return
      was.set(address.toBase58(), ours(prior) ? prior : null)
      now.set(address.toBase58(), next)
      // An account the swap opens for the hot wallet costs it that account's rent, never more:
      // the account's lamports could hold anything the route put there.
      if (!ours(prior) && next && next.mint !== NATIVE_MINT.toBase58()) {
        opened.push(after[i]!.data.length)
      }
    })
    const rents = await Promise.all(
      opened.map((size) => connection.getMinimumBalanceForRentExemption(size)),
    )
    const hadDollar = [...was.values()].some((h) => h?.mint === dollar.toBase58())
    const effects = swapEffects(
      was,
      now,
      { before: BigInt(before[0]?.lamports ?? 0), after: BigInt(after[0]?.lamports ?? 0) },
      {
        hotWallet: hot.toBase58(),
        tokenIn: deal.inputMint,
        amountIn: deal.amount,
        tokenOut: deal.outputMint,
        minAmountOut: deal.minAmountOut,
        fee: deal.fee,
        rent: rents.reduce((sum, rent) => sum + BigInt(rent), 0n),
        wsolAccount: getAssociatedTokenAddressSync(NATIVE_MINT, hot).toBase58(),
      },
    )
    return { effects, hadDollar }
  }

  async function send(intent: PayIntent): Promise<string> {
    const entry = checked.get(intent.id)
    checked.delete(intent.id)
    if (!entry || !fresh(entry)) throw new Error(`swap_not_simulated: ${intent.id}`)
    const { tx, cost, exempt } = entry
    // Checked again now: another swap or a payment since the test run may have spent the margin.
    if (!exempt && BigInt(await connection.getBalance(hot)) - cost < (await gasFloor())) {
      throw new Error(`send_refused: GAS_RESERVE`)
    }
    tx.sign([hotWallet])
    return confirm(connection, await connection.sendRawTransaction(tx.serialize()))
  }

  async function getPositions() {
    const owned = await Promise.all(
      TOKEN_PROGRAMS.map((programId) => connection.getTokenAccountsByOwner(hot, { programId })),
    )
    const totals = new Map<string, bigint>()
    for (const { pubkey, account } of owned.flatMap(({ value }) => value)) {
      const { mint, amount } = unpackAccount(pubkey, account, account.owner)
      if (amount > 0n && !mint.equals(dollar)) {
        totals.set(mint.toBase58(), (totals.get(mint.toBase58()) ?? 0n) + amount)
      }
    }
    // SOL bought is unwrapped into the hot wallet's own lamports (CR-026). What is above the gas
    // reserve counts with any wSOL held; the reserve is never a position, so Close leaves it.
    const wsol = NATIVE_MINT.toBase58()
    const spare = BigInt(await connection.getBalance(hot)) - (await gasFloor())
    const sol = (totals.get(wsol) ?? 0n) + (spare > 0n ? spare : 0n)
    totals.delete(wsol)
    const mints = [...totals.keys()].map((mint) => new PublicKey(mint))
    const infos = mints.length ? await connection.getMultipleAccountsInfo(mints) : []
    return [
      ...mints.map((mint, i) => ({
        token: mint.toBase58(),
        amount: totals.get(mint.toBase58())!.toString(),
        decimals: unpackMint(mint, infos[i] ?? null, infos[i]?.owner).decimals,
      })),
      ...(sol > 0n ? [{ token: wsol, amount: sol.toString(), decimals: 9 }] : []),
    ]
  }

  return { quoteSwap, simulate, send, getPositions }
}

function positive(amount: Amount): bigint {
  if (!/^[1-9]\d{0,19}$/.test(amount)) throw new Error(`invalid_amount: ${amount}`)
  return BigInt(amount)
}

function slippage(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error(`invalid_slippage: ${bps}`)
  return bps
}

const refused = (reason: RejectCode, why: string): SimulationOutcome => ({
  simulation: { summary: `not simulated: ${why}`, balanceChanges: [] },
  rejectReasons: [reason],
})

function describe(intent: PayIntent, changes: { token: string; delta: string }[]) {
  return {
    summary: `swaps ${intent.amount} of ${intent.token} for at least ${intent.swap?.minAmountOut} of ${intent.swap?.tokenOut}`,
    balanceChanges: changes,
  }
}
