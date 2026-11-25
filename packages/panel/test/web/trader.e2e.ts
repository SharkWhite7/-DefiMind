import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRADER_TEMPLATES } from '@defimind/shared'
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

const open = (width: number, trader = true) =>
  openDevice(browser, dist, width, false, true, false, trader)

async function traderTab(page: Page, origin: string) {
  await page.goto(`${origin}/panel/enrol#code=one-time`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect.poll(() => status(page).textContent()).toContain('Passkey saved')
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor()
  await page.getByRole('link', { name: 'AI Trader' }).click()
  await page.getByRole('heading', { name: 'AI Trader · research-bot' }).waitFor()
}

describe.each([390, 1280])('the AI trader at %i px (CR-027)', (width) => {
  it('shows its state, its shadow results and its decisions in its own words', async () => {
    const { guard, page, violations, close } = await open(width)
    await traderTab(page, guard.origin)
    await page.getByText('Shadow: nothing was traded.').waitFor()
    await page.getByText('7 of 96').waitFor()
    await page.getByText('89,600 of 2,000,000').waitFor()
    await page.getByText('Trades it would have made').waitFor()
    expect(await page.getByText('Realized profit or loss').count()).toBe(0)
    await page.getByText(`1,843.920113 JUP (mint ${MINT})`).first().waitFor()
    await page.getByText(/JUP fell 6% below the middle of its range/).waitFor()
    expect(await page.getByText('The trader says:').count()).toBe(2)
    await page.getByText('swap: shadowed').waitFor()
    await page.getByText('swap: rejected, refused: TRADE_EXCEEDED').waitFor()
    await page.getByText(/Not financial advice\./).waitFor()
    // Three checks, fewer than a page: nothing older to show.
    expect(await page.getByRole('button', { name: 'Show older' }).isVisible()).toBe(false)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    )
    expect(violations).toEqual([])
    await close()
  })

  it('pauses with the session and resumes with the passkey', async () => {
    const { guard, page, close } = await open(width)
    await traderTab(page, guard.origin)
    await page.getByRole('button', { name: 'Pause trader' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Trader paused.')
    await page.getByText('Paused by you').waitFor()
    await page.getByRole('button', { name: 'Resume with passkey' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Trader resumed.')
    expect(guard.trader!.state.paused).toBe(1)
    expect(guard.trader!.state.resumed).toEqual([
      { action: 'resume_trader', body: { agentId: 'research-bot' } },
    ])
    await close()
  })

  it('starts from a ready-made strategy, saved with the passkey', async () => {
    const { guard, page, close } = await open(width)
    await traderTab(page, guard.origin)
    const template = TRADER_TEMPLATES.find((t) => t.id === 'accumulate-dips')!
    await page.getByLabel('Strategy').selectOption('accumulate-dips')
    await page.getByText(/Ready-made, not tested/).waitFor()
    expect(await page.getByLabel('Instructions, in plain words').inputValue()).toBe(
      template.instructions,
    )
    expect(await page.getByLabel('How often it checks').inputValue()).toBe('60')
    await page.getByRole('button', { name: 'Save trader' }).click()
    await expect
      .poll(() => status(page).textContent())
      .toBe('Trader saved. Confirmed with your passkey.')
    const put = guard.trader!.state.puts[0]!
    expect(put.config).toMatchObject({
      template: { id: 'accumulate-dips', version: template.version },
      cadenceMinutes: 60,
      maxActionsPerTick: 2,
      maxTicksPerDay: 24,
      tokens: [MINT],
    })
    expect(put.bound).toEqual({
      action: 'trader_settings',
      body: { agentId: 'research-bot', config: put.config },
    })

    await page.getByLabel('Turn the trader on').uncheck()
    await page.getByRole('button', { name: 'Save trader' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Trader saved.')
    expect(guard.trader!.state.puts[1]!.bound).toBeUndefined()
    await close()
  })

  it('turns off without the passkey, keeping its stored tokens and template version', async () => {
    const { guard, page, close } = await open(width)
    const OTHER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
    // The owner removed MINT from the policy since; the trader still lists it first.
    guard.state.policy['trading'] = {
      enabled: true,
      venues: ['jupiter'],
      tokens: [OTHER],
      allowAnyToken: false,
      maxTradeUsd: '5000000',
      dailyTradeMax: '20000000',
      maxPositionUsd: '20000000',
      maxSlippageBps: 100,
      maxPriceImpactBps: 300,
    }
    guard.trader!.state.config = {
      ...guard.trader!.state.config,
      tokens: [MINT, OTHER],
      template: { id: 'accumulate-dips', version: 0 },
      maxTicksPerDay: 10,
    }
    await traderTab(page, guard.origin)
    await page.getByLabel('Turn the trader on').uncheck()
    await page.getByRole('button', { name: 'Save trader' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Trader saved.')
    const put = guard.trader!.state.puts[0]!
    expect(put.bound).toBeUndefined()
    expect(put.config).toMatchObject({
      enabled: false,
      tokens: [MINT, OTHER],
      template: { id: 'accumulate-dips', version: 0 },
      maxTicksPerDay: 10,
    })

    // A slower pace is still a change, so the passkey; the custom cap on checks stays.
    await page.getByLabel('How often it checks').selectOption('60')
    await page.getByRole('button', { name: 'Save trader' }).click()
    await expect
      .poll(() => status(page).textContent())
      .toBe('Trader saved. Confirmed with your passkey.')
    expect(guard.trader!.state.puts[1]!.config).toMatchObject({ maxTicksPerDay: 10 })
    await close()
  })

  it('keeps a template id that is no longer listed', async () => {
    const { guard, page, close } = await open(width)
    guard.trader!.state.config = {
      ...guard.trader!.state.config,
      template: { id: 'retired-one', version: 3 },
    }
    await traderTab(page, guard.origin)
    expect(await page.getByLabel('Strategy').inputValue()).toBe('retired-one')
    await page.getByLabel('Turn the trader on').uncheck()
    await page.getByRole('button', { name: 'Save trader' }).click()
    await expect.poll(() => status(page).textContent()).toBe('Trader saved.')
    expect(guard.trader!.state.puts[0]!.config).toMatchObject({
      template: { id: 'retired-one', version: 3 },
    })
    await close()
  })

  it('applies suggested limits with orders on, beside the current ones', async () => {
    const { guard, page, close } = await open(width)
    await traderTab(page, guard.origin)
    const template = TRADER_TEMPLATES.find((t) => t.suggested.orders)!
    await page.getByLabel('Strategy').selectOption(template.id)
    await page.getByText(/^Now: /).waitFor()
    await page.getByText(/^Suggested: .*orders on\.$/).waitFor()
    await page.getByRole('button', { name: 'Apply suggested limits' }).click()
    await expect.poll(() => status(page).textContent()).toMatch(/^Limits applied/)
    const put = guard.state.puts.at(-1)!
    expect(put.policy['trading']).toMatchObject({
      maxTradeUsd: template.suggested.maxTradeUsd,
      orders: { enabled: true },
    })
    expect(put.stepUp?.action).toBe('loosen_policy')
    await close()
  })

  it('shows realized profit or loss once live, and the missing key', async () => {
    const { guard, page, close } = await open(width)
    guard.trader!.state.shadow = false
    guard.trader!.state.keySet = false
    await traderTab(page, guard.origin)
    await page.getByText('-$1.25', { exact: true }).waitFor()
    await page.getByText(/The Anthropic API key is not set/).waitFor()
    expect(await page.getByText('Shadow: nothing was traded.').count()).toBe(0)
    await close()
  })

  it('says it is not available where guard-core has no trader', async () => {
    const { guard, page, close } = await open(width, false)
    await traderTab(page, guard.origin)
    await page.getByText('The AI trader is not available on this DefiMind yet.').waitFor()
    expect(await status(page).textContent()).toBe('')
    await close()
  })
})
