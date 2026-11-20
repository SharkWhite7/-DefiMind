import { z } from 'zod'
import type { PageConfig } from '../page.js'

const record = <T extends z.ZodType>(value: T) => z.record(z.string(), value)

const schema = z.object({
  rpc: record(z.string()),
  usdc: record(z.string()),
  hot: record(z.string()),
  maxDailyCap: z.string().regex(/^[1-9]\d*$/),
  evm: record(
    z.object({
      chainId: z.number().int(),
      module: z.string(),
      usd: z.string(),
      symbol: z.string(),
      hot: z.string().optional(),
    }),
  ),
}) satisfies z.ZodType<PageConfig>

/** Read once, from the page that served this script: never from the link. */
export const config: PageConfig = schema.parse(
  // eslint-disable-next-line no-restricted-properties -- parsed by the schema around it
  JSON.parse(document.getElementById('config')?.textContent ?? 'null'),
)

/** A configured value for the cluster, by its own name only. */
export const configured = <T>(map: Record<string, T>, cluster: string) =>
  Object.hasOwn(map, cluster) ? map[cluster] : undefined
