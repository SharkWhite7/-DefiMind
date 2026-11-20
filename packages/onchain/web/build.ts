import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { configFromEnv, pageHtml } from './page.js'

/**
 * The owner's signing page, as static files in web/dist. Everything the page runs is bundled here
 * from the lockfile's pinned versions: nothing is fetched at runtime but the RPC, and the CSP allows
 * nothing else.
 *
 * app.js holds no address: index.html carries the config (page.ts). The hosted index.html gets it
 * from the env now; index.template.html is the same page unfilled, for guard-core's /sign.
 */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export async function buildPage(outdir = here('./dist'), env = process.env) {
  await mkdir(outdir, { recursive: true })
  await build({
    entryPoints: [here('./src/main.ts')],
    outfile: `${outdir}/app.js`,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    // Some dependencies read process.env; a browser has no process.
    define: { 'process.env': '{}' },
    logLevel: 'warning',
  })
  const template = await readFile(here('./public/index.html'), 'utf8')
  await writeFile(`${outdir}/index.template.html`, template)
  await writeFile(`${outdir}/index.html`, pageHtml(template, configFromEnv(env)))
  await copyFile(here('./public/style.css'), `${outdir}/style.css`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildPage()
}
