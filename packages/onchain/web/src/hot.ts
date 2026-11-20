export const NEEDS_OWN_PAGE =
  "Open this from your DefiMind panel: it needs your deployment's own page."
export const NO_LIMIT =
  "No limit found for this hot wallet. Check Spending limits in your vault's app."

/** The hot wallet an action acts for, and whether it came from the link rather than the build. */
export interface Hot<K> {
  key: K
  fromLink: boolean
}

/**
 * A build with a hot wallet for the cluster acts for that one only: a link naming another is
 * refused, since add-limit would grant it. A build without one, the hosted page (CR-020), takes the
 * hot wallet from the link for a kill only, which can only take authority away; anything that grants
 * it needs the deployment's own page.
 */
export function whichHot<K>(
  built: K | undefined,
  named: K | undefined,
  kill: boolean,
  same: (a: K, b: K) => boolean,
  text: (key: K) => string,
): Hot<K> | string {
  if (built !== undefined) {
    if (named !== undefined && !same(named, built)) {
      return (
        `The link names ${text(named)} as the hot wallet, but this page only acts for ` +
        `${text(built)}. Do not sign anything from this link.`
      )
    }
    return { key: built, fromLink: false }
  }
  if (!kill) return NEEDS_OWN_PAGE
  if (named === undefined)
    return 'This kill link names no hot wallet. Open it again from your panel.'
  return { key: named, fromLink: true }
}
