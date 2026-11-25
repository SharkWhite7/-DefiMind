import { CHAINS } from '@defimind/shared'
import { MINT } from './trading.js'

type Send = (status: number, data: unknown) => void
type Bound = { action: string; body: unknown } | undefined

/**
 * CR-027's owner routes as SPEC v0.21 words them, for one agent: a trader set up in shadow, a few
 * checks to show, and every save, pause and resume kept for the tests.
 */
export function traderMock(later: string) {
  const config = {
    enabled: true,
    mode: 'shadow',
    model: 'claude-opus-5-5',
    effort: 'medium',
    cadenceMinutes: 15,
    tokens: [MINT],
    instructions: 'Buy small after a clear dip. Hold otherwise.',
    maxActionsPerTick: 3,
    maxTicksPerDay: 96,
    maxTokensPerTick: 200000,
    maxTokensPerDay: 2000000,
  }
  const state = {
    config: config as Record<string, unknown>,
    state: 'running' as 'off' | 'running' | 'paused',
    keySet: true,
    shadow: true,
    puts: [] as { config: unknown; bound: Bound }[],
    resumed: [] as Bound[],
    paused: 0,
  }
  const tick = (i: number, outcome: string, reason: string, actions: unknown[] = []) => ({
    id: `tick-${i}`,
    agentId: 'research-bot',
    startedAt: new Date(Date.parse(later) - i * 900_000).toISOString(),
    model: 'claude-opus-5-5',
    outcome,
    actions,
    reason,
    usage: { input: 12000, output: 800, cacheRead: 10000, cacheWrite: 0 },
  })
  const ticks = [
    tick(
      1,
      'acted',
      'JUP fell 6% below the middle of its range; a small buy within the per-buy limit.',
      [{ tool: 'swap', intentId: 'i-1', status: 'shadowed', rejectReasons: [] }],
    ),
    tick(2, 'held', 'Nothing has fallen clearly. Holding.'),
    tick(3, 'refused', '', [
      { tool: 'swap', status: 'rejected', rejectReasons: ['TRADE_EXCEEDED'] },
    ]),
  ]
  const status = () => ({
    config: state.config,
    state: state.state,
    ...(state.state === 'paused' ? { pausedBy: 'owner' } : {}),
    keySet: state.keySet,
    today: { ticks: 7, tokens: 89600 },
    report: {
      trades: 2,
      ...(state.shadow ? {} : { realizedPnlUsd: '-1250000' }),
      positions: [
        {
          chain: CHAINS.solanaDevnet,
          token: MINT,
          amount: '1843920113',
          cost: '25000000',
          decimals: 6,
          symbol: 'JUP',
        },
      ],
      shadow: state.shadow,
    },
  })

  function route(
    method: string,
    path: string,
    body: Record<string, unknown>,
    send: Send,
    stepUp: () => Bound,
  ): boolean {
    const match = /^\/v1\/owner\/trader\/([^/]+)(\/pause|\/resume|\/ticks)?$/.exec(path)
    if (match === null) {
      return false
    }
    const tail = match[2]
    if (tail === '/ticks') {
      send(200, { ticks })
    } else if (tail === '/pause') {
      state.state = 'paused'
      state.paused += 1
      send(200, status())
    } else if (tail === '/resume') {
      const bound = stepUp()
      if (bound?.action !== 'resume_trader') {
        send(403, { error: 'step_up_required' })
        return true
      }
      state.resumed.push(bound)
      state.state = 'running'
      send(200, status())
    } else if (method === 'PUT') {
      const bound = stepUp()
      state.puts.push({ config: body['config'], bound })
      state.config = body['config'] as Record<string, unknown>
      send(200, status())
    } else {
      send(200, status())
    }
    return true
  }

  return { state, route }
}
