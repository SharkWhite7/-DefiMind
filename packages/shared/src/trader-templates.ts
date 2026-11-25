import type { Amount, TraderConfig } from './types.js'

/**
 * CR-027: ready-made AI trader strategies. The owner picks one and may edit it; the trader keeps a
 * copy of the text, so a later version never changes a running trader. They are "ready-made", never
 * "tested": no template carries a performance claim.
 */
export interface TraderTemplate {
  id: string
  /** Bumped on every change to the text or the suggestions. */
  version: number
  name: string
  summary: string
  instructions: string
  suggested: {
    cadenceMinutes: TraderConfig['cadenceMinutes']
    maxActionsPerTick: number
    /** The chain's dollar, atomic. The panel applies them through the usual passkey rules. */
    maxTradeUsd: Amount
    dailyTradeMax: Amount
    maxPositionUsd: Amount
    orders: boolean
  }
}

const usd = (dollars: number): Amount => String(dollars * 1_000_000)

export const TRADER_TEMPLATES: readonly TraderTemplate[] = [
  {
    id: 'accumulate-dips',
    version: 1,
    name: 'Accumulate on dips',
    summary: 'Builds positions slowly, buying small amounts after a fall. Rarely sells.',
    instructions: [
      'Build long-term positions in the listed tokens a little at a time.',
      'Buy only after a token has fallen clearly below the middle of its range in recent_prices,',
      'and never more than one buy per token in a tick. Keep each buy well under the per-buy limit',
      'so there is room to buy again if it keeps falling.',
      'Do not sell to chase gains. Hold when nothing has fallen; holding is the usual outcome.',
    ].join(' '),
    suggested: {
      cadenceMinutes: 60,
      maxActionsPerTick: 2,
      maxTradeUsd: usd(3),
      dailyTradeMax: usd(10),
      maxPositionUsd: usd(20),
      orders: false,
    },
  },
  {
    id: 'trend-stops',
    version: 1,
    name: 'Trend follower with tight stops',
    summary: 'Buys tokens that are rising steadily and protects each buy with a stop-loss.',
    instructions: [
      'Follow steady trends in the listed tokens.',
      'Buy a token only when recent_prices shows it rising over most of the last day, not after a',
      'single spike. Right after each buy, place a stop-loss about 5% under what you paid and a',
      'take-profit about 10% over it, for the whole amount bought.',
      'Sell a position whose trend has clearly turned, even before its stop.',
      'When no token is trending, hold.',
    ].join(' '),
    suggested: {
      cadenceMinutes: 15,
      maxActionsPerTick: 3,
      maxTradeUsd: usd(5),
      dailyTradeMax: usd(15),
      maxPositionUsd: usd(10),
      orders: true,
    },
  },
  {
    id: 'degen-quick',
    version: 1,
    name: 'Degen: new tokens, small size, quick exits',
    summary: 'Small, fast trades in volatile tokens. Every buy gets a stop-loss and a take-profit.',
    instructions: [
      'Trade volatile tokens from the list for short moves, in small sizes.',
      'Check token_risk before every first buy, and skip any token whose card shows a risk.',
      'Keep each buy at most a third of the per-buy limit. Right after each buy, place a stop-loss',
      'about 8% under what you paid and a take-profit about 15% over it.',
      'Sell anything held for more than a few hours that has not moved. Never add to a losing',
      'position. The first buy of a new token waits for the owner, so do not retry it.',
    ].join(' '),
    suggested: {
      cadenceMinutes: 5,
      maxActionsPerTick: 3,
      maxTradeUsd: usd(3),
      dailyTradeMax: usd(15),
      maxPositionUsd: usd(5),
      orders: true,
    },
  },
  {
    id: 'steady-balance',
    version: 1,
    name: 'Keep a steady balance',
    summary: 'Keeps the listed tokens and dollars near equal shares, trading only when they drift.',
    instructions: [
      'Keep the portfolio near equal shares by current value, between the listed tokens and the',
      'dollar. Value each holding with a quote of selling it.',
      'Trade only when one share has drifted more than about a fifth away from equal, and then',
      'only enough to bring it back. Prefer one trade per tick.',
      'Hold whenever the shares are close enough.',
    ].join(' '),
    suggested: {
      cadenceMinutes: 60,
      maxActionsPerTick: 1,
      maxTradeUsd: usd(5),
      dailyTradeMax: usd(10),
      maxPositionUsd: usd(15),
      orders: false,
    },
  },
]
