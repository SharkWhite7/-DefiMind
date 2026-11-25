import { parseDollars } from './money.js'
import { parseUnits } from './tokens.js'
import { parsePercent } from './trading.js'

export type OrderKind = 'take_profit' | 'stop_loss'

export const ORDER_KINDS: Record<OrderKind, string> = {
  take_profit: 'Take profit',
  stop_loss: 'Stop loss',
}

/** When each kind sells, as the label of the trigger the owner typed. */
export const WHEN: Record<OrderKind, string> = {
  take_profit: 'Sells once worth at least',
  stop_loss: 'Sells once worth at most',
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
  /** Absent when the owner left it empty: guard-core then uses the policy's. */
  maxSlippageBps?: number
}

const isKind = (kind: string): kind is OrderKind => Object.hasOwn(ORDER_KINDS, kind)

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
  const order: NewOrder = { kind: form.kind, amount, triggerOut }
  if (form.slippage.trim() === '') {
    return order
  }
  const bps = parsePercent(form.slippage)
  if (bps === undefined || bps > maxSlippageBps) {
    return `Slippage: write a percent up to this agent's ${(maxSlippageBps / 100).toFixed(2)}.`
  }
  return { ...order, maxSlippageBps: bps }
}

/** guard-core's reasons for refusing to place an order (CR-026), said plainly. */
export const REFUSALS: Record<string, string> = {
  ORDERS_DISABLED: "Orders are off in this agent's Trading limits.",
  ORDER_LIMIT_EXCEEDED: 'This agent already has as many open orders as its limits allow.',
  INSUFFICIENT_POSITION: 'Its open orders on this token would sell more than it holds.',
  SLIPPAGE_TOO_HIGH: "The slippage is above this agent's limit.",
  TRADING_DISABLED: 'Trading is off for this agent.',
}
