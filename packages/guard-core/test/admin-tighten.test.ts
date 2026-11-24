import { describe, expect, it } from 'vitest'
import { ADMIN_TOKEN, basePolicy, CHAIN, harness, MERCHANT, MINT, type Harness } from './harness.js'
import { enrolPasskey } from './owner.js'

const THIEF = 'Thief111111111111111111111111111111111111111'

const put = (h: Harness, policy: object) =>
  h.app.inject({
    method: 'PUT',
    url: '/v1/admin/policy/agent-1',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    payload: policy,
  })

const steal = (h: Harness) =>
  h.agent('POST', '/v1/agent/transfer', {
    agentId: 'agent-1',
    chain: CHAIN,
    token: MINT,
    amount: '50000000',
    recipient: THIEF,
    reason: 'totally legitimate',
  })

/** The owner has a passkey: from then on the admin token only tightens. */
async function owned(options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options)
  await enrolPasskey(h)
  return h
}

describe('the admin token only tightens once a passkey exists (CR-022)', () => {
  it("refuses the reviewer's attack: raised limits and a new recipient, and nothing is paid", async () => {
    const h = await owned()
    const res = await put(h, {
      ...basePolicy,
      perTxMax: '50000000',
      dailyMax: '50000000',
      approvalThreshold: '50000000',
      allowedRecipients: [MERCHANT, THIEF],
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'loosen_in_panel' })
    expect(h.auditEvents()).toContain('admin_loosen_refused')
    const paid = await steal(h)
    expect(paid.json()).toMatchObject({ status: 'rejected' })
    expect(paid.json().rejectReasons).toContain('RECIPIENT_NOT_ALLOWED')
    expect(h.chain.sent).toEqual([])
  })

  it.each([
    ['going live', { mode: 'live' }],
    ['unpausing', { paused: false }],
    ['dropping the mandate requirement', { requireMandate: false }],
    [
      'turning trading on',
      {
        trading: {
          enabled: true,
          venues: ['jupiter'],
          tokens: [],
          allowAnyToken: true,
          maxTradeUsd: '1',
          dailyTradeMax: '1',
          maxPositionUsd: '1',
        },
      },
    ],
  ])('refuses %s', async (_case, change) => {
    const h = await owned({ policy: { mode: 'shadow', paused: true, requireMandate: true } })
    const res = await put(h, {
      ...basePolicy,
      mode: 'shadow',
      paused: true,
      requireMandate: true,
      ...change,
    })
    expect(res.statusCode).toBe(403)
  })

  it('still tightens: a lower limit, a recipient removed, back to shadow', async () => {
    const h = await owned()
    const res = await put(h, {
      ...basePolicy,
      perTxMax: '1000000',
      allowedRecipients: [],
      mode: 'shadow',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ perTxMax: '1000000', allowedRecipients: [], mode: 'shadow' })
  })

  it('refuses a resume and an active mandate, which only the panel passkey may give', async () => {
    const h = await owned({ policy: { paused: true } })
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/admin/resume',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { agentId: 'agent-1' },
    })
    expect(res.json()).toEqual({ error: 'loosen_in_panel' })
    const mandate = await h.app.inject({
      method: 'POST',
      url: '/v1/admin/mandates',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { agentId: 'agent-1', budget: '1', domains: [], ttlSeconds: 600, reason: 'x' },
    })
    expect(mandate.statusCode).toBe(403)
  })

  it('alerts the owner, to the bot and as a Web Push attack', async () => {
    const h = await owned()
    await put(h, { ...basePolicy, perTxMax: '99999999' })
    expect(h.bot.alert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'admin_loosen_refused' }),
    )
  })
})

describe('the admin token before a passkey exists (CR-022)', () => {
  it('still loosens on a testnet, so a fresh deployment can be set up', async () => {
    const h = await harness()
    expect((await put(h, { ...basePolicy, perTxMax: '7000000' })).statusCode).toBe(200)
  })

  it('never loosens where a chain is outside the testnets', async () => {
    const h = await harness({ policy: { chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] } })
    const res = await put(h, {
      ...basePolicy,
      chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      perTxMax: '7000000',
    })
    expect(res.statusCode).toBe(403)
    const mainnet = await harness({
      env: { SOLANA_CHAIN: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
    })
    expect((await put(mainnet, { ...basePolicy, perTxMax: '7000000' })).statusCode).toBe(403)
  })
})
