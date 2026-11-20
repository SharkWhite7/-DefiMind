import { USDC_DECIMALS } from '@defimind/shared'
import { AccountLayout, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  TransactionMessage,
  type Connection,
  type PublicKey,
  type TransactionInstruction,
  type VersionedMessage,
} from '@solana/web3.js'
import * as multisig from '@sqds/multisig'
import { formatUnits } from '../../src/svm/transfer.js'

const g = multisig.generated
const TRANSFER_CHECKED = 12
const CREATE_IDEMPOTENT = 1
export const REJECT = ': reject this transaction.'
const UNKNOWN = (program: PublicKey) =>
  `An instruction for ${program.toBase58()} this page cannot read${REJECT}`

/** Whether any decoded line is one the page cannot vouch for: then it asks Phantom nothing. */
export const cannotRead = (lines: string[]) => lines.some((line) => line.endsWith(REJECT))

export const NOT_ASKED = [
  'This transaction carries something this page cannot read, so it does not ask Phantom to sign ' +
    'it. Do not sign it anywhere else either.',
]

const units = (amount: bigint, decimals = USDC_DECIMALS) =>
  `${formatUnits(amount, decimals)} (${amount} base units at ${decimals} decimals)`
const keys = (list: PublicKey[]) => list.map((key) => key.toBase58()).join(', ') || '(none)'
const is = (data: Buffer, discriminator: number[]) =>
  data.subarray(0, 8).equals(Buffer.from(discriminator))

/**
 * What the transaction Phantom is about to sign does, read from its bytes alone and not from the link
 * or whoever served the page: who gains a right or receives tokens, and how much. The one thing read
 * from the chain is who owns a token account a transfer pays into, since its bytes name only the
 * account. Anything it cannot read is named as such, for the owner to reject.
 */
export async function decodeSolana(
  connection: Connection,
  message: VersionedMessage,
): Promise<string[]> {
  const { instructions } = TransactionMessage.decompile(message)
  const created = new Map(
    instructions
      .filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
      .map((ix) => [ix.keys[1]!.pubkey.toBase58(), ix.keys[2]!.pubkey] as const),
  )
  const lines = []
  for (const ix of instructions) lines.push(await line(connection, ix, created))
  return lines
}

async function line(
  connection: Connection,
  ix: TransactionInstruction,
  created: Map<string, PublicKey>,
): Promise<string> {
  const { programId, data } = ix
  const account = (i: number) => ix.keys[i]!.pubkey
  if (programId.equals(multisig.PROGRAM_ID)) return squads(ix)
  if (programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && data[0] === CREATE_IDEMPOTENT) {
    return `Create the token account of ${account(2).toBase58()} for token ${account(3).toBase58()}.`
  }
  if (programId.equals(TOKEN_PROGRAM_ID) && data[0] === TRANSFER_CHECKED && data.length === 10) {
    const destination = account(2)
    const owner = created.get(destination.toBase58()) ?? (await ownerOf(connection, destination))
    return (
      `Send ${units(data.readBigUInt64LE(1), data[9])} of token ${account(1).toBase58()} to ` +
      `${owner ? `the token account of ${owner.toBase58()}` : `token account ${destination.toBase58()}`}.`
    )
  }
  return UNKNOWN(programId)
}

function squads(ix: TransactionInstruction): string {
  const { data } = ix
  if (is(data, g.multisigAddSpendingLimitInstructionDiscriminator)) {
    const { args } = g.multisigAddSpendingLimitStruct.deserialize(data)[0]
    return (
      `Let ${keys(args.members)} draw ${units(BigInt(args.amount.toString()))} of token ` +
      `${args.mint.toBase58()} from vault ${args.vaultIndex} every ${g.Period[args.period]}, ` +
      `into ${keys(args.destinations)}.`
    )
  }
  if (is(data, g.multisigRemoveSpendingLimitInstructionDiscriminator)) {
    return `Remove spending limit ${ix.keys[2]!.pubkey.toBase58()}.`
  }
  if (is(data, g.multisigCreateV2InstructionDiscriminator)) {
    const { args } = g.multisigCreateV2Struct.deserialize(data)[0]
    return (
      `Create a multisig run by ${args.configAuthority?.toBase58() ?? 'its members'}, members ` +
      `${keys(args.members.map((m) => m.key))}, threshold ${args.threshold}.`
    )
  }
  return UNKNOWN(ix.programId)
}

async function ownerOf(connection: Connection, account: PublicKey) {
  const info = await connection.getAccountInfo(account)
  return info?.owner.equals(TOKEN_PROGRAM_ID) ? AccountLayout.decode(info.data).owner : undefined
}
