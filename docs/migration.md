# Moving to the DefiMind apps (HUMAN-31)

This runbook moves the live system from the `agentguard-guard-core` and `agentguard-bot` Fly apps to
`defimind-guard-core` and `defimind-bot`. Every step runs in bash on the owner's machine, one at a
time, in this order.

- **What moves.** The database moves across, so agents, tokens, policies, today's spend and the
  audit trail come along. The hot wallets and the onchain limits stay exactly as they are.
- **What is new.** The owner panel with its passkey, Web Push, signed receipts with anchoring, and
  the bot on its own token.
- **Downtime.** Agents are paused for about 15 minutes, in Part C.
- **What never changes.** The old apps are stopped, not deleted, until Part F, so a rollback is
  always possible.

**Rules for every step.**

- No key is typed, pasted or printed: each one goes from a file into a file or a Fly secret.
- What a step prints is safe to show: public keys, addresses, names, health answers.
- If a step's check fails, stop there and send the integrator the step number and what it printed.

The only values copied off the screen are the agent lines, in E1.

## Part A: prepare (nothing live changes)

**A1. The repository and tools.** This clones `~/DefiMind` if it is missing, or brings an
existing one up to date.

```bash
[ -d ~/DefiMind/.git ] || git clone https://github.com/SharkWhite7/-DefiMind.git ~/DefiMind
cd ~/DefiMind && git remote set-url origin https://github.com/SharkWhite7/-DefiMind.git && git checkout main && git pull && pnpm install
fly auth whoami && fly version && solana --version
```

Check: `fly auth whoami` prints the Fly account, and both version lines print.

**A2. The two `.env` files.** The old checkout's files are copied across, unless they are already
there. Three edits follow:

- the bot loses `GUARD_ADMIN_TOKEN` (CR-016);
- the bot's `GUARD_PUBLIC_URL` moves to the new address;
- guard-core gets a fresh `ADMIN_TOKEN`, because the old bot app still holds the old one.

```bash
cd ~/DefiMind && for p in guard-core telegram-bot; do [ -f packages/$p/.env ] || cp ~/AgentGuard/packages/$p/.env packages/$p/.env; chmod 600 packages/$p/.env; done
cd ~/DefiMind && (umask 077 && f=packages/telegram-bot/.env && grep -v -e '^GUARD_ADMIN_TOKEN=' -e '^GUARD_PUBLIC_URL=' "$f" > "$f.new" && echo 'GUARD_PUBLIC_URL=https://defimind-guard-core.fly.dev' >> "$f.new" && mv "$f.new" "$f")
cd ~/DefiMind && (umask 077 && f=packages/guard-core/.env && grep -v '^ADMIN_TOKEN=' "$f" > "$f.new" && printf 'ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" >> "$f.new" && mv "$f.new" "$f")
cd ~/DefiMind && grep -c '^GUARD_ADMIN_TOKEN=' packages/telegram-bot/.env; grep -c '^ADMIN_TOKEN=' packages/guard-core/.env
```

Check: the last line prints `0`, then `1`.

**A3. No receipt key on the old app.** This lists names only, never values.

```bash
fly secrets list --app agentguard-guard-core | grep -c RECEIPT_SIGNING_KEY
```

Check: it prints `0`. If it prints `1`, stop: receipts already exist under that key, and the
integrator has to plan how to keep them verifiable first.

**A4. The three new keys**, into `~/.defimind` (readable by the owner only). None of them is ever
printed.

- **HUMAN-24, receipt key.** Ed25519, signs every executed payment's receipt.
- **HUMAN-27, Web Push key.** P-256, signs the pushes to the panel.
- **HUMAN-30, anchoring key.** A Solana keypair for fees only, never the hot wallet. `--silent`
  keeps the seed phrase off the screen.

```bash
mkdir -p ~/.defimind && chmod 700 ~/.defimind
(umask 077 && node -e "const {generateKeyPairSync:g}=require('node:crypto');process.stdout.write(g('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))" > ~/.defimind/receipt.pem)
(umask 077 && node -e "const {generateKeyPairSync:g}=require('node:crypto');process.stdout.write(g('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'}))" > ~/.defimind/vapid.pem)
(umask 077 && solana-keygen new --no-bip39-passphrase --silent -o ~/.defimind/anchor.json)
ls -l ~/.defimind/receipt.pem ~/.defimind/vapid.pem ~/.defimind/anchor.json
```

Check: all three files are listed, each with `-rw-------`.

**A5. Fund the anchoring key on devnet.** The address is public.

```bash
solana airdrop 1 "$(solana-keygen pubkey ~/.defimind/anchor.json)" --url https://api.devnet.solana.com
solana balance "$(solana-keygen pubkey ~/.defimind/anchor.json)" --url https://api.devnet.solana.com
```

Check: the balance is `1 SOL`. If the airdrop is rate-limited, print the address with
`solana-keygen pubkey ~/.defimind/anchor.json`, request devnet SOL for it at
`https://faucet.solana.com`, then run the balance line again.

## Part B: the new apps, next to the old ones

**B1. Create the apps and the database volume,** in the old apps' org and region.

```bash
ORG="$(fly apps list | awk '$1=="agentguard-guard-core"{print $2}')" && echo "org: $ORG" && fly apps create defimind-guard-core --org "$ORG" && fly apps create defimind-bot --org "$ORG" && fly volumes create guard_data --app defimind-guard-core --region gru --size 1 --yes
```

Check: it prints the org name, then creates two apps and one volume.

**B2. guard-core's tokens, chain settings and hot keys,** copied from the old app.

- **Why not the `.env`.** The local `.env` can be the devnet one: the mainnet launch set its values
  straight in Fly. So the values come from the running `agentguard-guard-core`, through a pipe:
  - `env` runs inside the old machine;
  - only the named lines are kept, and they go straight into the new app's secrets;
  - nothing reaches the screen.
- **First, a dry count.** The first command counts the lines it would copy, without copying them.
- **ADMIN_TOKEN** is the one value taken from the `.env`: the fresh token from A2.

```bash
N='BOT_TOKEN|BOT_WEBHOOK_SECRET|SOLANA_CHAIN|SOLANA_RPC_URL|SQUADS_MULTISIG|SOLANA_HOT_WALLET_KEYPAIR_JSON|ROBINHOOD_CHAIN|ROBINHOOD_RPC_URL|ROBINHOOD_SAFE_ADDRESS|ROBINHOOD_HOT_WALLET_KEY'
fly ssh console --app agentguard-guard-core -C env | tr -d '\r' | grep -cE "^($N)="
```

Check: it prints `10`, when the old app runs Solana and Robinhood.

- The entrypoint hides the two hot keys from node only. They are still in the machine's
  environment, so the count includes them.
- If it prints `8`, the two hot-key lines are missing: stop. Do not fall back to the local key
  files without a digest check.

Then copy them, and add the fresh admin token:

```bash
fly ssh console --app agentguard-guard-core -C env | tr -d '\r' | grep -E "^($N)=" | fly secrets import --app defimind-guard-core --stage
cd ~/DefiMind && grep '^ADMIN_TOKEN=' packages/guard-core/.env | fly secrets import --app defimind-guard-core --stage
for a in agentguard-guard-core defimind-guard-core; do fly secrets list --app "$a" | awk -v n="^($N)$" 'NR>1 && $1 ~ n {print $1, $2}' | sort > ~/.defimind/"$a".digests; done; diff ~/.defimind/agentguard-guard-core.digests ~/.defimind/defimind-guard-core.digests && echo 'SAME VALUES'
```

Check: it prints `SAME VALUES`. Fly's digest is a hash of each value, so equal digests mean the
values were copied exactly, without either one being shown.

**B3. The three new keys.**

- The two PEM keys go in as multi-line values, between `"""` lines.
- The anchoring keypair goes in as one line of JSON.
- guard-core's entrypoint writes each one to tmpfs at boot, and nothing reaches the disk.

```bash
{ printf 'RECEIPT_SIGNING_KEY="""\n'; cat ~/.defimind/receipt.pem; printf '"""\n'; } | fly secrets import --app defimind-guard-core --stage
{ printf 'VAPID_PRIVATE_KEY="""\n'; cat ~/.defimind/vapid.pem; printf '"""\n'; } | fly secrets import --app defimind-guard-core --stage
{ printf 'ANCHOR_KEYPAIR_JSON='; tr -d ' \n' < ~/.defimind/anchor.json; echo; } | fly secrets import --app defimind-guard-core --stage
```

**B4. guard-core's public settings.** None of these values is a secret:

- the panel's passkey address;
- approvals in the panel only;
- the signing page (HUMAN-28);
- the Web Push contact;
- anchoring on devnet first.

guard-core links to the signing page the old bot already uses. First read that address from the
running bot. It is public:

```bash
SIGN="$(fly ssh console --app agentguard-bot -C 'printenv SIGN_PAGE_URL' | tr -d '\r' | grep -E '^https://')" && echo "$SIGN"
```

Check, before going on:

1. It prints one `https://…vercel.app` address. Today that is the `agentguard-onchain` project, the
   page Phantom already reviewed (HUMAN-25).
2. That address, opened with nothing after it, says "This link is not valid".
3. In the Vercel dashboard, that project is in the owner's account, and its production branch is
   `main`.

If any of the three fails, stop. A link to a project nobody holds could serve a fake signing page.
Then set the settings, with the signing page from that same command, in the same terminal:

```bash
fly secrets set --app defimind-guard-core --stage PASSKEY_RP_ID=defimind-guard-core.fly.dev PASSKEY_ORIGIN=https://defimind-guard-core.fly.dev TELEGRAM_APPROVALS=false "SIGN_PAGE_URL=$SIGN" VAPID_SUBJECT=https://github.com/SharkWhite7/-DefiMind ANCHOR_CHAIN=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 ANCHOR_RPC_URL=https://api.devnet.solana.com
fly secrets list --app defimind-guard-core
```

Check: the list shows these names and nothing else:

- `ADMIN_TOKEN`, `BOT_TOKEN`, `BOT_WEBHOOK_SECRET`;
- the chain settings B2 copied;
- `SOLANA_HOT_WALLET_KEYPAIR_JSON`, plus `ROBINHOOD_HOT_WALLET_KEY` if the old app had it;
- `RECEIPT_SIGNING_KEY`, `VAPID_PRIVATE_KEY`, `ANCHOR_KEYPAIR_JSON`;
- the seven names from B4.

**B5. Deploy guard-core.** It starts on an empty database with no agents, so it can sign nothing
yet. The old system keeps running.

```bash
cd ~/DefiMind && if grep -qx '\*\*/.env' .dockerignore; then fly deploy . --config packages/guard-core/fly.toml --dockerfile packages/guard-core/Dockerfile --ha=false; else echo 'STOP: the root .dockerignore must exclude **/.env'; fi
fly status --app defimind-guard-core && fly logs --app defimind-guard-core --no-tail | tail -n 30
curl -s https://defimind-guard-core.fly.dev/health; echo; curl -s -o /dev/null -w '%{http_code}\n' https://defimind-guard-core.fly.dev/v1/admin/chains; curl -s https://defimind-guard-core.fly.dev/v1/receipts/key; echo; curl -s -o /dev/null -w '%{http_code}\n' https://defimind-guard-core.fly.dev/panel/
```

Check:

- one machine is `started`, and the log shows no config error;
- `/health` answers. On an IPv4-only network a brand-new `*.fly.dev` name can resolve to IPv6
  only for a while, from resolver caching. If `fly ips list --app defimind-guard-core` shows a
  shared v4, wait a few minutes and try again;
- the admin route prints `404`, because it is not public;
- `/v1/receipts/key` prints a `publicKey`;
- the panel prints `200`.

**B6. The bot's secrets, and the "bot gets BOT_TOKEN only" check.**

> Only with Telegram. An owner who runs the panel alone skips B6 and C5, and runs F0 instead
> (CR-017).

- The values are copied from the running `agentguard-bot`, the same way as B2. The list of names
  leaves `GUARD_ADMIN_TOKEN` out.
- `GUARD_PUBLIC_URL` is set to the new address.
- `TELEGRAM_APPROVALS` is not copied, so the new bot runs on its default, `false`, like guard-core
  in B4. An old `true` would show Approve buttons that guard-core then refuses.
- Do not deploy the bot yet: two bots on one Telegram token make Telegram refuse both.

```bash
B='TELEGRAM_BOT_TOKEN|OWNER_TELEGRAM_IDS|GUARD_BOT_TOKEN|BOT_WEBHOOK_SECRET|NOTIFY_ABOVE_AMOUNT|SOLANA_CHAIN|SIGN_PAGE_URL|SQUADS_MULTISIG|SOLANA_HOT_WALLET_PUBKEY|ROBINHOOD_CHAIN|ROBINHOOD_SAFE_ADDRESS|REPORT_WEEKDAY|REPORT_HOUR_UTC'
fly ssh console --app agentguard-bot -C env | tr -d '\r' | grep -E "^($B)=" | fly secrets import --app defimind-bot --stage
fly secrets set --app defimind-bot --stage GUARD_PUBLIC_URL=https://defimind-guard-core.fly.dev
fly secrets list --app defimind-bot
fly secrets list --app defimind-bot | grep -c -e GUARD_ADMIN_TOKEN -e '^ADMIN_TOKEN'
```

Check:

- the list has `GUARD_BOT_TOKEN` and no admin token;
- the last line prints `0`.

If it prints anything else, remove the secret with
`fly secrets unset GUARD_ADMIN_TOKEN --app defimind-bot --stage`, then run the check again.

## Part C: the switch (agents paused, about 15 minutes)

**C1. Pause every agent** from Telegram, on the old bot. It still runs the old code with the admin
token, so `/agent list` and `/pause` work there as before. Send `/agent list`, then send
`/pause <id>` for each agent it lists. Then send `/status`, and keep its answer for C2.

**C2. A final backup of the old database,** copied to this machine and opened with the new code.

```bash
fly ssh console --app agentguard-guard-core -C "sh -c 'cd /srv/*/packages/guard-core && node --import tsx src/scripts/db-backup.ts /data/backups/migration.db'"
fly ssh sftp get /data/backups/migration.db ~/.defimind/migration.db --app agentguard-guard-core
chmod 600 ~/.defimind/migration.db && cd ~/DefiMind && pnpm --filter @defimind/e2e restore-drill ~/.defimind/migration.db
```

Check:

- every agent is listed, and `lastAudit` ends with the pauses from C1;
- the policies and today's spend match the `/status` from C1.

**C3. Stop the old apps.** The machines are stopped, not destroyed, so a rollback can start them
again. The bot goes first, so that no stale button reaches the old guard-core.

```bash
fly machine stop --app agentguard-bot $(fly machine list --app agentguard-bot -q)
fly machine stop --app agentguard-guard-core $(fly machine list --app agentguard-guard-core -q)
fly status --app agentguard-bot; fly status --app agentguard-guard-core
```

Check: every machine of both apps is `stopped`.

**C4. Put the database on the new guard-core.**

- The file goes in under a new name, `migrated.db`. The empty `guard.db` that B5 created is never
  overwritten while it is open.
- The file is handed to the app's user.
- `DATABASE_URL` then points at the file. A secret wins over the `fly.toml` value, and setting it
  restarts the machine cleanly.
- Leave that secret in place from now on.

```bash
fly ssh sftp put ~/.defimind/migration.db /data/migrated.db --app defimind-guard-core
fly ssh console --app defimind-guard-core -C "chown node:node /data/migrated.db"
fly secrets set DATABASE_URL=file:/data/migrated.db --app defimind-guard-core
fly status --app defimind-guard-core && fly logs --app defimind-guard-core --no-tail | tail -n 30 && curl -s https://defimind-guard-core.fly.dev/health; echo
```

Check:

- the machine is `started` again;
- the log shows no error after the restart;
- `/health` answers.

**C5. Deploy the new bot,** then finish the "bot gets BOT_TOKEN only" check.

> Only with Telegram: skip it for the panel alone, as in B6.

```bash
cd ~/DefiMind && if grep -qx '\*\*/.env' .dockerignore && [ ! -e packages/telegram-bot/Dockerfile.dockerignore ]; then fly deploy . --config packages/telegram-bot/fly.toml --dockerfile packages/telegram-bot/Dockerfile --ha=false; else echo 'STOP: the build context must use the root .dockerignore, and it must exclude **/.env'; fi
fly status --app defimind-bot && fly logs --app defimind-bot --no-tail | grep -c 'GUARD_ADMIN_TOKEN is set'
```

Check:

- one machine is `started`;
- the last line prints `0`, which means the bot did not find an admin token at startup.

Then, in Telegram:

1. `/status` shows each chain with its limit.
2. `/agent list` shows every agent, still paused.
3. `/policy <id>` shows that agent's policy. This is a read on the bot's own token.
4. `/resume <id>` answers "Do this in the DefiMind panel: it asks for your passkey." and resumes
   nothing. The bot can no longer loosen anything.

## Part D: the panel

**D1. Enrol the first passkey (HUMAN-23).** This prints a one-time link, good for ten minutes. It
runs as the app's user, so the database keeps one owner. The entrypoint gives the three key paths to the
server process only, so the command names them again for the script: without them guard-core's
config refuses `ANCHOR_CHAIN` and `VAPID_SUBJECT`.

```bash
fly ssh console --app defimind-guard-core -C "sh -c 'cd /srv/defimind/packages/guard-core && export RECEIPT_SIGNING_KEY_FILE=/run/defimind/receipt.pem VAPID_PRIVATE_KEY_FILE=/run/defimind/vapid.pem ANCHOR_KEY_FILE=/run/defimind/anchor.json && exec setpriv --reuid=\$(id -u node) --regid=\$(id -g node) --clear-groups -- node --import tsx src/scripts/passkey-code.ts'"
```

Open the link on the phone and save the passkey. Passkeys made for the old address do not work at
the new one: each passkey is bound to its address.

**D2. Install the panel.**

1. On the phone, open `https://defimind-guard-core.fly.dev/panel/` and sign in with the passkey.
2. Add the panel to the home screen.
3. In Settings, turn notifications on.

Check: Settings shows notifications on. A test push arrives when the next payment needs you.

## Part E: agents back on

**E1. Point each agent at the new address.**

First, find each agent in Claude Code's config. The command below prints three things per agent:
its id, its chain, and whether its token file is there. It never prints a token.

- An older manual setup may hold the token inline in the config instead of in a file. The command
  then moves it into `~/.agentguard/mcp/<id>.token`, readable by the owner only.
- `claude mcp get agentguard` is not used here: it would print an inline token.

```bash
node -e '
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
const servers = [cfg.mcpServers?.agentguard, ...Object.values(cfg.projects ?? {}).map((p) => p.mcpServers?.agentguard)].filter(Boolean);
if (servers.length === 0) console.log("STOP: no agentguard server in ~/.claude.json");
for (const { env = {} } of servers) {
  const file = env.AGENT_TOKEN_FILE ?? path.join(os.homedir(), ".agentguard", "mcp", `${env.AGENT_ID}.token`);
  if (!fs.existsSync(file) && env.AGENT_TOKEN) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, env.AGENT_TOKEN + "\n", { mode: 0o600 });
  }
  console.log(`AGENT=${env.AGENT_ID} CHAIN=${env.DEFAULT_CHAIN ?? ""} TOKEN_FILE=${file} ${fs.existsSync(file) ? "present" : "MISSING"}`);
}'
```

Check: each line ends with `present`.

- If a line says `MISSING`, stop for that agent. Its token is in neither place, and the integrator
  will help issue a new one for it.
- If the command says `STOP`, the agent runs in another client, not Claude Code. Stop and tell the
  integrator which client.

Then, for each line, run the steps below:

1. Copy the line's `AGENT=… CHAIN=… TOKEN_FILE=…` part, without the last word, into the shell.
2. Run the setup line. It saves the same token for the new address: the token came across with the
   database, and it is piped from its file, never typed.
3. Run the `claude mcp add …` command that setup prints.
4. Once every agent is done, remove the old server entry.

```bash
cd ~/DefiMind && pnpm --filter @defimind/mcp-server run setup claude-code --guard-url https://defimind-guard-core.fly.dev --agent-id "$AGENT" ${CHAIN:+--chain "$CHAIN"} --check < "$TOKEN_FILE"
claude mcp remove agentguard
```

Check: setup says `Saved the token to …/.defimind/mcp/<id>.token`, and `--check` passed.

**E2. Resume each agent in the panel,** in Agents, with the passkey.

**E3. Prove it works.**

1. Have one agent make one small payment. If the policy asks for it, approve it in the panel with
   the passkey.
2. In the panel's Executions, the payment has a receipt. Within an hour an anchor appears: a devnet
   transaction from the anchoring key.
3. Open the panel's Stop screen and check that it offers one Phantom link per chain. **Do not tap
   one:** on mainnet that is a real kill.
4. In Telegram, `/status` shows today's spend including the test payment.

Check the anchor transaction with this, while it runs:

```bash
solana transaction-history "$(solana-keygen pubkey ~/.defimind/anchor.json)" --url https://api.devnet.solana.com --limit 3
```

## Part F: afterwards

**F0. Without Telegram (CR-017).** For an owner who runs the panel only, this step drops the bot's
three settings from guard-core. It runs in two deploys, so guard-core never meets a partial set:

1. Deploy the CR-017 code with all three settings still present. `BOT_URL` now lives in the
   secrets instead of `fly.toml`.
2. Then unset all three together. The new code runs without any of them.

```bash
cd ~/DefiMind && git pull && fly secrets set --app defimind-guard-core --stage BOT_URL=http://defimind-bot.internal:8788
cd ~/DefiMind && fly deploy . --config packages/guard-core/fly.toml --dockerfile packages/guard-core/Dockerfile --ha=false
fly status --app defimind-guard-core && fly logs --app defimind-guard-core --no-tail | tail -n 20
```

Check: one machine is `started`, and the log shows no config error. Then unset the three:

```bash
fly secrets unset BOT_URL BOT_TOKEN BOT_WEBHOOK_SECRET --app defimind-guard-core
fly status --app defimind-guard-core && fly logs --app defimind-guard-core --no-tail | tail -n 20
```

Check:

- the machine restarts to `started`, with no config error;
- the log no longer shows `approval webhook failed` warnings;
- the panel's Doctor has no bot check.

An owner who keeps Telegram skips F0 and runs B6 and C5 instead.

**F1. Automatic deploys.** Each app's deploy token goes straight from flyctl into the `defimind`
environment's secrets, never into a variable. It needs the GitHub CLI, logged in with `gh auth login`.

```bash
fly tokens create deploy --app defimind-guard-core --expiry 8760h | gh secret set FLY_API_TOKEN_GUARD --env defimind --repo SharkWhite7/-DefiMind
fly tokens create deploy --app defimind-bot --expiry 8760h | gh secret set FLY_API_TOKEN_BOT --env defimind --repo SharkWhite7/-DefiMind
```

**F2. After one to two stable weeks,** retire the old apps:

1. Keep the final backup `~/.defimind/migration.db`.
2. Destroy the old apps:

   ```bash
   fly apps destroy agentguard-bot --yes && fly apps destroy agentguard-guard-core --yes
   ```

3. Archive the old repository and make it private.

**F3. Anchoring on mainnet,** once devnet has run cleanly.

1. Fund the anchoring key with a little real SOL.
2. Switch the settings:

   ```bash
   fly ssh console --app defimind-guard-core -C env | tr -d '\r' | grep '^SOLANA_RPC_URL=' | sed 's/^SOLANA_RPC_URL=/ANCHOR_RPC_URL=/' | fly secrets import --app defimind-guard-core --stage
   fly secrets set --app defimind-guard-core ANCHOR_CHAIN=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
   ```

## Rollback

**Before E2** (no agent resumed on the new apps). The old database has not changed since C2, so
going back is clean:

1. Stop the new apps:

   ```bash
   fly machine stop --app defimind-bot $(fly machine list --app defimind-bot -q)
   fly machine stop --app defimind-guard-core $(fly machine list --app defimind-guard-core -q)
   ```

2. Start the old apps, guard-core first:

   ```bash
   fly machine start --app agentguard-guard-core $(fly machine list --app agentguard-guard-core -q)
   fly machine start --app agentguard-bot $(fly machine list --app agentguard-bot -q)
   ```

3. If E1 already ran, put each agent back on the old address. Run setup from `~/AgentGuard`, then
   the command it prints:

   ```bash
   cd ~/AgentGuard && pnpm --filter @agentguard/mcp-server run setup claude-code --guard-url https://agentguard-guard-core.fly.dev --agent-id "$AGENT" ${CHAIN:+--chain "$CHAIN"} --replace < "$TOKEN_FILE"
   ```

4. Resume the agents with `/resume <id>` on the old bot.

**After E2.**

- Payments made since then exist only in the new database. Starting the old apps as they are would
  reset today's spend there. The onchain caps still bound every wallet, whichever app runs.
- First pause every agent in the panel, or with `/pause <id>`.
- Then ask the integrator: the new database goes back to the old app the same way it came, with
  C2 and C4 reversed.
