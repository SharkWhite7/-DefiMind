import { describe, expect, it } from 'vitest'
import { CHAINS } from '@defimind/shared'
import { serial } from '../src/service/serial.js'
import { signerKey } from '../src/service/wallets.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

describe('serial', () => {
  it('runs tasks for one key one at a time, in order', async () => {
    const run = serial()
    const log: string[] = []
    const task = (name: string) => async () => {
      log.push(`${name} start`)
      await tick()
      log.push(`${name} end`)
    }
    await Promise.all([run('a', task('1')), run('a', task('2'))])
    expect(log).toEqual(['1 start', '1 end', '2 start', '2 end'])
  })

  it('lets different keys run side by side', async () => {
    const run = serial()
    const log: string[] = []
    const task = (name: string) => async () => {
      log.push(`${name} start`)
      await tick()
      log.push(`${name} end`)
    }
    await Promise.all([run('a', task('a')), run('b', task('b'))])
    expect(log.slice(0, 2)).toEqual(['a start', 'b start'])
  })

  it('keeps going after a task throws', async () => {
    const run = serial()
    const failed = run('a', async () => {
      throw new Error('boom')
    })
    const next = run('a', async () => 'ran')
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ran')
  })
})

describe('signerKey (CR-026)', () => {
  it('locks two agents on the shared wallet together, and an own wallet apart', () => {
    const wallets = { route: (agentId: string) => (agentId === 'own' ? {} : undefined) }
    const deps = { wallets } as unknown as Parameters<typeof signerKey>[0]
    expect(signerKey(deps, 'agent-1', CHAINS.solanaMainnet)).toBe(
      signerKey(deps, 'agent-2', CHAINS.solanaMainnet),
    )
    expect(signerKey(deps, 'own', CHAINS.solanaMainnet)).toBe(`wallet:own:${CHAINS.solanaMainnet}`)
    expect(signerKey({}, 'agent-1', CHAINS.solanaMainnet)).toBe(
      `wallet:shared:${CHAINS.solanaMainnet}`,
    )
  })
})
