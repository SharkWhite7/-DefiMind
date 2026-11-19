import { describe, expect, it, vi } from 'vitest'
import { PANEL_ONLY } from '../src/domain/text.js'
import {
  buttonData,
  command,
  fakeAdmin,
  fakeGuard,
  NOW,
  OWNER,
  policy,
  press,
  say,
  sent,
  setup,
} from './support.js'

/**
 * With TELEGRAM_APPROVALS off, the panel's passkey guards every loosening. The bot refuses each
 * one before guard-core is asked to change anything, so a stolen Telegram account cannot widen
 * what an agent spends, create one, or become the panel owner.
 */
const panel = (options: Parameters<typeof setup>[0] = {}) =>
  setup({ telegramApprovals: false, guardPublicUrl: 'https://guard.example', ...options })

const text = (call: { payload: Record<string, unknown> } | undefined) =>
  String(call?.payload['text'])
const last = (calls: Parameters<typeof sent>[0]) => sent(calls, 'sendMessage').at(-1)

describe('with Telegram approvals off, loosening is refused', () => {
  it('/agent new creates nothing and shows no token', async () => {
    const { bot, admin, calls } = panel()
    await bot.handleUpdate(command(OWNER, '/agent new research-agent'))
    expect(admin.createAgent).not.toHaveBeenCalled()
    expect(sent(calls, 'sendMessage').map(text)).toEqual([PANEL_ONLY])
  })

  it('/allow adds no domain and makes no admin call', async () => {
    const { bot, admin, calls } = panel()
    await bot.handleUpdate(command(OWNER, '/allow research-agent evil.example.com'))
    expect(admin.policy).not.toHaveBeenCalled()
    expect(admin.putPolicy).not.toHaveBeenCalled()
    expect(text(last(calls))).toBe(PANEL_ONLY)
  })

  it('/mode live changes nothing', async () => {
    const { bot, admin, guard, calls } = panel()
    await bot.handleUpdate(command(OWNER, '/mode research-agent live'))
    expect(admin.putPolicy).not.toHaveBeenCalled()
    expect(guard.budget).not.toHaveBeenCalled()
    expect(text(last(calls))).toBe(PANEL_ONLY)
  })

  it('/resume does not resume the agent', async () => {
    const { bot, guard, calls } = panel()
    await bot.handleUpdate(command(OWNER, '/resume research-agent'))
    expect(guard.setPaused).not.toHaveBeenCalled()
    expect(text(last(calls))).toBe(PANEL_ONLY)
  })

  it('a preset that raises a limit is refused without a confirm', async () => {
    const { bot, admin, calls } = panel()
    await bot.handleUpdate(command(OWNER, '/policy research-agent'))
    await bot.handleUpdate(press(OWNER, buttonData(last(calls), 'Standard')))
    expect(admin.putPolicy).not.toHaveBeenCalled()
    expect(text(last(calls))).toBe(PANEL_ONLY)
  })

  it('a raised limit from a reply is refused', async () => {
    const { bot, admin, calls } = panel()
    await bot.handleUpdate(command(OWNER, '/policy research-agent'))
    await bot.handleUpdate(press(OWNER, buttonData(last(calls), 'Edit daily max')))
    await bot.handleUpdate(say(OWNER, '500', last(calls)?.messageId))
    expect(admin.putPolicy).not.toHaveBeenCalled()
    expect(text(last(calls))).toBe(PANEL_ONLY)
  })

  it('/passkey enrol asks for no code and points to the machine', async () => {
    const { bot, admin, calls } = panel()
    await bot.handleUpdate(command(OWNER, '/passkey enrol'))
    expect(admin.enrolCode).not.toHaveBeenCalled()
    expect(text(last(calls))).toContain(
      '<code>pnpm --filter @defimind/guard-core passkey-code</code>',
    )
  })

  it('the shadow graduation offer has no Go live button', async () => {
    const budget = vi.fn(async () => ({
      spentToday: '0',
      dailyMax: '10000000',
      perTxMax: '2000000',
      hotWalletBalances: {},
      paused: false,
      shadow: { since: NOW.toISOString(), total: '2500000', count: 2 },
    }))
    const later = new Date(NOW.getTime() + 4 * 86_400_000)
    const { owner, calls } = panel({ now: () => later, guard: fakeGuard({ budget }) })
    await owner.sweep()
    const offer = last(calls)
    expect(text(offer)).toBe(
      'Your agent <code>research-agent</code> would have spent $2.50 in 2 payments. ' +
        'Go live in the DefiMind panel.',
    )
    expect(offer?.payload['reply_markup']).toBeUndefined()
  })
})

describe('with Telegram approvals off, tightening still works', () => {
  it('/deny, /mode shadow, a lowering preset, /pause and /agent revoke', async () => {
    const admin = fakeAdmin()
    const { bot, guard, calls } = panel({ admin })
    await bot.handleUpdate(command(OWNER, '/deny research-agent api.example.com'))
    expect(admin.putPolicy).toHaveBeenLastCalledWith(policy({ allowedDomains: [] }))
    await bot.handleUpdate(command(OWNER, '/mode research-agent shadow'))
    expect(admin.putPolicy).toHaveBeenLastCalledWith(policy({ allowedDomains: [], mode: 'shadow' }))
    await bot.handleUpdate(command(OWNER, '/policy research-agent'))
    await bot.handleUpdate(press(OWNER, buttonData(last(calls), 'Careful')))
    expect(admin.putPolicy).toHaveBeenCalledTimes(3)
    await bot.handleUpdate(command(OWNER, '/pause research-agent'))
    expect(guard.setPaused).toHaveBeenCalledWith('research-agent', true)
    await bot.handleUpdate(command(OWNER, '/agent revoke research-agent'))
    await bot.handleUpdate(press(OWNER, buttonData(last(calls), 'Revoke')))
    expect(admin.revokeAgent).toHaveBeenCalledWith('research-agent')
  })
})
