import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAINS } from '@defimind/shared'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPanel } from '../../build.js'
import { openDevice, status } from './device.js'
import { MINT } from './trading.js'

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

const chain = CHAINS.solanaDevnet
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const trading = (orders: boolean) => ({
  enabled: true,
  venues: ['jupiter'],
  tokens: [MINT, BONK],
  allowAnyToken: false,
  maxTradeUsd: '50000000',
  dailyTradeMax: '100000000',
  maxPositionUsd: '100000000',
  maxSlippageBps: 100,
  maxPriceImpactBps: 300,
  orders: { enabled: orders, maxOpen: 10 },
})

async function signIn(page: Page, origin: string) {
  await page.goto(`${origin}/panel/enrol#code=one-time`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect.poll(() => status(page).textContent()).toContain('Passkey saved')
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor()
}

const fits = async (page: Page, width: number) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)

describe.each([390, 1280])('swaps and orders at %i px (CR-026)', (width) => {
  it('swaps a token the agent holds for another, both mints in full', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width, false, true)
    guard.state.policy['chains'] = [chain]
    guard.state.policy['trading'] = trading(true)
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/agents/research-bot/trade`)
    await page.getByLabel('Trade', { exact: true }).selectOption('swap')
    expect(await page.getByLabel('Token (mint address)').isVisible()).toBe(false)
    await page.getByLabel('From, a token it holds').selectOption(BONK)
    await page.getByLabel('To, a token it may buy').selectOption(MINT)
    await page.getByLabel("Amount, in the token's units").fill('100')
    await page.getByRole('button', { name: 'Get quote' }).click()
    await page.getByRole('heading', { name: 'Confirm' }).waitFor()
    expect(guard.trading!.state.quotes[0]).toEqual({
      agentId: 'research-bot',
      chain,
      tokenIn: BONK,
      tokenOut: MINT,
      amountIn: '100000000',
    })
    await page.getByText(`100 tokens (mint ${BONK})`).waitFor()
    await page.getByText(`1,843.920113 tokens (mint ${MINT})`).waitFor()
    await fits(page, width)
    await page.getByRole('button', { name: 'Trade with passkey' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Trade executed.')
    expect(guard.trading!.state.trades[0]?.bound?.action).toBe('manual_trade')
    expect(violations).toEqual([])
    await close()
  })

  it('asks for no passkey when the quote is for another trade', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width, false, true)
    guard.state.policy['chains'] = [chain]
    guard.state.policy['trading'] = trading(true)
    guard.trading!.state.skew = true
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/agents/research-bot/trade`)
    await page.getByLabel('Spend, in dollars').fill('25')
    await page.getByRole('button', { name: 'Get quote' }).click()
    await expect
      .poll(() => status(page).textContent())
      .toBe('The quote does not match this trade. Nothing was sent.')
    expect(await page.getByRole('heading', { name: 'Confirm' }).count()).toBe(0)
    await close()
  })

  it('refuses a swap into the same token before asking for a quote', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width, false, true)
    guard.state.policy['chains'] = [chain]
    guard.state.policy['trading'] = trading(true)
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/agents/research-bot/trade`)
    await page.getByLabel('Trade', { exact: true }).selectOption('swap')
    await page.getByLabel('From, a token it holds').selectOption(MINT)
    await page.getByLabel('To, a token it may buy').selectOption(MINT)
    await page.getByLabel("Amount, in the token's units").fill('1')
    await page.getByRole('button', { name: 'Get quote' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Choose two different tokens.')
    expect(guard.trading!.state.quotes).toEqual([])
    await close()
  })

  it('places a stop loss with the passkey, over exactly what was typed, then cancels it', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width, false, true)
    guard.state.policy['chains'] = [chain]
    guard.state.policy['trading'] = trading(true)
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/portfolio`)
    await page.getByRole('link', { name: 'Take profit and stop loss' }).click()
    await page.getByRole('heading', { name: 'Orders for research-bot' }).waitFor()
    await page.getByLabel('Kind').selectOption('stop_loss')
    await page.getByLabel("Amount to sell, in the token's units").fill('1000')
    await page.getByLabel('Sell when the whole amount is worth, in dollars').fill('20')
    await page.getByRole('button', { name: 'Review order' }).click()
    await page.getByRole('heading', { name: 'Confirm: Stop loss' }).waitFor()
    await page.getByText(`1,000 JUP (mint ${MINT})`).waitFor()
    await page.getByText('$19.80').waitFor()
    await fits(page, width)
    await page.getByRole('button', { name: 'Place order with passkey' }).click()
    await expect
      .poll(() => status(page).textContent())
      .toBe('Order placed. Confirmed with your passkey.')
    expect(guard.trading!.state.placed[0]).toEqual({
      action: 'place_order',
      body: {
        agentId: 'research-bot',
        chain,
        token: MINT,
        kind: 'stop_loss',
        amount: '1000000000',
        triggerOut: '20000000',
        maxSlippageBps: 100,
      },
    })
    await page.getByText('Stop loss: Open').waitFor()
    await page.getByRole('button', { name: 'Cancel order' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Order cancelled.')
    await page.getByRole('heading', { name: 'Past orders' }).waitFor()
    await page.getByText('Stop loss: Cancelled').waitFor()
    expect(violations).toEqual([])
    await close()
  })

  it("says why guard-core refused an order, and signs the owner's own slippage", async () => {
    const { guard, page, close } = await openDevice(browser, dist, width, false, true)
    guard.state.policy['chains'] = [chain]
    guard.state.policy['trading'] = trading(true)
    guard.trading!.state.refuse = ['INSUFFICIENT_POSITION']
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/agents/research-bot/orders`)
    await page.getByLabel("Amount to sell, in the token's units").fill('5000')
    await page.getByLabel('Sell when the whole amount is worth, in dollars').fill('90')
    await page.getByLabel(/^Slippage, in percent/).fill('0.5')
    await page.getByRole('button', { name: 'Review order' }).click()
    await page.getByText('up to 0.50%').waitFor()
    await page.getByRole('button', { name: 'Place order with passkey' }).click()
    await expect
      .poll(() => status(page).textContent())
      .toBe('Order refused. Its open orders on this token would sell more than it holds.')
    await close()
  })

  it('points to the trading limits while orders are off', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width, false, true)
    guard.state.policy['chains'] = [chain]
    guard.state.policy['trading'] = trading(false)
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/agents/research-bot/orders`)
    await page.getByText(/Orders are off for this agent/).waitFor()
    expect(await page.getByRole('button', { name: 'Review order' }).count()).toBe(0)
    await close()
  })

  it('says orders are not available where guard-core has no orders route', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width)
    guard.state.policy['trading'] = trading(true)
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/agents/research-bot/orders`)
    await page.getByText('Orders are not available on this DefiMind yet.').waitFor()
    expect(await status(page).textContent()).toBe('')
    expect(violations).toEqual([])
    await close()
  })
})
