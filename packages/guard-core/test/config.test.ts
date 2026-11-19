import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = {
  ADMIN_TOKEN: 'a'.repeat(64),
  BOT_TOKEN: 'b'.repeat(64),
  BOT_URL: 'http://bot.local',
  BOT_WEBHOOK_SECRET: 'c'.repeat(64),
}

const withOrigin =
  (origin: string, rpId = 'guard.example') =>
  () =>
    loadConfig({ ...base, PASSKEY_RP_ID: rpId, PASSKEY_ORIGIN: origin })

describe('the passkey origin', () => {
  it.each(['https://guard.example', 'https://pay.guard.example', 'https://guard.example:8443'])(
    'accepts %s for guard.example',
    (origin) => {
      expect(withOrigin(origin)).not.toThrow()
    },
  )

  it.each([
    'https://guard.example/',
    'https://guard.example/owner',
    'https://evilguard.example',
    'https://guard.example.evil',
    'https://example',
  ])('refuses %s for guard.example', (origin) => {
    expect(withOrigin(origin)).toThrow()
  })
})

describe('anchoring', () => {
  const anchor = {
    ANCHOR_CHAIN: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    ANCHOR_RPC_URL: 'https://api.devnet.solana.com',
    ANCHOR_KEY_FILE: '/run/defimind/anchor.json',
  }

  it('takes the three settings with a receipt key', () => {
    expect(() =>
      loadConfig({ ...base, ...anchor, RECEIPT_SIGNING_KEY_FILE: '/run/defimind/receipt.pem' }),
    ).not.toThrow()
  })

  it('refuses part of them, or anchoring without a receipt key', () => {
    expect(() => loadConfig({ ...base, ANCHOR_CHAIN: anchor.ANCHOR_CHAIN })).toThrow()
    expect(() => loadConfig({ ...base, ...anchor })).toThrow()
  })

  it('refuses a chain that is not a Solana cluster', () => {
    expect(() =>
      loadConfig({
        ...base,
        ...anchor,
        ANCHOR_CHAIN: 'eip155:8453',
        RECEIPT_SIGNING_KEY_FILE: '/run/defimind/receipt.pem',
      }),
    ).toThrow()
  })
})
