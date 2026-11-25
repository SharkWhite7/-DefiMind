import { parseDollars } from './money.js'
import { parseUnits } from './tokens.js'
import { parsePercent } from './trading.js'

export type OrderKind = 'take_profit' | 'stop_loss'
/** CR-028: placed by an agent or the hunt; the panel shows and cancels it, and places none yet. */
export type ListedKind = OrderKind | 'trailing_stop'

export const ORDER_KINDS: Record<ListedKind, string> = {
  take_profit: 'Take profit',
  stop_loss: 'Stop loss',
  trailing_stop: 'Trailing stop',
}

/** When each kind sells, as the label of the trigger the owner typed. */
export const WHEN: Record<ListedKind, string> = {
  take_profit: 'Sells once worth at least',
  stop_loss: 'Sells once worth at most',
  trailing_stop: 'Sells once worth at most',
}

/** The level an order sells at, as guard-core works it out: a trailing stop's follows its high. */
export function orderTrigger(order: {
  kind: ListedKind
  triggerOut: string
  trailBps?: number | undefined
  peakOut?: string | undefined
}): string {
  if (order.kind !== 'trailing_stop' || order.peakOut === undefined) {
    return order.triggerOut
  }
  const trailed = (BigInt(order.peakOut) * BigInt(10_000 - (order.trailBps ?? 0))) / 10_000n
  return trailed > BigInt(order.triggerOut) ? trailed.toString() : order.triggerOut
}

export const ORDER_STATUS: Record<string, string> = {
  open: 'Open',
  triggered: 'Selling now',
  filled: 'Sold',
  cancelled: 'Cancelled',
  failed: 'Not sold',
}

/** What a fill must get at least, as guard-core works it out (CR-026): rounded down. */
export const orderFloor = (triggerOut: string, slippageBps: number): string =>
  ((BigInt(triggerOut) * BigInt(10_000 - slippageBps)) / 10_000n).toString()

export interface OrderForm {
  kind: string
  amount: string
  trigger: string
  slippage: string
}

export interface NewOrder {
  kind: OrderKind
  amount: string
  triggerOut: string
  /** Always sent, the agent's own when left empty: the passkey then pins the floor shown. */
  maxSlippageBps: number
}

const isKind = (kind: string): kind is OrderKind => kind === 'take_profit' || kind === 'stop_loss'

/** The order the owner typed, or the first thing wrong with it, said to the owner. */
export function fromOrderForm(form: OrderForm, decimals: number, maxSlippageBps: number) {
  if (!isKind(form.kind)) {
    return 'Choose take profit or stop loss.'
  }
  const amount = parseUnits(form.amount, decimals)
  if (amount === undefined) {
    return 'Amount: write an amount of the token, like 1.5.'
  }
  const triggerOut = parseDollars(form.trigger)
  if (triggerOut === undefined || triggerOut === '0') {
    return 'Price: write what the whole amount sells for, in dollars, like 40.00.'
  }
  const typed = form.slippage.trim()
  const bps = typed === '' ? maxSlippageBps : parsePercent(typed)
  if (bps === undefined || bps > maxSlippageBps) {
    return `Slippage: write a percent up to this agent's ${(maxSlippageBps / 100).toFixed(2)}.`
  }
  return { kind: form.kind, amount, triggerOut, maxSlippageBps: bps }
}

/** guard-core's reasons for refusing to place an order (CR-026), said plainly. */
export const REFUSALS: Record<string, string> = {
  ORDERS_DISABLED: "Orders are off in this agent's Trading limits.",
  ORDER_LIMIT_EXCEEDED: 'This agent already has as many open orders as its limits allow.',
  INSUFFICIENT_POSITION: 'Its open orders on this token would sell more than it holds.',
  SLIPPAGE_TOO_HIGH: "The slippage is above this agent's limit.",
  TRADING_DISABLED: 'Trading is off for this agent.',
}
