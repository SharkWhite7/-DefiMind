# Visual polish for the demo video (PANEL-16, ON-25, SITE-3)

The owner will record his screen to show DefiMind working: the panel on his iPhone, the signing page
and the website. He asked, in his words, for every page and the app to look like a successful startup
and a real blockchain app, keeping how easy it is, and for **nothing that works to change: appearance
only**.

## The rule that overrides everything else

Appearance only. In each PR:

- No change to behaviour, flows, routes, API calls, request or response shapes, storage, event
  handlers, timers, validation or error handling.
- No change to any user-facing text, including button labels, headings, errors and help text. The
  copy is reviewed and some of it is a security statement.
- No new dependency and no external resource. The panel's CSP is `default-src 'none'` with
  `style-src 'self'` and no `font-src`, and the signing page's CSP is built in. So: no web fonts, no CDN
  and no remote images. Use the system font stack.
- Markup changes in `src/ui/*.ts` or HTML are allowed only to add a class or a wrapper element for
  styling. Keep every id, `data-*` attribute and element the code or tests select on.
- Tests pass unchanged. If a test breaks, the change was not appearance only.
- Never hide, truncate or shorten an amount, address, chain, token or expiry on the approval, kill or
  deposit screens. The owner checks them there before signing. Style them, but show them whole.

## One look across the three surfaces

Take the website's brand as the source, since it is the most finished. Its tokens are in
`site/index.html` `:root`:

- surfaces: `--bg #050505`, `--panel #0d0d0d`, `--line #1c1c1e`, `--line-2 #2a2a2d`;
- text: `--fg #f5f5f5`, `--muted #a0a0a5`;
- accents: violet `#9945ff`, mint `#14f195`, and the gradient `#9945ff → #43b4ca → #14f195`;
- states: amber `#e8b45a`, red `#f87171`.

The panel moves from its blue and cyan to these. Keep the semantic roles:

- ok / live: mint;
- needs you: amber;
- stop / kill / reject: red.

Use the gradient as an accent: the wordmark, the primary button or a thin top border on key cards.
It is not a background for text.

Typography (panel and signing page):

- text: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, system-ui, sans-serif`;
- addresses, hashes and transaction ids: `ui-monospace, "SF Mono", Menlo, monospace`;
- amounts: `font-variant-numeric: tabular-nums`.

Large figures, such as the amount on an approval or the spend on Overview, are big, bold and calm.

What "a real blockchain app" means here:

- dark surfaces with a 1px line, 14–16px radius and generous spacing;
- status pills with a dot: Live, Running, Paused, Ready, Error;
- chain shown as a text pill (`Solana`, `Robinhood Chain`) with a small colour dot. No third-party
  logos;
- addresses in mono with a slightly muted colour, wrapping cleanly;
- one clear primary action per screen; destructive actions red outline, never gradient;
- subtle 150 ms transitions on hover, press and focus, all off under
  `prefers-reduced-motion: reduce`;
- visible focus rings, WCAG AA contrast, and tap targets of at least 44px.

## Per surface

**PANEL-16, panel (`packages/panel/public/app.css`, plus classes in `src/ui` only where needed).**
This is what the video shows most, on an iPhone in Safari, so design at 390×844 first.

- The sticky header is 92% opaque, so content scrolling under it shows through it (seen in the
  owner's screenshots). Make it solid, or blurred with `backdrop-filter` and a fallback, and respect
  `env(safe-area-inset-*)`.
- The nav wraps onto two lines on a phone. Put it on one horizontally scrollable row, with the current
  screen clearly marked. Keep Stop red and easy to find, but not louder than the screen's own content.
- Polish these screens:
  - the approval screen: a big amount, details in a clean key/value list, and Approve with passkey as
    the primary action;
  - Overview: spend as a large figure;
  - Agents and the agent page: status pills;
  - Executions: timeline and receipt;
  - Deposit, Report, Doctor, Settings, the guide, login and enrol.
- PANEL-15 is still in review. Rebase on it once merged rather than touching the same lines twice.

**ON-25, onchain (`packages/onchain/web/public/style.css` and `index.html` classes only).**

- The page is unstyled today. Give it the same dark brand look: a centred card, the DefiMind
  wordmark, a large state title and a clear wallet button.
- Keep `data-state` colours meaningful: stop is red, done is mint.
- Do not change `app.js` logic or `page.ts` text.
- The deployed hashes change, so update what the release flow expects. The integrator re-checks
  `defimind-sign.vercel.app` against the new `SHA256SUMS` after merge.

**SITE-3, integrator (`site/`).**

- The site already carries the brand. Make it match the panel's new look, so the video cuts between
  them cleanly, and check it on a phone at 390px.
- No new claims, never "audited", and Base stays "next".
- Screenshots of the panel on the site are welcome only if they come from devnet or test data, with
  no real address of the owner's.

## Done means

- `pnpm lint`, `pnpm typecheck` and `pnpm test` pass, plus the package's own build.
- The PR has before and after screenshots of every screen it touches, at 390×844 (iPhone), and for
  the site and signing page also at 1440×900. Use devnet or test data only, never the owner's real
  addresses.
- The PR description lists every file changed and states that no text, logic or test changed.
- The board row is set to review, and the manager is told the PR number.
