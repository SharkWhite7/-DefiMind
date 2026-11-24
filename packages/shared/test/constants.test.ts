import { describe, expect, it } from 'vitest'
import { CHAINS, isTestnet } from '../src/constants.js'

describe('isTestnet (CR-022)', () => {
  it('holds every test chain and no mainnet', () => {
    expect(isTestnet(CHAINS.solanaDevnet)).toBe(true)
    expect(isTestnet(CHAINS.baseSepolia)).toBe(true)
    expect(isTestnet(CHAINS.robinhoodTestnet)).toBe(true)
    expect(isTestnet(CHAINS.solanaMainnet)).toBe(false)
    expect(isTestnet(CHAINS.base)).toBe(false)
    expect(isTestnet(CHAINS.robinhood)).toBe(false)
    expect(isTestnet('eip155:1')).toBe(false)
  })
})
