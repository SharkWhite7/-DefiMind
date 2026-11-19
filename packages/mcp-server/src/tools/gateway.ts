import { type Recorder, hashOf } from '@defimind/sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { BodyEntry } from '../adapters/bodies.js'
import type { Downstream } from '../adapters/downstream.js'
import type { Outbox } from '../adapters/outbox.js'
import { gatewayName } from '../domain/gateway.js'
import { failure } from './result.js'

export interface GatewayDeps {
  downstreams: Downstream[]
  recorder: Recorder
  outbox: Outbox
  log: Logger
  keepBody?: (entry: BodyEntry) => void
  now?: () => Date
}

export const PAUSED =
  'DefiMind has not yet recorded an earlier tool call, so no new call is forwarded until it does. ' +
  'Nothing was sent. Tell the user that tool calls are paused, and try again in a minute.'

const UNRECORDED =
  'DefiMind could not record this call yet. It ran, and its result is above; the receipt waits ' +
  'and further tool calls are paused until DefiMind records it.'

/** Registers every downstream tool as <server>__<tool>; returns how many were exposed. */
export function registerGateway(server: McpServer, deps: GatewayDeps): number {
  let count = 0
  for (const downstream of deps.downstreams) {
    for (const tool of downstream.tools) {
      const name = gatewayName(downstream.name, tool.name)
      if (name === undefined) {
        deps.log.warn({ server: downstream.name, tool: tool.name }, 'tool name too long, skipped')
        continue
      }
      server.registerTool(
        name,
        {
          title: tool.title ?? tool.name,
          // Written by the downstream server, so labelled as such, never as DefiMind's own text.
          description: `[via ${downstream.name}] ${tool.description ?? ''}`.trim(),
          inputSchema: inputOf(tool),
          ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        },
        (args: unknown) => forward(deps, downstream, tool.name, asArguments(args)),
      )
      count++
    }
  }
  return count
}

/** MCP arguments are an object; anything else is sent as none. */
function asArguments(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function inputOf(tool: Tool): z.ZodType {
  try {
    return z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0])
  } catch {
    // A schema zod cannot read still reaches the downstream server, which validates its own input.
    return z.looseObject({})
  }
}

async function forward(
  deps: GatewayDeps,
  downstream: Downstream,
  tool: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const { recorder, outbox, log, now = () => new Date() } = deps
  if (outbox.size() > 0) {
    await outbox.drain((report) => recorder.record(report))
    if (outbox.size() > 0) {
      return failure(PAUSED)
    }
  }
  const startedAt = now().toISOString()
  let result: CallToolResult
  try {
    result = await downstream.call(tool, args)
  } catch (error) {
    log.warn({ server: downstream.name, tool, err: error }, 'downstream call failed')
    result = failure(`${downstream.name} did not complete the call.`)
  }
  const report = {
    server: downstream.name,
    tool,
    requestHash: hashOf(args),
    responseHash: hashOf(result),
    outcome: result.isError === true ? ('error' as const) : ('ok' as const),
    startedAt,
    endedAt: now().toISOString(),
  }
  const body = { ...report, arguments: args, result }
  try {
    const receipt = await recorder.record(report)
    deps.keepBody?.({ ...body, receipt: { seq: receipt.seq, hash: receipt.hash } })
    return {
      ...result,
      _meta: { ...result._meta, 'defimind/receipt': { seq: receipt.seq, hash: receipt.hash } },
    }
  } catch (error) {
    log.error({ server: downstream.name, tool, err: error }, 'call not recorded, kept in outbox')
    outbox.add(report)
    deps.keepBody?.(body)
    return { ...result, content: [...result.content, { type: 'text', text: UNRECORDED }] }
  }
}
