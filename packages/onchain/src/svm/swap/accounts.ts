import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token'
import { PublicKey, type AccountInfo, type SimulatedTransactionAccountInfo } from '@solana/web3.js'
import type { Holding } from './effects.js'

export const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]

/** A token account, read with its own program; anything else is not a holding. */
export function holding(address: PublicKey, info: AccountInfo<Buffer> | null): Holding | null {
  if (!info || !TOKEN_PROGRAMS.some((program) => info.owner.equals(program))) return null
  try {
    const account = unpackAccount(address, info, info.owner)
    return {
      mint: account.mint.toBase58(),
      owner: account.owner.toBase58(),
      amount: account.amount,
      lamports: BigInt(info.lamports),
      delegate: account.delegate?.toBase58() ?? null,
      closeAuthority: account.closeAuthority?.toBase58() ?? null,
      frozen: account.isFrozen,
    }
  } catch {
    return null
  }
}

/** An account as the simulation returned it, in the shape getMultipleAccountsInfo gives. */
export function fromSimulation(
  account: SimulatedTransactionAccountInfo | null | undefined,
): AccountInfo<Buffer> | null {
  if (!account) return null
  return {
    data: Buffer.from(account.data[0] ?? '', 'base64'),
    owner: new PublicKey(account.owner),
    lamports: account.lamports,
    executable: account.executable,
  }
}
