import type { Policy } from '@defimind/shared'
import { type Bot, type Context, InlineKeyboard } from 'grammy'
import type { Logger } from 'pino'
import type { AdminClient } from '../adapters/admin.js'
import type { GuardClient } from '../adapters/guard.js'
import { formatUsd } from '../domain/money.js'
import {
  hostname,
  LIMIT_NAMES,
  LIMITS,
  type Limit,
  loosens,
  parseDollars,
  policyText,
  PRESETS,
} from '../domain/policy.js'
import { PANEL_ONLY } from '../domain/text.js'
import type { Desk } from './desk.js'
import { args, code, guarded, HTML, type Press, validAgent } from './owner-kit.js'

export interface PolicyDeps {
  admin: AdminClient
  guard: GuardClient
  desk: Desk
  log: Logger
  now: () => Date
  button: (run: Press, ttlMs?: number) => string
}

type Change = Partial<Pick<Policy, Limit | 'mode' | 'allowedDomains'>>

/** How long an agent runs in shadow mode before the bot points the owner to the panel to go live. */
export const GRADUATION_MS = 3 * 86_400_000
const GRADUATION_CHECK_MS = 5 * 60_000

/**
 * The policy from Telegram, tightening only (CR-016): lower a limit, drop a domain, go back to
 * shadow. Anything that widens what the agent may spend is the panel's, behind a passkey.
 */
export function registerPolicies(bot: Bot, { admin, guard, desk, log, now, button }: PolicyDeps) {
  /** The prompts waiting for the owner's reply, keyed by chat and prompt message. */
  const edits = new Map<string, { agentId: string; limit: Limit }>()

  function policyKeyboard(agentId: string) {
    const keyboard = new InlineKeyboard()
    for (const preset of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) {
      keyboard.text(
        preset,
        button((press) => change(press, agentId, PRESETS[preset])),
      )
    }
    keyboard.row()
    for (const limit of LIMITS) {
      keyboard.text(
        `Edit ${LIMIT_NAMES[limit]}`,
        button(async (press) => {
          const prompt = await press.reply(
            `New ${LIMIT_NAMES[limit]} for ${code(agentId)}, in dollars (like 2.50):`,
            { ...HTML, reply_markup: { force_reply: true } },
          )
          edits.set(`${prompt.chat.id}:${prompt.message_id}`, { agentId, limit })
        }),
      )
    }
    return keyboard
  }

  /** Reads the policy and writes the change back, unless it would loosen anything. */
  async function change(ctx: Context, agentId: string, next: Change) {
    const before = await admin.policy(agentId)
    if (before === undefined) {
      await ctx.reply(`No agent ${code(agentId)}.`, HTML)
      return
    }
    const after = { ...before, ...next }
    if (loosens(before, after)) {
      await ctx.reply(PANEL_ONLY)
      return
    }
    const saved = await admin.putPolicy(after)
    log.info({ agentId, owner: ctx.from?.id, change: Object.keys(next) }, 'policy changed')
    await ctx.reply(`Saved.\n${policyText(saved)}`, HTML)
  }

  bot.command('policy', (ctx) => {
    const [agentId] = args(ctx)
    if (!validAgent(agentId)) {
      return ctx.reply('Usage: /policy &lt;agentId&gt;', HTML)
    }
    return guarded(ctx, log, async () => {
      const policy = await admin.policy(agentId)
      await ctx.reply(policy === undefined ? `No agent ${code(agentId)}.` : policyText(policy), {
        ...HTML,
        ...(policy === undefined ? {} : { reply_markup: policyKeyboard(agentId) }),
      })
    })
  })

  bot.on('message:text', async (ctx, next) => {
    const reply = ctx.message.reply_to_message
    const key = reply === undefined ? '' : `${reply.chat.id}:${reply.message_id}`
    const edit = edits.get(key)
    if (edit === undefined) {
      return next()
    }
    const amount = parseDollars(ctx.message.text)
    if (amount === undefined) {
      await ctx.reply('Send an amount in dollars, like 2.50. Reply to the question again.')
      return
    }
    edits.delete(key)
    await guarded(ctx, log, () => change(ctx, edit.agentId, { [edit.limit]: amount }))
  })

  bot.command('allow', (ctx) => ctx.reply(PANEL_ONLY))

  bot.command('deny', (ctx) => {
    const [agentId, domain] = args(ctx)
    const host = hostname(domain ?? '')
    if (!validAgent(agentId) || host === undefined) {
      return ctx.reply('Usage: /deny &lt;agentId&gt; &lt;domain&gt;, like api.example.com', HTML)
    }
    return guarded(ctx, log, async () => {
      const policy = await admin.policy(agentId)
      if (policy === undefined) {
        await ctx.reply(`No agent ${code(agentId)}.`, HTML)
        return
      }
      await change(ctx, agentId, {
        allowedDomains: policy.allowedDomains.filter((d) => d !== host),
      })
    })
  })

  bot.command('mode', (ctx) => {
    const [agentId, mode] = args(ctx)
    if (mode === 'live') {
      return ctx.reply(PANEL_ONLY)
    }
    if (!validAgent(agentId) || mode !== 'shadow') {
      return ctx.reply('Usage: /mode &lt;agentId&gt; shadow', HTML)
    }
    return guarded(ctx, log, () => change(ctx, agentId, { mode: 'shadow' }))
  })

  const payments = (count: number) => `${count} ${count === 1 ? 'payment' : 'payments'}`

  // Only "already told" is kept here: guard-core keeps the totals, so a bot restart repeats a
  // message at most once.
  const offered = new Set<string>()
  let checked = 0

  /** Runs on the sweep timer, but asks guard-core at most every few minutes. */
  async function offerGraduation() {
    if (now().getTime() - checked < GRADUATION_CHECK_MS) {
      return
    }
    checked = now().getTime()
    for (const { agentId, mode } of await admin.listAgents()) {
      if (mode !== 'shadow' || offered.has(agentId)) {
        continue
      }
      const shadow = (await guard.budget(agentId))?.shadow
      if (shadow === undefined || now().getTime() - Date.parse(shadow.since) < GRADUATION_MS) {
        continue
      }
      offered.add(agentId)
      await desk.announce(
        `Your agent ${code(agentId)} would have spent ${formatUsd(shadow.total)} ` +
          `in ${payments(shadow.count)}. Go live in the DefiMind panel.`,
      )
    }
  }

  return { offerGraduation }
}
