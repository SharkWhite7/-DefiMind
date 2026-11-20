import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { createData, depositData, enableData, killData } from '../web/src/evm/calls.js'
import { decodeEvm } from '../web/src/evm/decoded.js'

const owner = getAddress('0x0000000000000000000000000000000000000E0E')
const hot = getAddress('0x0000000000000000000000000000000000000B0b')
const safe = getAddress('0xE0f814d1D102ECa19737Fa20610ff2fA8226Bb20')
const module = getAddress('0xAA46724893dedD72658219405185Fb0Fc91e091C')
const usd = getAddress('0x7E955252E15c84f5768B83c41a71F9eba181802F')
const allowance = { module, hot, usd, cap: 5_000_000n }
const units = '5 (5000000 base units at 6 decimals)'

describe('the EVM call, read from its bytes', () => {
  it('names who may draw, how much, in which token, and how often, on enable', () => {
    expect(decodeEvm(safe, enableData(owner, safe, allowance, false))).toEqual([
      `Enable module ${module} on the Safe.`,
      `Make ${hot} a delegate of module ${module}.`,
      `Let ${hot} draw ${units} of token ${usd}, every 1440 minutes.`,
    ])
  })

  it('names the delegate the kill removes', () => {
    expect(decodeEvm(safe, killData(owner, module, hot))).toEqual([
      `Remove ${hot} as a delegate of module ${module}, with its allowances.`,
    ])
  })

  it('names the recipient and amount of a deposit', () => {
    expect(decodeEvm(usd, depositData(safe, 5_000_000n))).toEqual([
      `Send ${units} of token ${usd} to ${safe}.`,
    ])
  })

  it('names the owners of a new Safe', () => {
    expect(decodeEvm(safe, createData(owner, 1n))).toEqual([
      `Create a Safe owned by ${owner}, threshold 1.`,
    ])
  })

  it('says it cannot read anything else', () => {
    expect(decodeEvm(safe, '0xdeadbeef')).toEqual([
      'A call this page cannot read: reject this transaction.',
    ])
  })
})
