import {
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { inspectSwap, JUPITER_PROGRAM_ID } from '../src/svm/swap/inspect.js'

const key = () => Keypair.generate().publicKey
const hotWallet = key()
const tokenIn = key()
const tokenOut = key()
const sides = { hotWallet, tokenIn, tokenOut }
const inAccount = getAssociatedTokenAddressSync(tokenIn, hotWallet)

const route = new TransactionInstruction({
  programId: JUPITER_PROGRAM_ID,
  keys: [{ pubkey: hotWallet, isSigner: true, isWritable: true }],
  data: Buffer.from([1, 2, 3]),
})
const create = (mint = tokenOut, owner = hotWallet) =>
  createAssociatedTokenAccountIdempotentInstruction(
    hotWallet,
    getAssociatedTokenAddressSync(mint, owner, true),
    owner,
    mint,
  )
const budget = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
]

function check(instructions: TransactionInstruction[], payerKey = hotWallet) {
  const expanded = new TransactionMessage({
    payerKey,
    recentBlockhash: key().toBase58(),
    instructions,
  })
  return inspectSwap(expanded.compileToV0Message(), expanded, sides)
}

describe('a swap transaction, read before the test run', () => {
  it("passes Jupiter's shape: compute budget, the hot wallet's own account, one route", () => {
    expect(check([...budget, create(), route])).toEqual([])
  })

  it.each([
    [
      'an Approve on the hot wallet',
      createApproveInstruction(inAccount, key(), hotWallet, 1n),
      'DELEGATE_DETECTED',
    ],
    [
      'a SetAuthority',
      createSetAuthorityInstruction(inAccount, hotWallet, AuthorityType.AccountOwner, key()),
      'AUTHORITY_CHANGE_DETECTED',
    ],
    [
      'a CloseAccount',
      createCloseAccountInstruction(inAccount, key(), hotWallet),
      'ACCOUNT_CLOSE_DETECTED',
    ],
    [
      'an unknown program',
      new TransactionInstruction({ programId: key(), keys: [], data: Buffer.alloc(0) }),
      'UNKNOWN_PROGRAM_DETECTED',
    ],
    [
      'a System transfer',
      SystemProgram.transfer({ fromPubkey: hotWallet, toPubkey: key(), lamports: 1 }),
      'SIM_UNEXPECTED_EFFECT',
    ],
    ['an account created for someone else', create(tokenOut, key()), 'SIM_UNEXPECTED_EFFECT'],
    ['an account for another mint', create(key()), 'SIM_UNEXPECTED_EFFECT'],
    ['a second route', route, 'SIM_UNEXPECTED_EFFECT'],
  ])('refuses %s', (_case, extra, reason) => {
    expect(check([...budget, route, extra])).toContain(reason)
  })

  it('refuses no route at all, and another fee payer', () => {
    expect(check([...budget])).toEqual(['SIM_UNEXPECTED_EFFECT'])
    expect(check([route], key())).toContain('SIM_UNEXPECTED_EFFECT')
  })

  it('refuses a second signer', () => {
    const cosigned = new TransactionInstruction({
      programId: JUPITER_PROGRAM_ID,
      keys: [
        { pubkey: hotWallet, isSigner: true, isWritable: true },
        { pubkey: key(), isSigner: true, isWritable: false },
      ],
      data: Buffer.alloc(0),
    })
    expect(check([cosigned])).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })

  it('bounds the priority fee in lamports, and the compute limit', () => {
    const fee = (units: number, microLamports: number) => [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      route,
    ]
    expect(check(fee(1_000_000, 1_000_000))).toEqual([])
    expect(check(fee(1_000_000, 1_000_001))).toEqual(['SIM_UNEXPECTED_EFFECT'])
    expect(check(fee(1_400_001, 1))).toEqual(['SIM_UNEXPECTED_EFFECT'])
    const heap = ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 })
    expect(check([heap, route])).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })
})
