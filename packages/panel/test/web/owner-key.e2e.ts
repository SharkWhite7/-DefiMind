import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPanel } from '../../build.js'
import { openDevice, status } from './device.js'

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

const RISK =
  'One wallet controls every vault you make here. Whoever has its recovery phrase can empty each vault, past every daily limit.'

async function signIn(page: Page, origin: string) {
  await page.goto(`${origin}/panel/enrol#code=one-time`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect.poll(() => status(page).textContent()).toContain('Passkey saved')
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor()
}

describe.each([390, 1280])('the owner key at %i px (CR-022)', (width) => {
  it('is named a single point of failure where the vault is created', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width, true)
    await signIn(page, guard.origin)
    await page.goto(`${guard.origin}/panel/start/vault`)
    await page.getByText(RISK).waitFor()
    await page
      .getByText(/a vault that needs 2 of 3 signatures, one of them on a hardware key/)
      .waitFor()
    expect(violations).toEqual([])
    await close()
  })

  it('is explained in settings, the slower kill of a 2-of-3 included', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width, true)
    await signIn(page, guard.origin)
    await page.getByRole('link', { name: 'Settings' }).click()
    await page.getByRole('heading', { name: 'Who controls your vaults' }).waitFor()
    await page.getByText(RISK).waitFor()
    await page.getByText(/slower to stop in an emergency/).waitFor()
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scroll).toBeLessThanOrEqual(width)
    expect(violations).toEqual([])
    await close()
  })
})
