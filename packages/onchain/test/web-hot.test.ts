import { describe, expect, it } from 'vitest'
import { NEEDS_OWN_PAGE, whichHot } from '../web/src/hot.js'

const same = (a: string, b: string) => a === b
const pick = (built: string | undefined, named: string | undefined, kill = true) =>
  whichHot(built, named, kill, same, (key) => key)

describe('which hot wallet an action acts for', () => {
  it("acts for the build's own, and refuses a link naming another", () => {
    expect(pick('ours', undefined)).toEqual({ key: 'ours', fromLink: false })
    expect(pick('ours', 'ours', false)).toEqual({ key: 'ours', fromLink: false })
    expect(pick('ours', 'theirs')).toMatch(
      /names theirs as the hot wallet, but this page only acts for ours/,
    )
  })

  it('takes it from the link on a build without one, for a kill only', () => {
    expect(pick(undefined, 'named')).toEqual({ key: 'named', fromLink: true })
    expect(pick(undefined, 'named', false)).toBe(NEEDS_OWN_PAGE)
    expect(pick(undefined, undefined)).toMatch(/^This kill link names no hot wallet/)
  })
})
