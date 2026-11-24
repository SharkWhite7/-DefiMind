import { Keypair, LAMPORTS_PER_SOL, type PublicKey } from '@solana/web3.js'
import * as multisig from '@sqds/multisig'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { keypairOwner } from '../../src/svm/owner.js'
import { addDailySpendingLimit, createMultisig, spendingLimitPda } from '../../src/svm/squads.js'
import { USDC } from '../../test/fixture.js'
import { heading, lines, sentInstructions, shape, stage } from './harness.js'

/** Handing a controlled multisig over to the owner's Ledger (ON-34), against the real Squads program. */
let browser: Browser
let s: Awaited<ReturnType<typeof stage>>
let multisigPda: PublicKey
let ledger: Keypair

beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(() => browser.close())
beforeEach(async () => {
  s = await stage()
  multisigPda = (await createMultisig(s.c.connection, keypairOwner(s.owner))).multisigPda
  ledger = Keypair.generate()
  s.c.svm.airdrop(ledger.publicKey, BigInt(LAMPORTS_PER_SOL))
})
afterEach(() => s.server.close())

const link = { action: 'hand-over', multisig: '' }
const open = (options?: { rejects?: boolean }) =>
  s.open(browser, { ...link, multisig: multisigPda.toBase58() }, options)
const settled = (page: Page, title: string) =>
  expect.poll(() => heading(page).textContent(), { timeout: 20_000 }).toBe(title)
const state = () =>
  multisig.accounts.Multisig.fromAccountInfo(s.c.svm.getAccount(multisigPda) as never)[0]

/** The owner switches Phantom to `next`, presses Continue, then switches back and presses again. */
async function choose(page: Page, next: Keypair) {
  await settled(page, 'Choose the new owner')
  s.wallet.connected = next
  await page.click('button:has-text("Continue")')
  await settled(page, 'Back to the current owner')
  expect((await lines(page))[0]).toBe(
    `New owner: ${next.publicKey.toBase58()}. Check it is the address your Ledger shows.`,
  )
  s.wallet.connected = s.owner
  await page.click('button:has-text("Continue")')
}

describe('handing the multisig over to a Ledger', () => {
  it('step 1 adds the Ledger as member and config authority, keeping the old key a member', async () => {
    const page = await open()
    await choose(page, ledger)
    await settled(page, 'Step 1 of 2 done')
    const owner = s.owner.publicKey
    expect(sentInstructions(s.server.signed[0]!)).toEqual([
      shape(
        multisig.instructions.multisigAddMember({
          multisigPda,
          configAuthority: owner,
          rentPayer: owner,
          newMember: { key: ledger.publicKey, permissions: multisig.types.Permissions.all() },
        }),
      ),
      shape(
        multisig.instructions.multisigSetConfigAuthority({
          multisigPda,
          configAuthority: owner,
          newConfigAuthority: ledger.publicKey,
        }),
      ),
    ])
    const ms = state()
    expect(ms.configAuthority.equals(ledger.publicKey)).toBe(true)
    expect(ms.members.map((m) => m.key.toBase58()).sort()).toEqual(
      [owner.toBase58(), ledger.publicKey.toBase58()].sort(),
    )
  })

  it('step 2, signed by the Ledger, removes the old key: the Ledger alone runs the vault', async () => {
    await choose(await open(), ledger)
    await expect.poll(() => s.server.signed.length, { timeout: 20_000 }).toBe(1)
    s.wallet.connected = ledger
    const page = await open()
    await settled(page, 'Handed over')
    const ms = state()
    expect(ms.members.map((m) => m.key.toBase58())).toEqual([ledger.publicKey.toBase58()])
    expect(ms.configAuthority.equals(ledger.publicKey)).toBe(true)
    expect((await lines(page)).join(' ')).toContain('Final check: open the proof page')
  })

  it('tells the old key to hand step 2 to the Ledger', async () => {
    await choose(await open(), ledger)
    await expect.poll(() => s.server.signed.length, { timeout: 20_000 }).toBe(1)
    const page = await open()
    await settled(page, 'Nothing to sign')
    expect((await lines(page))[0]).toMatch(/^Step 1 is done\. Switch Phantom to the new owner/)
  })

  it('shows the Message Hash the Ledger will display before Phantom signs', async () => {
    const page = await open({ rejects: true })
    await choose(page, ledger)
    await expect
      .poll(async () => (await lines(page)).join('\n'), { timeout: 20_000 })
      .toMatch(/Message Hash, it must read exactly: [1-9A-HJ-NP-Za-km-z]{32,44}\./)
    expect(s.server.signed).toEqual([])
  })
})

describe('keys that must never run the vault', () => {
  const refusedFor = async (next: Keypair) => {
    const page = await open()
    await choose(page, next)
    await settled(page, 'Nothing to sign')
    expect(s.server.signed).toEqual([])
    return (await lines(page))[0]
  }

  it("refuses this deployment's hot wallet", async () => {
    expect(await refusedFor(s.c.hotWallet)).toMatch(/is one of this deployment's hot wallets/)
  })

  it('refuses a key that draws on the vault through a spending limit', async () => {
    const drawer = Keypair.generate()
    await addDailySpendingLimit(s.c.connection, keypairOwner(s.owner), {
      multisigPda,
      createKey: drawer.publicKey,
      mint: s.c.mint,
      amount: 10n * USDC,
      members: [drawer.publicKey],
      destinations: [drawer.publicKey],
    })
    s.scanned.push(spendingLimitPda(multisigPda, drawer.publicKey))
    expect(await refusedFor(drawer)).toMatch(/draws on this vault through a spending limit/)
  })

  it('refuses the same account twice, when the owner did not switch', async () => {
    expect(await refusedFor(s.owner)).toMatch(/^Phantom gave the same account twice/)
  })

  it('refuses a wallet that is not the config authority', async () => {
    s.wallet.connected = Keypair.generate()
    const page = await open()
    await settled(page, 'Nothing to sign')
    expect((await lines(page))[0]).toMatch(/is not the config authority/)
  })
})
