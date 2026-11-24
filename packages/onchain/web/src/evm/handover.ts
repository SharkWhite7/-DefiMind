import { encodeFunctionData, isAddressEqual, parseAbi, type Address, type PublicClient } from 'viem'
import { execByOwner, safeAbi } from './calls.js'
import type { EvmPlan } from './plan.js'

export interface EvmHandOverRequest {
  cluster: string
  safe: Address
  module: Address
  /** The deployment's hot wallets, shared and per agent, from the build: never a new owner. */
  hots: Address[]
}

const delegatesAbi = parseAbi([
  'function getDelegates(address safe, uint48 start, uint8 pageSize) view returns (address[] results, uint48 next)',
])

/** Phantom on chain 4663 with a Ledger account is untested: the owner needs a way that works. */
export const LEDGER_FALLBACK =
  'If Phantom cannot sign with your Ledger on this chain, use the EVM-9 Ledger scripts ' +
  "(OWNER_SIGNER=ledger, packages/onchain README, 'The Safe owner on a Ledger') instead."

const refused = (reason: string): EvmPlan => ({ kind: 'refused', reason })

/**
 * Moves a 1-of-1 Safe from the owner's account to another of the owner's accounts, a Ledger, in the
 * order the Solana hand-over uses. A: the current owner adds the Ledger as a second owner at
 * threshold 1, staying an owner itself, so a wrong address cannot lock the Safe. B: the Ledger,
 * proving it can sign, removes the old owner. The Safe lists the newest owner first, so in B the
 * Ledger is owners[0] and the old owner owners[1]. `newKey` reads the account from the owner's
 * wallet, never from the link.
 */
export async function prepareEvmHandOver(
  client: PublicClient,
  request: EvmHandOverRequest,
  owner: Address,
  newKey: () => Promise<Address>,
): Promise<EvmPlan> {
  const { cluster, safe } = request
  if (!(await client.getCode({ address: safe }))) {
    return refused(`There is no Safe at ${safe} on ${cluster}.`)
  }
  const read = { address: safe, abi: safeAbi } as const
  const [owners, threshold] = await Promise.all([
    client.readContract({ ...read, functionName: 'getOwners' }),
    client.readContract({ ...read, functionName: 'getThreshold' }),
  ])
  const where = `Safe ${safe} on ${cluster}`
  const listed = `owners ${owners.join(', ')}, threshold ${threshold}`
  if (threshold !== 1n || owners.length > 2) {
    return refused(`The ${where} has ${listed}: not a shape this page hands over.`)
  }
  if (owners.length === 1 && isAddressEqual(owners[0]!, owner)) {
    return stepOne(client, request, owner, await newKey(), where)
  }
  if (owners.length === 2 && isAddressEqual(owners[0]!, owner)) {
    return stepTwo(client, safe, owner, owners[1]!, where)
  }
  if (owners.length === 2 && isAddressEqual(owners[1]!, owner)) {
    return refused(
      `Step 1 is done. Switch Phantom to the new owner ${owners[0]}, your Ledger, and open this ` +
        'link again to finish.',
    )
  }
  return refused(
    `The connected account ${owner} is not an owner of the ${where} (${listed}). Connect the ` +
      'owner account and open the link again.',
  )
}

const FINAL_CHECK =
  'Final check: open the proof page for this Safe. It must read Verified, with this account as ' +
  'its only owner.'

const owners = (client: PublicClient, safe: Address) =>
  client.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' })

async function stepOne(
  client: PublicClient,
  request: EvmHandOverRequest,
  owner: Address,
  next: Address,
  where: string,
): Promise<EvmPlan> {
  const problem = await unfit(client, request, owner, next)
  if (problem) return refused(problem)
  const { safe } = request
  const call = encodeFunctionData({
    abi: safeAbi,
    functionName: 'addOwnerWithThreshold',
    args: [next, 1n],
  })
  return {
    kind: 'sign',
    title: 'Hand over, step 1 of 2',
    to: safe,
    data: execByOwner(owner, safe, call),
    after: 'Step 1 of 2 done',
    fallback: LEDGER_FALLBACK,
    summary: [
      `Make ${next}, your Ledger, an owner of the ${where}, at threshold 1.`,
      `${owner} stays an owner until step 2, so a wrong address cannot lock the Safe.`,
      `Contract ${safe}, function execTransaction, calling addOwnerWithThreshold on the Safe.`,
      'Phantom should show no token and no ETH leaving your account, only the network fee.',
    ],
    landed: async () =>
      (await owners(client, safe)).some((o) => isAddressEqual(o, next))
        ? [
            `${next} is now an owner.`,
            'Step 2: switch Phantom to that Ledger account and open this same link again. The ' +
              'Ledger then removes this account, which proves it can sign.',
          ]
        : undefined,
  }
}

function stepTwo(
  client: PublicClient,
  safe: Address,
  owner: Address,
  old: Address,
  where: string,
): EvmPlan {
  const call = encodeFunctionData({
    abi: safeAbi,
    functionName: 'removeOwner',
    args: [owner, old, 1n],
  })
  return {
    kind: 'sign',
    title: 'Hand over, step 2 of 2',
    to: safe,
    data: execByOwner(owner, safe, call),
    after: 'Handed over',
    fallback: LEDGER_FALLBACK,
    summary: [
      `Remove ${old} from the owners of the ${where}.`,
      `Afterwards ${owner} alone owns it: the kill, the allowance and the funds.`,
      `Contract ${safe}, function execTransaction, calling removeOwner on the Safe.`,
    ],
    landed: async () => {
      const now = await owners(client, safe)
      return now.length === 1 && isAddressEqual(now[0]!, owner)
        ? [`${old} is no longer an owner.`, FINAL_CHECK]
        : undefined
    },
  }
}

/** Why `next` must not own the Safe: the same account, a contract, or one that draws on it. */
async function unfit(
  client: PublicClient,
  { safe, module, hots }: EvmHandOverRequest,
  owner: Address,
  next: Address,
): Promise<string | undefined> {
  if (isAddressEqual(next, owner)) {
    return 'Phantom gave the same account twice. Switch to your Ledger account when asked.'
  }
  if (hots.some((hot) => isAddressEqual(hot, next))) {
    return `${next} is one of this deployment's hot wallets. A hot wallet must never own the Safe.`
  }
  if (await client.getCode({ address: next })) {
    return `${next} is a contract, not a Ledger account.`
  }
  const [delegates] = await client.readContract({
    address: module,
    abi: delegatesAbi,
    functionName: 'getDelegates',
    args: [safe, 0, 50],
  })
  if (delegates.some((d) => isAddressEqual(d, next))) {
    return `${next} draws on this Safe as a delegate of the Allowance Module. It must never own it.`
  }
  return undefined
}
