import { describe, expect, it } from 'vitest'
import { RecordError, httpRecorder } from '../src/adapters/recorder.js'
import { solanaAnchorTx } from '../src/adapters/solana.js'
import { ANCHOR_KEY, chain, fakeRpc } from './chain.js'

const [receipt] = chain(1)
const report = {
  server: 's',
  tool: 't',
  requestHash: '0'.repeat(64),
  responseHash: '1'.repeat(64),
  outcome: 'ok' as const,
  startedAt: '2026-11-18T10:00:00.000Z',
  endedAt: '2026-11-18T10:00:01.000Z',
}

function stub(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status })
  }
  return { calls, fetch }
}

describe('httpRecorder', () => {
  it('posts the report with the agent token and returns the receipt', async () => {
    const { calls, fetch } = stub(200, receipt)
    const recorder = httpRecorder({ guardUrl: 'https://guard.example.com', token: 'tok', fetch })
    expect(await recorder.record(report)).toEqual(receipt)
    expect(calls[0]?.url).toBe('https://guard.example.com/v1/agent/executions')
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(report)
  })

  it('throws RecordError on a refusal, a non-receipt and no answer', async () => {
    const refused = httpRecorder({
      guardUrl: 'http://localhost:8787',
      token: 't',
      ...stub(401, {}),
    })
    await expect(refused.record(report)).rejects.toMatchObject({ httpStatus: 401 })
    const odd = httpRecorder({
      guardUrl: 'http://localhost:8787',
      token: 't',
      ...stub(200, { ok: 1 }),
    })
    await expect(odd.record(report)).rejects.toThrow('not a receipt')
    const down = httpRecorder({
      guardUrl: 'http://localhost:8787',
      token: 't',
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    })
    await expect(down.record(report)).rejects.toBeInstanceOf(RecordError)
  })

  it('refuses plain http beyond this machine and a URL with credentials', () => {
    expect(() => httpRecorder({ guardUrl: 'http://guard.example.com', token: 't' })).toThrow(
      'https://',
    )
    expect(() => httpRecorder({ guardUrl: 'https://u:p@guard.example.com', token: 't' })).toThrow(
      'credentials',
    )
  })
})

describe('solanaAnchorTx', () => {
  it('reads the memos, the block time and whether the tx failed', async () => {
    const tx = await solanaAnchorTx(
      'https://rpc',
      'sig',
      fakeRpc(['defimind:anchor:v1:1-1:aa']).fetch,
    )
    expect(tx).toEqual({
      memos: ['defimind:anchor:v1:1-1:aa'],
      signer: ANCHOR_KEY,
      blockTime: Date.parse('2026-11-18T11:00:05.000Z') / 1000,
      failed: false,
    })
  })

  it('returns nothing for an unknown transaction', async () => {
    expect(await solanaAnchorTx('https://rpc', 'sig', fakeRpc([], { missing: true }).fetch)).toBe(
      undefined,
    )
  })
})
