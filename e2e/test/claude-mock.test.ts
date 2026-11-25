import { afterEach, describe, expect, it } from 'vitest'
import { mockClaude, toolResults } from './support/claude.js'

// The trader e2e (INT-52) leans on this mock, so its replies must keep the Messages API's shape.
describe('the scripted Claude API mock', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  const post = (url: string, body: object) =>
    fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify(body),
    })

  it('plays the script in order and records each request', async () => {
    const mock = await mockClaude([
      { tools: [{ name: 'get_portfolio', input: {} }] },
      { refusal: true },
      { status: 500 },
    ])
    close = mock.close
    const ask = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'tick' }] }

    const first = (await (await post(mock.url, ask)).json()) as {
      stop_reason: string
      content: { type: string; name?: string }[]
    }
    expect(first.stop_reason).toBe('tool_use')
    expect(first.content[0]).toMatchObject({ type: 'tool_use', name: 'get_portfolio' })
    expect(
      ((await (await post(mock.url, ask)).json()) as { stop_reason: string }).stop_reason,
    ).toBe('refusal')
    const failed = await post(mock.url, ask)
    expect(failed.status).toBe(500)
    expect(failed.headers.get('x-should-retry')).toBe('false')

    expect(mock.requests).toHaveLength(3)
    expect(mock.requests[0]?.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01')
  })

  it('reads the tool results a trader sent back', async () => {
    const mock = await mockClaude()
    close = mock.close
    await post(mock.url, {
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: 'tick' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'token_risk', input: {} }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: '<data>{"name":"X"}</data>' },
          ],
        },
      ],
    })
    expect(toolResults(mock.requests[0]!)).toEqual(['<data>{"name":"X"}</data>'])
  })
})
