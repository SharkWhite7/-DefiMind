import { PublicKey, type Connection } from '@solana/web3.js'
import * as multisig from '@sqds/multisig'
import { VAULT_INDEX } from '../../src/svm/squads.js'
import { decode, program, refused, type Plan } from './plan.js'
import { spendingLimits } from './proof.js'

export interface HandOverRequest {
  cluster: string
  multisig: PublicKey
  /** The deployment's hot wallets, shared and per agent, from the build: never a new owner. */
  hotWallets: PublicKey[]
}

const { Permissions } = multisig.types

/**
 * Moves a controlled multisig from the owner's key to another of the owner's keys, a Ledger, in two
 * steps ordered so a wrong key cannot lock the vault. A: the current authority adds the new key as a
 * member and makes it the config authority, staying a member itself, so it can still move the funds
 * by proposal if the new key is not what it seemed. B: the new key, proving it can sign, removes the
 * old one. Moving the authority alone would not do: a member at threshold 1 can empty the vault.
 * `newKey` reads the key from the owner's wallet, never from the link.
 */
export async function prepareHandOver(
  connection: Connection,
  request: HandOverRequest,
  owner: PublicKey,
  newKey: () => Promise<PublicKey>,
): Promise<Plan> {
  const ms = decode(await connection.getAccountInfo(request.multisig), multisig.accounts.Multisig)
  const where = `multisig ${request.multisig.toBase58()} on ${request.cluster}`
  if (!ms) return refused(`There is no Squads multisig at ${request.multisig.toBase58()}.`)
  const authority = ms.configAuthority
  if (authority.equals(PublicKey.default)) {
    return refused(`The ${where} has no config authority: it changes only by proposal.`)
  }
  const members = ms.members.map((m) => m.key)
  const others = members.filter((key) => !key.equals(authority))
  if (!owner.equals(authority)) {
    const stepOneDone = members.some((key) => key.equals(owner)) && members.length === 2
    return refused(
      stepOneDone
        ? `Step 1 is done. Switch Phantom to the new owner ${authority.toBase58()}, your Ledger, ` +
            'and open this link again to finish.'
        : `The connected wallet ${owner.toBase58()} is not the config authority of the ${where} ` +
            `(${authority.toBase58()}). Connect the owner wallet and open the link again.`,
    )
  }
  // Before and after a hand-over the chain looks the same: one member, the authority. Either way
  // the connected key may hand over to another.
  if (members.length === 1 && others.length === 0) {
    return stepOne(connection, request, owner, newKey, where)
  }
  if (members.length === 2 && others.length === 1) {
    return stepTwo(connection, request, owner, others[0]!, where)
  }
  return refused(
    `The ${where} has members ${members.map((key) => key.toBase58()).join(', ')}: not a shape ` +
      'this page hands over. Use the Squads app.',
  )
}

const FINAL_CHECK =
  'Final check: open the proof page for this multisig. It must read Verified, with this key as ' +
  'the config authority and the only member.'

async function stepOne(
  connection: Connection,
  request: HandOverRequest,
  owner: PublicKey,
  newKey: () => Promise<PublicKey>,
  where: string,
): Promise<Plan> {
  const next = await newKey()
  const problem = await unfit(connection, request, owner, next)
  if (problem) return refused(problem)
  const multisigPda = request.multisig
  return {
    kind: 'sign',
    title: 'Hand over, step 1 of 2',
    hash: true,
    instructions: [
      multisig.instructions.multisigAddMember({
        multisigPda,
        configAuthority: owner,
        rentPayer: owner,
        newMember: { key: next, permissions: Permissions.all() },
      }),
      multisig.instructions.multisigSetConfigAuthority({
        multisigPda,
        configAuthority: owner,
        newConfigAuthority: next,
      }),
    ],
    coSigners: [],
    after: 'Step 1 of 2 done',
    summary: [
      `Make ${next.toBase58()}, your Ledger, a member and the config authority of the ${where}.`,
      `${owner.toBase58()} stays a member until step 2, so a wrong key cannot lock the vault.`,
      program(
        'multisigAddMember and multisigSetConfigAuthority',
        `the config authority ${owner.toBase58()}`,
      ),
      'Phantom should show no token leaving your wallet, only a little SOL for the larger account.',
    ],
    landed: async () => {
      const ms = decode(await connection.getAccountInfo(multisigPda), multisig.accounts.Multisig)
      return ms?.configAuthority.equals(next)
        ? [
            `${next.toBase58()} is now the config authority.`,
            'Step 2: switch Phantom to that Ledger account and open this same link again. The ' +
              'Ledger then removes this key, which proves it can sign.',
          ]
        : undefined
    },
  }
}

function stepTwo(
  connection: Connection,
  request: HandOverRequest,
  owner: PublicKey,
  old: PublicKey,
  where: string,
): Plan {
  const multisigPda = request.multisig
  return {
    kind: 'sign',
    title: 'Hand over, step 2 of 2',
    hash: true,
    instructions: [
      multisig.instructions.multisigRemoveMember({
        multisigPda,
        configAuthority: owner,
        oldMember: old,
      }),
    ],
    coSigners: [],
    after: 'Handed over',
    summary: [
      `Remove ${old.toBase58()} from the ${where}.`,
      `Afterwards ${owner.toBase58()} alone runs it: the kill, limits and the vault.`,
      program('multisigRemoveMember', `the config authority ${owner.toBase58()}`),
    ],
    landed: async () => {
      const ms = decode(await connection.getAccountInfo(multisigPda), multisig.accounts.Multisig)
      return ms && ms.members.length === 1 && ms.members[0]!.key.equals(owner)
        ? [`${old.toBase58()} is no longer a member.`, FINAL_CHECK]
        : undefined
    },
  }
}

/** Why `next` must not run the vault: the same key, a program address, or one that draws on it. */
async function unfit(
  connection: Connection,
  request: HandOverRequest,
  owner: PublicKey,
  next: PublicKey,
): Promise<string | undefined> {
  const text = next.toBase58()
  if (next.equals(owner)) {
    return 'Phantom gave the same account twice. Switch to your Ledger account when asked.'
  }
  if (!PublicKey.isOnCurve(next.toBytes())) {
    return `${text} is a program address, not a wallet: it cannot sign.`
  }
  if (request.hotWallets.some((key) => key.equals(next))) {
    return `${text} is one of this deployment's hot wallets. A hot wallet must never run the vault.`
  }
  const [vault] = multisig.getVaultPda({ multisigPda: request.multisig, index: VAULT_INDEX })
  const limits = await spendingLimits(connection, request.multisig)
  const draws = limits.some(({ limit }) =>
    [...limit.members, ...limit.destinations].some((key) => key.equals(next)),
  )
  if (draws || next.equals(vault)) {
    return `${text} draws on this vault through a spending limit. It must never run the vault.`
  }
  return undefined
}
