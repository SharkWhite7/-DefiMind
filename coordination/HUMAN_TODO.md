# Owner tasks

Things only the owner can do: keys, accounts, signing, approvals. Only the manager writes this file.
Other sessions that need something from the owner leave a note in `coordination/messages/manager/`.
The manager talks to the owner in chat; this file is the written record, in English like the rest of the
repository.

**Nothing that authenticates or signs goes through chat**: private keys, seed phrases, `ADMIN_TOKEN`,
`BOT_TOKEN`, `BOT_WEBHOOK_SECRET`, the BotFather token, Fly or npm tokens. The owner generates each
value on their own machine and writes it straight into the file or secret store that needs it. Public
addresses are fine to share. A secret that reaches a chat, a log or a screenshot is burned and gets
replaced.

Status: ✅ done · ⏳ waiting on the owner · ⬜ not needed yet · ✖️ dropped

Before any live run, update and restart, or the system runs old code without saying so:

```bash
cd ~/DefiMind && git checkout main && git pull && pnpm install
```

Live addresses, caps and the launch record are in [`LAUNCH.md`](../LAUNCH.md) and
[`docs/security-review.md`](../docs/security-review.md).

---

## ⏳ HUMAN-25 — Ask Phantom to review the signing page's domain

When the owner created the Solana mainnet multisig, Phantom showed "This dApp could be malicious" and
blocked the request until it was confirmed as unsafe. Only the multisig create transaction was
flagged; adding the spending limit and the kill were not. New domains get this, and every user of the
page will see the warning.

Neither the manager nor the integrator could confirm an official review form. Two routes, neither
verified:

1. **A public issue on Phantom's blocklist repository**,
   [github.com/phantom/blocklist](https://github.com/phantom/blocklist), asking for a manual review.
   Others have done this for their domains; the outcome is unknown. It is public and shows the owner's
   GitHub account.

   Title: `Manual review request: agentguard-onchain.vercel.app ("This dApp could be malicious")`

   ```text
   Phantom shows "This dApp could be malicious" on agentguard-onchain.vercel.app when it asks to sign
   a Squads v4 multisigCreateV2 transaction, partly signed by a one-time create key. Adding a
   spending limit and the kill (removing it) on the same page are not flagged.

   The page is open source: https://github.com/SharkWhite7/-DefiMind/tree/main/packages/onchain/web
   It builds each transaction from public addresses only, checks them onchain before asking the
   wallet to sign, and sends no funds to third parties. We would be grateful for a manual review.
   ```

2. **Phantom support** at [help.phantom.com](https://help.phantom.com), "contact us", with the same
   text, if the issue gets no answer within a week.

A dedicated domain for the page, instead of a Vercel subdomain, is the other half of the fix. Open
for later.

---

## ⏳ HUMAN-29 — Decide on a paid human audit before the panel's mainnet launch (decision)

The CR-012 security review (INT-31) is done by AI reviewers. It is not an audit, and DefiMind must
not be described as audited. Whether to pay for a human audit before the panel controls mainnet funds
is the owner's decision: which firm, what scope, what cost. Until then, the public wording stays
"reviewed", never "audited".

---

## ⏳ HUMAN-31 — Run the infrastructure migration

CR-012, CR-013 and CR-016 are complete in code, so the move of the live deployment to this repository
can start. The runbook is [`docs/migration.md`](../docs/migration.md) (Parts A to F, with a rollback); the manager walks the owner through it one step at a time, and the integrator helps when a check fails; HUMAN-24, HUMAN-27, HUMAN-28 and HUMAN-30 were done in Parts A and B (2026-11-19). Progress: A, B and C1–C4 passed (the old apps are stopped, not destroyed; the database is on `defimind-guard-core`). The owner decided on 2026-11-20 to drop Telegram and use the web panel only, so C5 (the bot deploy) is skipped. D1 (passkey enrolment) next. One rule from CR-016: the new bot app gets `BOT_TOKEN` only, never
`GUARD_ADMIN_TOKEN`. The signing page stays at `agentguard-onchain.vercel.app`; the migration creates no new domain.

---

## ⬜ HUMAN-32 — Retire the Telegram bot

The owner dropped Telegram on 2026-11-20: approvals and alerts go through the web panel only. At
HUMAN-31 F2, together with the old apps:

1. destroy the `defimind-bot` Fly app, which has staged secrets and no machine;
2. revoke the bot's token in BotFather, so the old token cannot be used by anyone.

Until CR-017 lands, guard-core still tries the bot hook on each event: it logs a warning, writes an
`approval_request_failed` audit row on each approval, and `doctor` reports the bot as down. Nothing
is lost: the panel's push goes out first.

---

## ⬜ HUMAN-33 — Verify the one-click deploy on Render (CR-019) — risk accepted, run optional

On 2026-11-20 the owner chose to ship the Deploy to Render button without a verified run, in his
words: "o render tá testado vamos usar mesmo assim eu aceito o risco ja deixa implementado se der
algum problema nos testamos novamente". The button is in the README (#72), and
`docs/getting-started.md` says the route is new and asks people to report a failing step. No
complete run on Render has been recorded yet.

Still useful, whenever the owner wants: one run from the button on a paid Starter instance with a
disk, or panel's free devnet variant (no disk), which proves every step up to "live" except
persistence. A failed step comes back through panel. No key is shared either way.

---

## ⬜ HUMAN-26 — Publish the packages to npm

Later. `create-defimind` and `@defimind/mcp-server` go to npm so users can install with one
command. Needs an npm account and an `defimind` npm organization. The manager sends the steps when
the packages are ready.

---

## ⬜ HUMAN-23 — Enroll a passkey for payment approvals (CR-010, phase 3)

When phase 3 is on `main`, larger approvals ask for a passkey (fingerprint or Face ID) on top of the
Telegram button. The manager sends the steps then.

---

## ⬜ HUMAN-6 — Tenderly account (optional)

Only if simulation needs a second provider. Not needed so far.

---

## Done

| id       | What                                                                              | When       | Record                                                               |
| -------- | --------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| HUMAN-1  | Repository created, sessions given write access                                   | 2026-11-03 | `SharkWhite7/-DefiMind`                                              |
| HUMAN-2  | Development environment: Node 22, pnpm, Foundry                                   | 2026-11-03 | —                                                                    |
| HUMAN-3  | Base test wallets                                                                 | 2026-11-03 | keys only in local `.env` files                                      |
| HUMAN-3B | Solana test keypairs                                                              | 2026-11-03 | keys only in mode-600 files outside the repository                   |
| HUMAN-4  | Devnet funds                                                                      | 2026-11-03 | —                                                                    |
| HUMAN-9  | Solana genesis hashes confirmed against the networks                              | 2026-11-03 | SVM-7                                                                |
| HUMAN-10 | Squads v4 program fixture for the onchain cap tests                               | 2026-11-04 | `8470861` on `fixture/squads-v4`                                     |
| HUMAN-5  | Telegram bot created                                                              | 2026-11-04 | —                                                                    |
| HUMAN-11 | First live run on Solana devnet: three payments, 3.5 USDC                         | 2026-11-04 | INT-3, INT-4                                                         |
| HUMAN-12 | Safe on Base Sepolia                                                              | 2026-11-05 | `0x1df91C7e227370F138Ae546f3D2fa2Fde8a48C2D`                         |
| HUMAN-13 | First live run on Base Sepolia, from an empty hot wallet                          | 2026-11-05 | INT-6, PR #63                                                        |
| HUMAN-14 | Phantom signing page hosted                                                       | 2026-11-06 | `https://agentguard-onchain.vercel.app`                              |
| HUMAN-15 | Devnet rehearsal with Phantom as owner: create, add limit, kill                   | 2026-11-07 | ADR 003                                                              |
| HUMAN-16 | Base hot wallet key moved to a file                                               | 2026-11-07 | PR #81                                                               |
| HUMAN-18 | Robinhood Chain USDG addresses confirmed against Paxos                            | 2026-11-07 | allowlist-only token rule                                            |
| HUMAN-17 | guard-core and the bot on Fly.io (devnet)                                         | 2026-11-08 | INT-7                                                                |
| HUMAN-19 | Bot redeployed with time-limited kill buttons                                     | 2026-11-08 | PRs #99, #100                                                        |
| HUMAN-20 | Robinhood Chain testnet run                                                       | 2026-11-08 | ✖️ no USDG faucet; replaced by HUMAN-21                              |
| HUMAN-21 | Real-money pilot on Robinhood Chain: 0.50 USDG x402 payment, then kill            | 2026-11-09 | `0xa9c7abffb5676651193e866e4f02d9925a72c100ba20972226075dad78083d86` |
| HUMAN-7  | Deploy accounts                                                                   | 2026-11-08 | Fly.io (D3), done as HUMAN-17                                        |
| HUMAN-8  | Mainnet decisions D1–D8 and the written go-ahead to launch                        | 2026-11-09 | `LAUNCH.md` §1                                                       |
| HUMAN-22 | Launch: Robinhood Chain and Solana mainnet, repository public, `main` protected   | 2026-11-09 | `LAUNCH.md`, PR #139                                                 |
| HUMAN-24 | Receipt signing key created and set on `defimind-guard-core` (HUMAN-31 A4, B3)    | 2026-11-19 | never printed; `/v1/receipts/key` serves the public key              |
| HUMAN-30 | Anchoring keypair created, funded with 2 devnet SOL, set on `defimind-guard-core` | 2026-11-19 | fee-only, never the hot wallet                                       |
| HUMAN-27 | Web Push (VAPID) key created and set on `defimind-guard-core`                     | 2026-11-19 | HUMAN-31 A4, B3                                                      |
| HUMAN-28 | `SIGN_PAGE_URL` set on `defimind-guard-core` from the bot's live value            | 2026-11-19 | `agentguard-onchain.vercel.app`                                      |
