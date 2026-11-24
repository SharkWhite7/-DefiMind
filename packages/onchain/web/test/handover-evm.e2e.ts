import { encodeFunctionData, getAddress, type Address } from 'viem'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execByOwner, safeAbi } from '../src/evm/calls.js'
import { LEDGER_FALLBACK } from '../src/evm/handover.js'
import { mockPhantomEvm, stageEvm } from './evm-node.js'
import { heading, lines } from './harness.js'

/** Handing the 1-of-1 Safe over to the owner's Ledger account (ON-34), on the stand-in chain. */
let browser: Browser
let s: Awaited<ReturnType<typeof stageEvm>>
let owner: Address
const ledger = getAddress('0x1ed6e00000000000000000000000000000000001')

beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(() => browser.close())
beforeEach(async () => {
  s = await stageEvm()
  owner = s.state.owners[0]!
})
afterEach(() => s.server.close())

async function open(rejects = 0) {
  const page = await browser.newPage()
  await page.addInitScript(mockPhantomEvm(owner, { live: true, rejects }))
  const link = { cluster: 'evm-localnet', action: 'hand-over', safe: s.state.safe }
  await page.goto(`${s.server.origin}/?${new URLSearchParams(link)}`)
  return page
}
const settled = (page: Page, title: string) =>
  expect.poll(() => heading(page).textContent(), { timeout: 20_000 }).toBe(title)
const next = (page: Page) => page.click('button:has-text("Continue")')

/** The owner switches Phantom to `account`, presses Continue, then switches back and presses again. */
async function choose(page: Page, account: Address) {
  await settled(page, 'Choose the new owner')
  s.state.selected = account
  await next(page)
  await settled(page, 'Back to the current owner')
  s.state.selected = owner
  await next(page)
}

const exec = (from: Address, call: `0x${string}`) => execByOwner(from, s.state.safe, call)

describe('handing the Safe over to a Ledger', () => {
  it('step 1 adds the Ledger as a second owner at threshold 1, from the current owner', async () => {
    const page = await open()
    await choose(page, ledger)
    await settled(page, 'Step 1 of 2 done')
    const add = encodeFunctionData({
      abi: safeAbi,
      functionName: 'addOwnerWithThreshold',
      args: [ledger, 1n],
    })
    expect(s.sent).toEqual([
      { from: owner, to: s.state.safe, data: exec(owner, add), value: '0x0' },
    ])
    expect(s.state.owners).toEqual([ledger, owner])
  })

  it('step 2, from the Ledger, removes the old owner: the Ledger alone owns the Safe', async () => {
    s.state.owners = [ledger, owner]
    s.state.selected = ledger
    const page = await open()
    await settled(page, 'Handed over')
    const remove = encodeFunctionData({
      abi: safeAbi,
      functionName: 'removeOwner',
      args: [ledger, owner, 1n],
    })
    expect(s.sent.map((tx) => tx.data)).toEqual([exec(ledger, remove)])
    expect(s.state.owners).toEqual([ledger])
    expect((await lines(page)).join(' ')).toContain('Final check: open the proof page')
  })

  it('tells the old owner to hand step 2 to the Ledger', async () => {
    s.state.owners = [ledger, owner]
    s.state.selected = owner
    const page = await open()
    await settled(page, 'Nothing to sign')
    expect((await lines(page))[0]).toMatch(/^Step 1 is done\. Switch Phantom to the new owner/)
  })

  it('names the Ledger scripts when Phantom cannot send on this chain', async () => {
    const page = await open(1)
    await choose(page, ledger)
    await settled(page, 'Hand over, step 1 of 2')
    await expect.poll(() => lines(page), { timeout: 20_000 }).toContain(LEDGER_FALLBACK)
    expect(s.sent).toEqual([])
  })
})

describe('accounts that must never own the Safe', () => {
  const refusedFor = async (account: Address) => {
    const page = await open()
    await choose(page, account)
    await settled(page, 'Nothing to sign')
    expect(s.sent).toEqual([])
    return (await lines(page))[0]
  }

  it("refuses this deployment's hot wallet", async () => {
    expect(await refusedFor(s.state.hot)).toMatch(/is one of this deployment's hot wallets/)
  })

  it('refuses a delegate of the Allowance Module', async () => {
    const delegate = getAddress('0x00000000000000000000000000000000000de1e9')
    s.state.otherDelegates = [delegate]
    expect(await refusedFor(delegate)).toMatch(/draws on this Safe as a delegate/)
  })

  it('refuses the same account twice', async () => {
    expect(await refusedFor(owner)).toMatch(/^Phantom gave the same account twice/)
  })
})
