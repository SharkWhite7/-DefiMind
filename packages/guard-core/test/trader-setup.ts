import type { TraderConfig } from '@defimind/shared'
import { type Mock, vi } from 'vitest'
import { saveTrader } from '../src/db/traders.js'
import { DEFAULT_TRADER } from '../src/domain/trader.js'
import type { PaymentDeps } from '../src/service/payments.js'
import { serial } from '../src/service/serial.js'
import { runTick } from '../src/service/trader.js'
import { fakeClaude, type Turn } from './claude-fake.js'
import { CHAIN, harness, MINT as USDC, NOW } from './harness.js'
import { BONK, trading, Venue } from './venue.js'

/** An agent with trading on, and an AI trader in shadow mode over BONK, on a scripted Claude. */
export async function setup(script: Turn[] = [], over: Partial<TraderConfig> = {}) {
  const chain = new Venue()
  const h = await harness({ chain, policy: { trading } })
  const config = {
    ...DEFAULT_TRADER,
    enabled: true,
    tokens: [BONK],
    instructions: 'Buy dips.',
    ...over,
  }
  saveTrader(h.db, 'agent-1', config, NOW)
  const traderPaused: Mock<(agentId: string) => void> = vi.fn()
  const deps = {
    db: h.db,
    chains: new Map([[CHAIN, chain]]),
    usdc: new Map([[CHAIN, USDC]]),
    bot: h.bot,
    now: () => h.clock.now,
    serial: serial(),
    log: { warn: () => {}, error: () => {} },
    push: { traderPaused, intent: () => {}, order: () => {} },
  } as unknown as PaymentDeps
  const fake = fakeClaude(script)
  const t = { deps, claude: fake.claude, search: async () => [] }
  return { h, t, fake, traderPaused, tick: () => runTick(t, 'agent-1') }
}

export const buy = (amount = '2000000') => ({
  name: 'swap',
  input: { from: 'USDC', to: BONK, amount, reason: 'a dip' },
})
