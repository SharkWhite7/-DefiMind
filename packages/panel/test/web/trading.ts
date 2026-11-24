import { randomUUID } from 'node:crypto'
import { CHAINS, getAddress } from '@defimind/shared'

type Send = (status: number, data: unknown) => void
type Bound = { action: string; body: unknown } | undefined

export const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const HOT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

/**
 * CR-021's owner side as SPEC v0.16 words it: one buy waiting with both flags, what the agent
 * holds, and the close that sells it all, behind its own step-up.
 */
export function tradingMock(later: string) {
  const chain = CHAINS.solanaDevnet
  const usd = getAddress(chain, 'usd')!
  const intentId = randomUUID()
  const state = {
    positions: [
      { chain, token: MINT, amount: '1843920113', cost: '25000000' },
      { chain, token: BONK, amount: '912000000000', cost: '10000000' },
    ],
    closes: [] as Bound[],
  }

  const intent = (token: string, amount: string, tokenOut: string, extra = {}) => ({
    id: randomUUID(),
    agentId: 'research-bot',
    kind: 'swap',
    chain,
    token,
    amount,
    recipient: HOT,
    reason: 'Momentum entry, 25 USDC',
    status: 'pending_approval',
    swap: {
      venue: 'jupiter',
      tokenOut,
      minAmountOut: '1843920113',
      slippageBps: 50,
      priceImpactBps: 12,
      quotedAt: later,
    },
    expiresAt: later,
    ...extra,
  })

  const pending = () => ({
    intent: intent(usd, '25000000', MINT, { id: intentId }),
    simulation: { summary: 'Spends 25 USDC; receives at least 1843920113 base units.' },
    approveBefore: later,
    flags: ['NEW_TOKEN', 'MINT_AUTHORITY'],
  })

  function route(method: string, path: string, send: Send, stepUp: () => Bound): boolean {
    if (method === 'GET' && path === '/v1/owner/portfolio') {
      send(200, {
        agents: [
          {
            agentId: 'research-bot',
            positions: state.positions,
            tradedToday: '35000000',
            dailyTradeMax: '100000000',
          },
        ],
      })
      return true
    }
    if (method === 'POST' && path === '/v1/owner/positions/close') {
      const bound = stepUp()
      if (bound?.action !== 'close_positions') {
        send(403, { error: 'step_up_required' })
        return true
      }
      state.closes.push(bound)
      const sells = state.positions.map((p) =>
        intent(p.token, p.amount, usd, { status: 'approved', reason: 'Owner closed positions' }),
      )
      state.positions = []
      send(200, { intents: sells })
      return true
    }
    return false
  }

  return { state, intentId, pending, route }
}
