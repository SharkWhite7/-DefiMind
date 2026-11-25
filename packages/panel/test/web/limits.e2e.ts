import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const trading = {
  enabled: true,
  venues: ['jupiter'],
  tokens: [MINT],
  allowAnyToken: false,
  maxTradeUsd: '50000000',
  dailyTradeMax: '100000000',
  maxPositionUsd: '100000000',
  maxSlippageBps: 100,
  maxPriceImpactBps: 300,
}

async function agentPage(page: Page, origin: string) {
  await page.goto(`${origin}/panel/enrol#code=one-time`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect.poll(() => status(page).textContent()).toContain('Passkey saved')
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor()
  await page.goto(`${origin}/panel/agents/research-bot`)
  await page.getByRole('heading', { name: 'Trading limits' }).waitFor()
}

describe.each([390, 1280])('trading limits at %i px (CR-026)', (width) => {
  it('sets per-token and per-kind limits and orders, with the passkey', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width)
    guard.state.policy['trading'] = trading
    await agentPage(page, guard.origin)
    await page.getByText(MINT, { exact: true }).last().waitFor()
    await page.getByLabel('Most per buy, in dollars').fill('5')
    await page.getByLabel('Sells: one trade, in dollars').fill('10')
    await page.getByLabel('Sells: daily total, in dollars').fill('50')
    await page.getByLabel('Allow take-profit and stop-loss orders').check()
    await page.getByRole('button', { name: 'Save limits' }).click()
    await expect
      .poll(() => status(page).textContent())
      .toBe('Limits saved. Confirmed with your passkey.')
    const put = guard.state.puts.at(-1)
    expect(put?.stepUp?.action).toBe('loosen_policy')
    expect(put?.policy['trading']).toMatchObject({
      maxTradeUsd: '50000000',
      tokenLimits: { [MINT]: { maxBuyUsd: '5000000' } },
      operations: { sell: { maxTradeUsd: '10000000', dailyMax: '50000000' } },
      orders: { enabled: true, maxOpen: 10 },
    })

    await page.getByLabel('Most per buy, in dollars').fill('2')
    await page.getByRole('button', { name: 'Save limits' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Limits saved.')
    expect(guard.state.puts.at(-1)?.stepUp).toBeUndefined()

    await page.getByLabel('Swaps: one trade, in dollars').fill('3')
    await page.getByRole('button', { name: 'Save limits' }).click()
    await expect
      .poll(() => status(page).textContent())
      .toBe('Swaps: write both, per trade and per day, or leave both empty.')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    )
    expect(violations).toEqual([])
    await close()
  })

  it('keeps the limits when the Trading card is saved', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width)
    guard.state.policy['trading'] = {
      ...trading,
      tokenLimits: { [MINT]: { maxBuyUsd: '5000000' } },
    }
    await agentPage(page, guard.origin)
    await page.getByLabel('Slippage up to, in percent').fill('0.5')
    await page.getByRole('button', { name: 'Save trading' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Trading saved.')
    expect(guard.state.puts.at(-1)?.policy['trading']).toMatchObject({
      tokenLimits: { [MINT]: { maxBuyUsd: '5000000' } },
    })
    await close()
  })

  it('keeps the limit of a mint no longer allowed when another is lowered, without a passkey', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width)
    const gone = 'Gone1111111111111111111111111111111111111111'
    guard.state.policy['trading'] = {
      ...trading,
      tokenLimits: { [gone]: { maxBuyUsd: '1000000' }, [MINT]: { maxBuyUsd: '5000000' } },
    }
    await agentPage(page, guard.origin)
    await page.getByText(gone, { exact: true }).waitFor()
    await page.getByText(/^Not in the allowed list\./).waitFor()
    await page.getByLabel('Most per buy, in dollars').first().fill('4')
    await page.getByRole('button', { name: 'Save limits' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Limits saved.')
    const put = guard.state.puts.at(-1)
    expect(put?.stepUp).toBeUndefined()
    expect(put?.policy['trading']).toMatchObject({
      tokenLimits: { [gone]: { maxBuyUsd: '1000000' }, [MINT]: { maxBuyUsd: '4000000' } },
    })
    await close()
  })
})
