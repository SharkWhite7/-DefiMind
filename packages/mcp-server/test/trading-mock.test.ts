import { afterEach, describe, expect, it } from 'vitest'
import { startMockGuard, type MockGuard } from '../examples/mock-guard/server.js'
import { httpGuard } from '../src/adapters/guard.js'
import { call, connect } from './support.js'

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
let mock: MockGuard | undefined

afterEach(async () => {
  await mock?.close()
})

describe('trading tools against a fake guard-core over HTTP', () => {
  it('quotes, buys, shows the position, sells, and is refused an untradable token', async () => {
    mock = await startMockGuard({ agentId: 'agent-1', token: 'tok', tradable: [BONK] })
    const client = await connect(httpGuard({ baseUrl: mock.url, agentId: 'agent-1', token: 'tok' }))

    const quoted = await call(client, 'quote', { from: 'USDC', to: BONK, amountUsd: '2' })
    expect(quoted.text).toContain(`Expected: 100 of ${BONK} (100000000 smallest units)`)
    expect(quoted.text).toContain('- NEW_TOKEN: the first buy of this token')

    const bought = await call(client, 'swap', {
      from: 'USDC',
      to: BONK,
      amountUsd: '2',
      reason: 'demo',
    })
    expect(bought.text).toContain(`Buy ${BONK} with $2.00 USDC on Solana devnet`)
    expect(bought.text).toContain(': executed.')

    const held = await call(client, 'get_portfolio')
    expect(held.text).toContain('Traded today: $2.00 of $20.00')
    expect(held.text).toContain(
      `- 100 of ${BONK} (100000000 smallest units) on Solana devnet, cost $2.00 USDC`,
    )

    const sold = await call(client, 'swap', {
      from: BONK,
      to: 'USDC',
      amount: '50000000',
      reason: 'demo',
    })
    expect(sold.text).toContain(': executed.')

    const refused = await call(client, 'swap', {
      from: 'USDC',
      to: 'So11111111111111111111111111111111111111112',
      amountUsd: '1',
      reason: 'demo',
    })
    expect(refused.text).toContain(
      '- TOKEN_NOT_TRADABLE: the policy does not allow trading this token',
    )
    expect(refused.text).toContain('Tell the user the owner has to allow it.')
  })
})

describe('degen trading against a fake guard-core over HTTP (CR-026)', () => {
  const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'

  it('swaps one held token for another, places and cancels a stop-loss, and refuses one over the position', async () => {
    mock = await startMockGuard({ agentId: 'agent-1', token: 'tok', tradable: [BONK, JUP] })
    const client = await connect(httpGuard({ baseUrl: mock.url, agentId: 'agent-1', token: 'tok' }))
    await call(client, 'swap', { from: 'USDC', to: BONK, amountUsd: '2', reason: 'demo' })

    const rotated = await call(client, 'swap', {
      from: BONK,
      to: JUP,
      amount: '40000000',
      reason: 'demo',
    })
    expect(rotated.text).toContain(`Swap 40000000 units of ${BONK} for ${JUP}`)
    expect(rotated.text).toContain(': executed.')
    const held = await call(client, 'get_portfolio')
    expect(held.text).toContain(
      `- 40 of ${JUP} (40000000 smallest units) on Solana devnet, cost $0.80 USDC`,
    )

    const placed = await call(client, 'place_order', {
      token: JUP,
      kind: 'stop_loss',
      amount: '40000000',
      triggerUsd: '0.5',
    })
    expect(placed.text).toMatch(/^Stop-loss [0-9a-f-]{36}: open\./)
    const id = /Stop-loss ([0-9a-f-]{36})/.exec(placed.text)?.[1] ?? ''
    expect((await call(client, 'list_orders')).text).toContain(`Stop-loss ${id}: open.`)
    expect((await call(client, 'cancel_order', { orderId: id })).text).toContain(': cancelled.')

    const tooMuch = await call(client, 'place_order', {
      token: JUP,
      kind: 'take_profit',
      amount: '99000000',
      triggerUsd: '5',
    })
    expect(tooMuch.text).toContain('DefiMind refused this order')
    expect(tooMuch.text).toContain('- INSUFFICIENT_POSITION:')
  })
})
