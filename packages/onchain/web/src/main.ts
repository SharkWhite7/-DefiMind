import './shim.js'
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { getAddress } from 'viem'
import { z } from 'zod'
import { config, configured } from './config.js'
import { prepareCreate } from './create.js'
import { decodeSolana, cannotRead, NOT_ASKED } from './decoded.js'
import { prepareDeposit } from './deposit.js'
import { evmMain } from './evm/main.js'
import { prepareKill } from './kill.js'
import { prepareLimit } from './limit.js'
import { askCap, askDeposit, cap, deposit, EXPIRED, expired, issued, problems } from './link.js'
import { isPublicKey, type Plan } from './plan.js'
import { proveSolana, unreadable } from './proof.js'
import { button, decoded, link, show, waitFor } from './view.js'
import { openInPhantom, phantom, type Wallet } from './wallet.js'

const { rpc: RPC_URLS, usdc: USDC_MINTS, hot: HOT_WALLETS } = config
const built = configured

const key = z
  .string()
  .refine(isPublicKey, 'not a Solana address')
  .transform((value) => new PublicKey(value))
// Own names only: `in` would also accept inherited ones such as toString.
const cluster = z.string().refine((name) => Object.hasOwn(RPC_URLS, name), 'unknown cluster')
const solanaLink = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('kill'),
    cluster,
    multisig: key,
    // Optional, and only ever checked against the hot wallet the page was built for.
    hot: key.optional(),
    issued,
  }),
  z.object({ action: z.literal('create'), cluster }),
  z.object({ action: z.literal('deposit'), cluster, multisig: key, amount: deposit }),
  z.object({ action: z.literal('proof'), cluster, multisig: key }),
  z.object({
    action: z.literal('add-limit'),
    cluster,
    multisig: key,
    // Optional, and only ever checked against the hot wallet the page was built for.
    hot: key.optional(),
    amount: cap,
  }),
])

const refuse = (reason: string) => Promise.resolve<Plan>({ kind: 'refused', reason })

/**
 * The hot wallet the page was built for. A link may name one, but only to be refused when it names
 * another: a kill that looked up the wrong one would find no limit and report it gone.
 */
function builtHot(cluster: string, named: PublicKey | undefined): PublicKey | string {
  const hot = built(HOT_WALLETS, cluster)
  if (!hot) {
    return `This page knows no hot wallet for ${cluster}.`
  }
  if (named && !named.equals(new PublicKey(hot))) {
    return (
      `The link names ${named.toBase58()} as the hot wallet, but this page only acts for ${hot}. ` +
      'Do not sign anything from this link.'
    )
  }
  return new PublicKey(hot)
}

type SolanaLink = z.infer<typeof solanaLink>

async function prepare(
  connection: Connection,
  owner: PublicKey,
  request: Exclude<SolanaLink, { action: 'proof' }>,
) {
  if (request.action === 'create') {
    return prepareCreate(connection, request.cluster, owner)
  }
  if (request.action === 'kill' && expired(request.issued)) {
    return refuse(EXPIRED)
  }
  const usdc = built(USDC_MINTS, request.cluster)
  if (request.action === 'deposit') {
    if (!usdc) return refuse(`This page knows no USDC for ${request.cluster}.`)
    return prepareDeposit(connection, { ...request, usdc: new PublicKey(usdc) }, owner, () =>
      askDeposit('USDC', request.amount),
    )
  }
  const hotWallet = builtHot(request.cluster, request.hot)
  if (typeof hotWallet === 'string') {
    return refuse(hotWallet)
  }
  if (request.action === 'kill') {
    return prepareKill(connection, { ...request, hotWallet }, owner)
  }
  if (!usdc) {
    return refuse(`This page knows no USDC for ${request.cluster}.`)
  }
  const amount = request.amount ?? (await askCap('USDC'))
  return prepareLimit(
    connection,
    { ...request, amount, hotWallet, usdc: new PublicKey(usdc) },
    owner,
  )
}

async function main() {
  const query = Object.fromEntries(new URLSearchParams(location.search))
  const evm = built(config.evm, query['cluster'] ?? '')
  if (evm) {
    const { hot, ...chain } = evm
    await evmMain(query, {
      ...chain,
      module: getAddress(chain.module),
      usd: getAddress(chain.usd),
      ...(hot ? { hot: getAddress(hot) } : {}),
      name: query['cluster']!,
      rpc: RPC_URLS[query['cluster']!]!,
    })
    return
  }
  const parsed = solanaLink.safeParse(query)
  if (!parsed.success) {
    show('This link is not valid', [problems(parsed.error)], 'stop')
    return
  }
  const connection = new Connection(RPC_URLS[parsed.data.cluster]!, 'confirmed')
  if (parsed.data.action === 'proof') {
    await prove(connection, parsed.data)
    return
  }
  const wallet = phantom()
  if (!wallet) {
    show('Open this page in Phantom', ['No Phantom wallet was found in this browser.'], 'stop')
    link('Open in Phantom', openInPhantom(location.href))
    return
  }
  const owner = new PublicKey((await wallet.connect()).publicKey.toString())
  show('Checking the chain…', [])
  await run(connection, wallet, owner, await prepare(connection, owner, parsed.data))
}

/** Read-only: anyone can open it, with no wallet, and nothing on the way asks for a signature. */
async function prove(connection: Connection, request: Extract<SolanaLink, { action: 'proof' }>) {
  const hot = built(HOT_WALLETS, request.cluster)
  const usdc = built(USDC_MINTS, request.cluster)
  if (!hot || !usdc) {
    show('Not verified', [`This page knows no hot wallet or USDC for ${request.cluster}.`], 'stop')
    return
  }
  show('Reading the chain…', [])
  const proof = await proveSolana(connection, {
    ...request,
    hotWallet: new PublicKey(hot),
    usdc: new PublicKey(usdc),
  }).catch(unreadable)
  show(proof.title, proof.lines, proof.verified ? 'done' : 'stop')
}

async function run(connection: Connection, wallet: Wallet, owner: PublicKey, plan: Plan) {
  if (plan.kind === 'refused') {
    show('Nothing to sign', [plan.reason], 'stop')
    return
  }
  if (plan.kind === 'done') {
    show(plan.title, plan.summary, 'done')
    return
  }
  show(plan.title, plan.summary)
  const { blockhash } = await connection.getLatestBlockhash()
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions: plan.instructions,
    }).compileToV0Message(),
  )
  if (plan.coSigners.length > 0) {
    tx.sign(plan.coSigners)
  }
  const what = await decodeSolana(connection, tx.message)
  if (cannotRead(what)) {
    show('Nothing to sign', NOT_ASKED, 'stop')
    decoded(what)
    return
  }
  decoded(what)
  try {
    await wallet.signAndSendTransaction(tx)
  } catch (error) {
    show(plan.title, [...plan.summary, `Not signed: ${String(error)}`], 'stop')
    decoded(what)
    button('Ask Phantom again', () => void run(connection, wallet, owner, plan))
    return
  }
  show('Waiting for the chain…', plan.summary)
  await waitFor(plan)
}

main().catch((error: unknown) => show('Something went wrong', [String(error)], 'stop'))
