import { CHAINS, getAddress } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { chainName } from '../src/domain/chains.js'
import { fromForm, toForm } from '../src/domain/form.js'
import { amountText, dollarsInput, formatUsd, parseDollars } from '../src/domain/money.js'
import { notification } from '../src/domain/notify.js'
import { hostname, loosens, type Rules } from '../src/domain/policy.js'
import { href, parseRoute, type Route } from '../src/domain/route.js'

describe('money', () => {
  it('formats atomic dollars with bigint, cents always', () => {
    expect(formatUsd('0')).toBe('$0.00')
    expect(formatUsd('1500000')).toBe('$1.50')
    expect(formatUsd('1234567890123')).toBe('$1,234,567.890123')
    expect(formatUsd('123456789012345678901234567890')).toBe(
      '$123,456,789,012,345,678,901,234.56789',
    )
  })

  it('refuses anything that is not an atomic amount', () => {
    for (const bad of ['', '-1', '1.5', '01', 'abc']) {
      expect(() => formatUsd(bad)).toThrow()
    }
  })

  it('parses dollars to atomic units', () => {
    expect(parseDollars('12.5')).toBe('12500000')
    expect(parseDollars(' $0.000001 ')).toBe('1')
    expect(parseDollars('7')).toBe('7000000')
    for (const bad of ['', '-1', '1.1234567', '1,000', '1e6', '$', '.5']) {
      expect(parseDollars(bad)).toBeUndefined()
    }
  })

  it('round-trips through the dollar input', () => {
    expect(dollarsInput('1234500000')).toBe('1234.50')
    expect(parseDollars(dollarsInput('1234567891'))).toBe('1234567891')
  })

  it('shows dollars for the chain dollar only', () => {
    const usdc = getAddress(CHAINS.baseSepolia, 'usd')!
    expect(amountText({ chain: CHAINS.baseSepolia, token: usdc, amount: '2500000' })).toBe(
      '$2.50 USDC',
    )
    expect(amountText({ chain: CHAINS.baseSepolia, token: '0xdead', amount: '2500000' })).toBe(
      "2500000 base units of 0xdead (not this chain's dollar)",
    )
  })

  it('names known chains and shows unknown ones by id', () => {
    expect(chainName(CHAINS.solanaMainnet)).toBe('Solana')
    expect(chainName('eip155:1')).toBe('eip155:1')
  })
})

describe('routes', () => {
  const id = '6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab'
  const routes: Route[] = [
    { name: 'overview' },
    { name: 'login' },
    { name: 'enrol', code: 'a b&c' },
    { name: 'approval', id },
    { name: 'mandate', id },
    { name: 'agents' },
    { name: 'agent', id: 'bot/1' },
    { name: 'report' },
    { name: 'doctor' },
    { name: 'passkeys' },
    { name: 'settings' },
    { name: 'kill' },
  ]

  it('parses every href back to its route', () => {
    for (const route of routes) {
      const [path = '', hash = ''] = href(route).split('#')
      expect(parseRoute(path, hash && `#${hash}`)).toEqual(route)
    }
  })

  it('takes /panel without the slash as the overview', () => {
    expect(parseRoute('/panel')).toEqual({ name: 'overview' })
  })

  it('refuses what it does not know', () => {
    for (const path of [
      '/',
      '/panelx',
      '/panel/nope',
      '/panel/approvals/1',
      '/panel/a/b/c',
      '/panel/enrol',
      '/panel/agents/%E0',
    ]) {
      expect(parseRoute(path)).toEqual({ name: 'missing' })
    }
    expect(href({ name: 'missing' })).toBe('/panel/')
  })
})

describe('policy', () => {
  const before: Rules = {
    perTxMax: '1000000',
    dailyMax: '5000000',
    approvalThreshold: '2000000',
    chains: ['solana:a'],
    tokens: ['t'],
    allowedRecipients: ['r'],
    allowedDomains: ['api.example.com'],
    mode: 'shadow',
    requireMandate: true,
  }

  it('finds every loosening SPEC lists', () => {
    expect(loosens(before, { ...before, dailyMax: '5000001' })).toBe(true)
    expect(loosens(before, { ...before, tokens: ['t', 'u'] })).toBe(true)
    expect(loosens(before, { ...before, allowedDomains: ['b.example.com'] })).toBe(true)
    expect(loosens(before, { ...before, mode: 'live' })).toBe(true)
    expect(loosens(before, { ...before, requireMandate: false })).toBe(true)
  })

  it('also counts what guard-core counts: unpausing, a wider breaker or price margin', () => {
    expect(loosens({ ...before, paused: true }, { ...before, paused: false })).toBe(true)
    expect(loosens(before, { ...before, maxPaymentsPerMinute: 11 })).toBe(true)
    expect(loosens(before, { ...before, priceIncreaseMaxPct: 101 })).toBe(true)
    expect(loosens({ ...before, maxPaymentsPerMinute: 20 }, before)).toBe(false)
    expect(loosens(before, { ...before, maxPaymentsPerMinute: 10, priceIncreaseMaxPct: 50 })).toBe(
      false,
    )
    expect(loosens({ ...before, paused: false }, { ...before, paused: true })).toBe(false)
  })

  it('lets a tightening through without a passkey', () => {
    expect(loosens(before, before)).toBe(false)
    expect(loosens(before, { ...before, perTxMax: '1', allowedRecipients: [] })).toBe(false)
    expect(loosens({ ...before, mode: undefined }, { ...before, mode: 'shadow' })).toBe(false)
    expect(loosens({ ...before, mode: undefined }, { ...before, mode: 'live' })).toBe(false)
  })

  it('accepts hostnames only', () => {
    expect(hostname(' API.Example.com ')).toBe('api.example.com')
    for (const bad of ['localhost', 'https://a.com', 'a..com', '-a.com', 'a.com/x', 'a b.com']) {
      expect(hostname(bad)).toBeUndefined()
    }
  })

  it('turns the form into a policy and back', () => {
    const form = toForm(before)
    expect(form.perTxMax).toBe('1.00')
    expect(fromForm(before, form)).toEqual(before)
    const edited = fromForm(before, {
      ...form,
      dailyMax: '$10',
      allowedDomains: 'API.example.com\n\nb.example.com, b.example.com',
      allowedRecipients: ' r  s ',
      requireMandate: false,
    })
    expect(edited).toEqual({
      ...before,
      dailyMax: '10000000',
      allowedDomains: ['api.example.com', 'b.example.com'],
      allowedRecipients: ['r', 's'],
      requireMandate: false,
    })
  })

  it('says what is wrong with the form', () => {
    const form = toForm(before)
    expect(fromForm(before, { ...form, approvalThreshold: 'ten' })).toMatch(/^Ask me from/)
    expect(fromForm(before, { ...form, allowedDomains: 'https://x.com' })).toMatch(/not a hostname/)
    expect(fromForm(before, { ...form, allowedRecipients: 'x'.repeat(129) })).toMatch(/too long/)
  })
})

describe('notification', () => {
  const intentId = '6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab'

  it('opens the approval it is about', () => {
    expect(
      notification({ kind: 'approval', agentId: 'bot', chain: CHAINS.solanaMainnet, intentId }),
    ).toEqual({
      title: 'A payment waits for you',
      body: 'bot on Solana. Open the panel to see it.',
      tag: intentId,
      path: `/panel/approvals/${intentId}`,
    })
  })

  it('still shows something for a payload it does not know', () => {
    expect(notification(undefined)).toEqual({
      title: 'DefiMind',
      body: 'Open the panel to see it.',
      tag: 'defimind',
      path: '/panel/',
    })
    expect(notification({ kind: 'approval', intentId: '../../x' }).path).toBe('/panel/')
    expect(notification({ kind: 'toString' }).title).toBe('DefiMind')
  })
})
