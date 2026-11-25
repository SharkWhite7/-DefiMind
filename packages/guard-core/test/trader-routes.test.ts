import { describe, expect, it } from 'vitest'
import { saveTick } from '../src/db/traders.js'
import { harness } from './harness.js'
import { signedIn } from './owner.js'
import { BONK } from './venue.js'

const config = {
  enabled: true,
  mode: 'shadow',
  model: 'claude-sonnet-5-5',
  effort: 'low',
  cadenceMinutes: 60,
  tokens: [BONK],
  instructions: 'Buy small dips.',
}

async function setup(key = true) {
  const h = await harness(key ? { env: { ANTHROPIC_API_KEY: 'sk-ant-test' } } : {})
  return { h, owner: await signedIn(h) }
}

const path = '/v1/owner/trader/agent-1'

describe('the owner trader routes (CR-027)', () => {
  it('reads a trader never set up as off, at the defaults, without the key', async () => {
    const { h, owner } = await setup()
    const res = (await owner.call('GET', path)).json()
    expect(res).toMatchObject({ state: 'off', keySet: true, today: { ticks: 0, tokens: 0 } })
    expect(res.config).toMatchObject({ enabled: false, mode: 'shadow', maxTicksPerDay: 96 })
    expect(JSON.stringify(res)).not.toContain('sk-ant-test')
    expect((await owner.call('GET', '/v1/owner/trader/nobody')).statusCode).toBe(404)
    expect((await h.app.inject({ method: 'GET', url: path })).statusCode).toBe(401)
  })

  it('saves a config with the passkey over what was sent, with the defaults filled in', async () => {
    const { h, owner } = await setup()
    const bare = await owner.call('PUT', path, { config })
    expect(bare.json().error).toBe('step_up_required')
    const assertion = await owner.stepUp('trader_settings', { agentId: 'agent-1', config })
    const res = (await owner.call('PUT', path, { config, assertion })).json()
    expect(res).toMatchObject({ state: 'running', report: { trades: 0, shadow: true } })
    expect(res.config).toMatchObject({ maxActionsPerTick: 3, maxTicksPerDay: 24 })
    expect(h.auditEvents()).toContain('trader_settings')
  })

  it('lowers a cap or turns the trader off with the session alone, and nothing else', async () => {
    const { owner } = await setup()
    const assertion = await owner.stepUp('trader_settings', { agentId: 'agent-1', config })
    await owner.call('PUT', path, { config, assertion })
    const lower = await owner.call('PUT', path, { config: { ...config, maxActionsPerTick: 1 } })
    expect(lower.json().config.maxActionsPerTick).toBe(1)
    const off = await owner.call('PUT', path, {
      config: { ...config, maxActionsPerTick: 1, enabled: false },
    })
    expect(off.json().state).toBe('off')
    const raised = await owner.call('PUT', path, { config: { ...config, enabled: false } })
    expect(raised.json().error).toBe('step_up_required')
    const words = { ...config, enabled: false, maxActionsPerTick: 1, instructions: 'Sell all.' }
    expect((await owner.call('PUT', path, { config: words })).json().error).toBe('step_up_required')
  })

  it('refuses to turn the trader on without the key, and a misspelt field', async () => {
    const { owner } = await setup(false)
    const res = await owner.call('PUT', path, { config })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('anthropic_key_missing')
    const typo = await owner.call('PUT', path, { config: { ...config, maxActionPerTick: 9 } })
    expect(typo.statusCode).toBe(400)
  })

  it('pauses with the session and resumes with the passkey', async () => {
    const { owner } = await setup()
    expect((await owner.call('POST', `${path}/pause`)).statusCode).toBe(404)
    const assertion = await owner.stepUp('trader_settings', { agentId: 'agent-1', config })
    await owner.call('PUT', path, { config, assertion })
    const paused = (await owner.call('POST', `${path}/pause`)).json()
    expect(paused).toMatchObject({ state: 'paused', pausedBy: 'owner' })
    const bare = await owner.call('POST', `${path}/resume`, {})
    expect(bare.json().error).toBe('step_up_required')
    const resumed = await owner.call('POST', `${path}/resume`, {
      assertion: await owner.stepUp('resume_trader', { agentId: 'agent-1' }),
    })
    expect(resumed.json().state).toBe('running')
  })

  it('pages ticks newest first, 50 at a time, before a given start', async () => {
    const { h, owner } = await setup()
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
    for (let i = 0; i < 55; i++) {
      const startedAt = new Date(Date.UTC(2026, 10, 25, 0, i)).toISOString()
      const tick = { id: `t${i}`, agentId: 'agent-1', startedAt, model: 'm', usage }
      saveTick(h.db, { ...tick, outcome: 'held', actions: [], reason: 'quiet' }, '2026-11-25')
    }
    const first = (await owner.call('GET', `${path}/ticks`)).json().ticks
    expect(first).toHaveLength(50)
    expect(first[0].id).toBe('t54')
    const before = encodeURIComponent(first[49].startedAt)
    const next = (await owner.call('GET', `${path}/ticks?before=${before}`)).json().ticks
    expect(next.map((t: { id: string }) => t.id)).toEqual(['t4', 't3', 't2', 't1', 't0'])
  })
})
