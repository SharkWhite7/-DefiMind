import { describe, expect, it } from 'vitest'
import { CHAINS } from '../src/constants.js'
import { inPhantom, signCluster, signPageUrl } from '../src/sign-links.js'

describe('signing-page links', () => {
  it('names each chain the page serves by its cluster, and Base by none', () => {
    expect(signCluster(CHAINS.solanaMainnet)).toBe('mainnet-beta')
    expect(signCluster(CHAINS.solanaDevnet)).toBe('devnet')
    expect(signCluster(CHAINS.robinhood)).toBe('robinhood')
    expect(signCluster(CHAINS.robinhoodTestnet)).toBe('robinhood-testnet')
    expect(signCluster(CHAINS.base)).toBeUndefined()
  })

  it('puts the action, then the cluster, then the rest, whatever the trailing slashes', () => {
    expect(
      signPageUrl('https://sign.example//', CHAINS.solanaMainnet, {
        multisig: 'M',
        action: 'deposit',
      }),
    ).toBe('https://sign.example/?action=deposit&cluster=mainnet-beta&multisig=M')
  })

  it('makes no link for a chain the page does not serve', () => {
    expect(signPageUrl('https://sign.example', CHAINS.base, { action: 'create' })).toBeUndefined()
  })

  it('cannot be steered to another cluster by a parameter of the same name', () => {
    const url = signPageUrl('https://sign.example', CHAINS.solanaMainnet, { cluster: 'devnet' })
    expect(new URL(url!).searchParams.getAll('cluster')).toEqual(['mainnet-beta'])
  })

  it('opens the page inside Phantom with the page itself as the referrer', () => {
    const link = 'https://g.example/sign/?action=create&cluster=devnet'
    expect(inPhantom(link)).toBe(
      `https://phantom.app/ul/browse/${encodeURIComponent(link)}?ref=${encodeURIComponent('https://g.example')}`,
    )
  })
})
