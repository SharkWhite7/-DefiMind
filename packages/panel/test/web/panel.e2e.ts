import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPanel } from '../../build.js'
import { guardCore } from './guard.js'

let browser: Browser
let dist: string

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'defimind-panel-'))
  await buildPanel(dist)
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser.close()
})

/** A page with a platform passkey that always verifies the owner, and every CSP violation kept. */
async function device(width: number) {
  const guard = await guardCore(dist)
  const context = await browser.newContext({ viewport: { width, height: 844 } })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  const violations: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/.test(message.text())) {
      violations.push(message.text())
    }
  })
  return { guard, page, violations, close: () => Promise.all([context.close(), guard.close()]) }
}

const status = (page: Page) => page.locator('#status')

async function signIn(page: Page, origin: string) {
  await page.goto(`${origin}/panel/enrol#code=one-time`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect.poll(() => status(page).textContent()).toContain('Passkey saved')
  expect(new URL(page.url()).hash).toBe('')
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor()
}

describe.each([390, 1280])('the panel at %i px', (width) => {
  it('enrols, signs in and approves a payment with a step-up passkey', async () => {
    const { guard, page, violations, close } = await device(width)
    await page.goto(`${guard.origin}/panel/`)
    await page.getByRole('button', { name: 'Sign in with passkey' }).waitFor()
    await signIn(page, guard.origin)

    await page.getByText('Waiting for you (2)').waitFor()
    await page.getByText('$2.50 USDC').click()
    await page.getByRole('heading', { name: '$2.50 USDC' }).waitFor()
    await expect
      .poll(() => page.locator('.flag').textContent())
      .toBe('first payment to this domain')
    await page.getByRole('button', { name: 'Approve with passkey' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Approved.')

    expect(guard.state.decisions).toEqual([
      {
        kind: 'intent',
        id: guard.intentId,
        decision: 'approve',
        stepUp: { action: 'approve_intent', body: { intentId: guard.intentId } },
      },
    ])
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scroll).toBeLessThanOrEqual(width)
    expect(violations).toEqual([])
    await close()
  })

  it('rejects a task budget without a passkey', async () => {
    const { guard, page, close } = await device(width)
    await signIn(page, guard.origin)
    await page.getByText('Task budget $3.00').click()
    await page.getByRole('button', { name: 'Reject' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Rejected.')
    expect(guard.state.decisions).toEqual([
      { kind: 'mandate', id: guard.mandateId, decision: 'reject' },
    ])
    expect([...guard.state.challenges.values()].filter(Boolean)).toEqual([])
    await close()
  })

  it('asks for the passkey to loosen the policy and not to tighten it', async () => {
    const { guard, page, close } = await device(width)
    await signIn(page, guard.origin)
    await page.locator('#app').getByRole('link', { name: 'research-bot', exact: true }).click()
    await page.getByLabel('Per day, in dollars').waitFor()
    expect(await page.getByLabel('Per day, in dollars').inputValue()).toBe('5.00')

    await page.getByLabel('Per day, in dollars').fill('20')
    await page.getByRole('button', { name: 'Save policy' }).click()
    await expect
      .poll(() => status(page).textContent())
      .toBe('Policy saved. Confirmed with your passkey.')
    const loose = guard.state.puts[0]
    expect(loose?.policy['dailyMax']).toBe('20000000')
    expect(loose?.stepUp).toEqual({
      action: 'loosen_policy',
      body: { agentId: 'research-bot', policy: loose?.policy },
    })

    await page.getByLabel('Per payment, in dollars').fill('0.50')
    await page.getByRole('button', { name: 'Save policy' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Policy saved.')
    expect(guard.state.puts[1]).toEqual({ policy: { ...loose?.policy, perTxMax: '500000' } })

    await page.getByLabel('Per payment, in dollars').fill('a lot')
    await page.getByRole('button', { name: 'Save policy' }).click()
    await expect.poll(() => status(page).textContent()).toMatch(/^Per payment: write an amount/)
    expect(guard.state.puts).toHaveLength(2)
    await close()
  })

  it('stops everything and shows each chain to finish in the wallet', async () => {
    const { guard, page, violations, close } = await device(width)
    await signIn(page, guard.origin)
    await page.locator('#app').getByRole('link', { name: 'Stop everything' }).click()
    await page.getByRole('button', { name: 'Stop everything' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Stopped. 1 agent paused.')
    expect(guard.state.killed).toBe(true)
    expect(await page.getByRole('link', { name: 'Open in Phantom' }).getAttribute('href')).toBe(
      'https://phantom.app/ul/browse/x',
    )
    await page.getByText('Could not build the kill transaction.').waitFor()
    expect(violations).toEqual([])
    await close()
  })
})

it('sends a signed-out owner to the passkey and back to the link they opened', async () => {
  const { guard, page, close } = await device(390)
  await page.goto(`${guard.origin}/panel/enrol#code=one-time`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await page.getByRole('button', { name: 'Sign in with passkey' }).waitFor()
  await page.goto(`${guard.origin}/panel/approvals/${guard.intentId}`)
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.getByRole('button', { name: 'Approve with passkey' }).waitFor()
  expect(new URL(page.url()).pathname).toBe(`/panel/approvals/${guard.intentId}`)
  await close()
})

it('adds a second passkey only with the first one vouching for it', async () => {
  const { guard, page, close } = await device(390)
  await signIn(page, guard.origin)
  await page.goto(`${guard.origin}/panel/enrol#code=second`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect.poll(() => status(page).textContent()).toContain('Passkey saved')
  expect(guard.state.passkeys).toBe(2)
  await close()
})
