/** Twelve decimal places: unitPrice's own precision. */
const SCALE = 12

/** A decimal price string as an integer at SCALE places; undefined when it is not one. */
function scaled(price: string): bigint | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(price)
  if (match === null) {
    return undefined
  }
  const fraction = (match[2] ?? '').slice(0, SCALE).padEnd(SCALE, '0')
  return BigInt(match[1] ?? '0') * 10n ** BigInt(SCALE) + BigInt(fraction)
}

/**
 * The change from `past` to `latest`, as a signed percent with two decimals ("+4.20%"), rounded
 * toward zero; null without a past price to compare with. Display data for the model, never used
 * in a decision.
 */
export function priceChange(latest: string, past: string | undefined): string | null {
  const now = scaled(latest)
  const then = past === undefined ? undefined : scaled(past)
  if (now === undefined || then === undefined || then === 0n) {
    return null
  }
  const hundredths = ((now - then) * 10_000n) / then
  const sign = hundredths < 0n ? '-' : '+'
  const abs = hundredths < 0n ? -hundredths : hundredths
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}%`
}
