import type { ConfirmedTransactionMeta, TokenBalance } from '@solana/web3.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { landedChanges } from '../src/svm/landed.js'
import { chain } from './fixture.js'

const HOT = 'HotWa11et1111111111111111111111111111111111'
const POOL = 'Poo1111111111111111111111111111111111111111'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const MEME = 'Meme111111111111111111111111111111111111111'

const balance = (accountIndex: number, owner: string, mint: string, amount: bigint) =>
  ({
    accountIndex,
    owner,
    mint,
    uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null },
  }) as TokenBalance

// The hot wallet pays the fee and moves no other SOL, so no SOL leg shows.
const meta = (pre: TokenBalance[], post: TokenBalance[], err: unknown = null) =>
  ({
    err,
    fee: 5000,
    preBalances: [1_000_000_000],
    postBalances: [1_000_000_000 - 5000],
    preTokenBalances: pre,
    postTokenBalances: post,
  }) as ConfirmedTransactionMeta

describe('the changes a transaction landed for the hot wallet', () => {
  it('nets each mint across the hot wallet accounts, and ignores everyone else', () => {
    const pre = [balance(1, HOT, USDC, 10_000_000n), balance(3, POOL, MEME, 9_000_000_000n)]
    const post = [
      balance(1, HOT, USDC, 5_000_000n),
      // An account the swap opened: no pre balance at all.
      balance(2, HOT, MEME, 4_483_276n),
      balance(3, POOL, MEME, 8_995_516_724n),
    ]
    expect(landedChanges(meta(pre, post), HOT, 0)).toEqual([
      { token: USDC, delta: '-5000000' },
      { token: MEME, delta: '4483276' },
    ])
  })

  it('adds up two accounts of the same mint, and leaves out what did not move', () => {
    const pre = [balance(1, HOT, USDC, 1n), balance(2, HOT, USDC, 2n), balance(4, HOT, MEME, 7n)]
    const post = [balance(1, HOT, USDC, 0n), balance(2, HOT, USDC, 6n), balance(4, HOT, MEME, 7n)]
    expect(landedChanges(meta(pre, post), HOT, 0)).toEqual([{ token: USDC, delta: '3' }])
  })

  it('reports SOL sold through a wSOL account under the wSOL mint, gross of the fee', () => {
    const sold = {
      ...meta([], [balance(2, HOT, MEME, 4_483_276n)]),
      // The hot wallet wraps 10,000,000, pays the fee and the MEME account's rent; its wSOL account
      // at index 1 opens and closes inside the transaction.
      preBalances: [1_000_000_000, 0, 0],
      postBalances: [1_000_000_000 - 10_000_000 - 5000 - 2_039_280, 0, 2_039_280],
    } as ConfirmedTransactionMeta
    expect(landedChanges(sold, HOT, 0)).toEqual([
      { token: MEME, delta: '4483276' },
      { token: 'So11111111111111111111111111111111111111112', delta: '-10000000' },
    ])
  })

  it('refuses a transaction that failed rather than report it moved nothing', () => {
    expect(() => landedChanges(meta([], [], { InstructionError: [2, 'Custom'] }), HOT, 0)).toThrow(
      /^tx_failed/,
    )
  })
})

/** The owner's first live round trip on mainnet (CR-021), recorded with getTransaction. */
const recorded = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/landed-${name}.json`, import.meta.url), 'utf8')) as {
    meta: ConfirmedTransactionMeta
  }
const OWNER_HOT = 'DRtNJEgHdq7NqzVbdAu1LfqC6NQjPK2EgJku5XUfVoq1'
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'

describe("on the owner's recorded mainnet transactions", () => {
  it('books the buy at what landed, not at the test run', () => {
    expect(landedChanges(recorded('4L22sYCB').meta, OWNER_HOT, 0)).toEqual([
      { token: USDC, delta: '-1000000' },
      { token: JUP, delta: '4483276' },
    ])
  })

  it('books the Close at what landed', () => {
    expect(landedChanges(recorded('3p1cxJ9a').meta, OWNER_HOT, 0)).toEqual([
      { token: JUP, delta: '-4483276' },
      { token: USDC, delta: '1003943' },
    ])
  })

  it('sees a top-up from the vault as USDC in, and nothing else', () => {
    expect(landedChanges(recorded('2UiPs8mr').meta, OWNER_HOT, 0)).toEqual([
      { token: USDC, delta: '1000000' },
    ])
  })
})

describe('getLandedChanges', () => {
  it("reads the confirmed transaction for the adapter's own hot wallet", async () => {
    const c = chain()
    const hot = c.hotWallet.publicKey.toBase58()
    const tx = recorded('4L22sYCB')
    const ours = {
      ...(JSON.parse(JSON.stringify(tx).replaceAll(OWNER_HOT, hot)) as typeof tx),
      // The hot wallet signs, so it is among the static keys; the first of them pays the fee.
      transaction: {
        message: { getAccountKeys: () => ({ staticAccountKeys: [c.hotWallet.publicKey] }) },
      },
    }
    const read = vi.spyOn(c.connection, 'getTransaction').mockResolvedValue(ours as never)
    expect(await c.adapter.getLandedChanges!('sig')).toEqual([
      { token: USDC, delta: '-1000000' },
      { token: JUP, delta: '4483276' },
    ])
    expect(read).toHaveBeenCalledWith('sig', {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
  })

  it('fails on a transaction the chain does not have yet', async () => {
    const c = chain()
    vi.spyOn(c.connection, 'getTransaction').mockResolvedValue(null)
    await expect(c.adapter.getLandedChanges!('sig')).rejects.toThrow('tx_not_found: sig')
  })
})
