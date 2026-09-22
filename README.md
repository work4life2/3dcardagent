# holo-card-agent

Sells **custom AI-generated 3D holographic collectible cards** as a service on [Termix](https://termix.ai), the on-chain marketplace where agents hire agents.

- Agent harness: [pi](https://pi.dev) (`@earendil-works/pi-coding-agent` SDK)
- Capability 1: [holo-card-studio](https://github.com/EverettFish/holo-card-studio) — four image layers → Blender holographic card → Three.js interactive viewer
- Capability 2: [termix-agent-skills](https://termix.ai/skills?v=1.8.0) v1.8.0 — hosting, orders, delivery, settlement
- Deployment: one long-running process (systemd / Docker) with an operator dashboard, health check and live gallery
- Scope: the service only touches orders sold by the hosted agent (`A2A_AGENT_ID`); other agents under the same wallet are ignored
- Language: everything the service produces is English by default; the card text and the delivery note follow the language of the buyer's brief

Both skills are vendored unchanged under `skills/`; pi loads them directly. The "built-in image-generation tool" the card skill assumes is provided by this project (`generate_image`, `edit_image`, `derive_lineart`, `chroma_key`, `inspect_image`, …).

## How it works

```
buyer messages the agent on Termix (brief, reference images) / buys the listing
        │
        ▼
aacp-watch.mjs wait  ──(polling is the presence heartbeat)──▶  events
        │
        ├─ chat.message ──▶ pi (chat model, no tools) drafts a reply from the server-side thread (text + images)
        │                   ──▶ a2a-runtime.mjs reply; when the brief is workable it also sends a **quote**
        │                   (POST /conversations/<id>/offers) whose scope is the consolidated brief — the buyer
        │                   accepts and funds it in the same conversation
        │
        └─ order.funded ──▶ 0. brief = order/offer scope + the buyer's conversation that led to the order
                               (their messages, our replies, their attached images as references)
                            1. provider-accept (on-chain)
                            2. pi (full tools + holo-card-studio skill) works in data/jobs/<id>/: paints the layers,
                               writes card-config.json, runs run_pipeline.py (Blender render + GLB + web viewer)
                            3. package: self-contained viewer (unzip → open index.html, no server) +
                               renders + source layers; DELIVERY.md becomes the delivery note → upload → delivery/submit (on-chain)
                            4. posts the delivery note in the order conversation
        sweep (every 5 min by default): accept missed orders / redo / claim-after-timeout once the challenge window ends
```

The marketplace lifecycle (accept, upload, sign, claim) is deterministic TypeScript; only painting and chatting go to a model. Jobs are persisted in `data/jobs/<id>/job.json`, so a restart resumes where it stopped.

On-chain calls go through `A2A_RPC_URL` (default for BSC: `https://bsc-dataseed.bnbchain.org`; the skill's own default node refuses receipt lookups without an API key). If a transaction is broadcast but the node never returns a receipt, the job is **not** failed: the backend's order status (`FUNDED` / `DELIVERED`) is what confirms it, and the sweep reconciles jobs whose delivery landed while the process was interrupted.

## Requirements

- Node.js ≥ 22
- Python 3 + Pillow; `fontconfig` + a CJK font (`fonts-noto-cjk`); `zip`
- Blender: not required up front. `npm run setup` downloads the official portable 4.5 build (SHA-256 verified) into `data/blender/`; an installed Blender is reused
- A key for an OpenAI-compatible relay (New API style; default `RELAY_BASE_URL=https://www.cun.ai`, key in `RELAY_API_KEY` in `.env.local`) — chat and image generation both default to it. Direct Anthropic / OpenAI / Gemini keys work too
- A dedicated hot wallet private key (`WALLET_KEY` in `.env.local`) with a little gas for on-chain accept / deliver / claim

## Quick start

```bash
git clone git@github.com:work4life2/3dcardagent.git && cd 3dcardagent
npm install --ignore-scripts
npm run build
cp .env.example .env           # chain, listing info; models already default to cost-effective picks
#   put RELAY_API_KEY=... and WALLET_KEY=0x... into .env.local (git-ignored)
npm run setup                  # pre-install three.js, download Blender, run the doctor
npm run setup -- agents        # list this wallet's agents → put the id into A2A_AGENT_ID in .env
#   no agent yet?  npm run setup -- mint <name> "<display name>"   (needs gas)
npm run setup -- listing       # publish the service listing (cover image is generated)
npm run make -- "a cyberpunk mechanical cat card, edition No.007"   # build one card locally, no marketplace
npm start                      # go online and take orders
```

`npm run doctor` checks the environment any time. `npm run pi` opens interactive pi with both skills and the image tools loaded, so you can operate Termix or build cards by hand in natural language.

### Identity: key mode, fully unattended

The service always uses Termix **key mode**: the hot wallet in `WALLET_KEY` signs order acceptance, delivery submission and post-challenge-window claims locally. No browser confirmation is ever needed.

- Fund the wallet with a small gas balance only (BNB on BSC). Earnings settle to that wallet's treasury per Termix rules.
- Key mode is a standalone identity: it cannot see agents registered under a Termix website account. Mint one under this wallet with `npm run setup -- mint`.
- Each chain (`AACP_CHAIN=bsc|base|rh`) is a separate marketplace: agents, orders and balances do not cross over.

### Switching models at runtime

Defaults live in `.env` (picked for cost-effectiveness). Switch at any time; new sessions pick it up immediately, no restart:

```bash
npm run model -- show                                   # effective build / chat / image / thinking
npm run model -- list [filter] [--refresh]              # live relay catalog (text + image models)
npm run model -- chat  relay/gpt-5.4-mini
npm run model -- build relay/claude-haiku-4-5
npm run model -- image gpt-image-2.5-flare
npm run model -- thinking medium
npm run model -- reset                                  # back to the .env defaults
```

Same thing in the dashboard at `http://<host>:8787/` or over HTTP: `GET /api/models`, `POST /api/models {"chatModel":"..."}` (loopback callers need nothing; remote callers send `x-admin-token: $ADMIN_TOKEN`). Overrides are stored in `data/runtime-config.json`.

The model picker is not hard-coded: `GET /api/models/options` pulls the live catalog from the relay (`GET $RELAY_BASE_URL/v1/models`, cached 10 min in `data/relay-models.json`) and merges in any non-relay providers pi has credentials for. The relay is not one of pi's built-in providers, so every text model on the catalog is registered in `data/pi-agent/models.json` under the `relay` provider: Claude models through the relay's Anthropic Messages endpoint (`/v1/messages`), everything else through OpenAI chat completions (`/v1/chat/completions`). Image models go through the relay's OpenAI Images API (`/v1/images/generations|edits`); only `gpt-image-*` models are routed there by the relay. The relay publishes no prices, so the picker shows none — check its pricing page. `?refresh=1` (or the dashboard's "Refresh model list" button) forces a re-fetch. The dashboard picker is a searchable list: focus the field to see the whole catalog grouped by vendor, type any words to filter on id or label, click or press Enter to choose.

### Token & cost tracking

```bash
npm run usage                    # per job / model / day (local ledger) + the relay's bill for this key
npm run jobs                     # each job with its token counts and cost
```

Two sources, shown side by side in the dashboard ("Usage & spend") and in `GET /api/usage`:

- **Local ledger** `data/usage.jsonl`: one line per model call, attributed to the job / conversation. pi language calls record exact token counts (input, output, cache read/write, reasoning); relay image calls record the token usage the relay returns. The relay publishes no prices, so relay models carry cost 0 here — the ledger answers "how many tokens did this card take", not "what did it cost".
- **Relay bill** (authoritative): `GET $RELAY_BASE_URL/v1/dashboard/billing/usage` for the last 30 days (`?days=N`) and the key's remaining quota from `/v1/dashboard/billing/subscription`. This is per key: give the agent its own relay key if the account is shared.

## Deployment

### Fresh cloud server (git clone + auto-deploy on push)

```bash
# on the server, as root — installs packages, Node 22, nginx, a 2 GB swapfile, clones the repo to /opt/holo-card-agent,
# registers the systemd service and a 1-minute timer that redeploys whenever origin/main moves
curl -fsSL https://raw.githubusercontent.com/work4life2/3dcardagent/main/deploy/server-bootstrap.sh \
  | DASH_USER=admin DASH_PASS='<password>' bash
# then: copy .env.local (WALLET_KEY, RELAY_API_KEY, A2A_AGENT_ID, …) to /opt/holo-card-agent/
sudo -u holocard bash -c 'cd /opt/holo-card-agent && npm run setup'     # three.js, Blender, doctor
systemctl start holo-card-agent
```

nginx listens on :80: only `/health` is public. The operator UI, `/cards/` gallery, renders and `/api/*` live under a
secret prefix (`DASHBOARD_PATH` in `.env.local`, e.g. `ops-<24 hex>`; the live one is in `pass/dashboard-path.txt`) behind
HTTP basic auth and a 10 req/s per-IP limit; every other path is a bare 404, so a visitor hitting the IP sees nothing.
fail2ban bans IPs that keep failing the auth or the limit; ufw allows 22/80/443 only; SSH is key-only.
Buyers are never given a link to this server (its address stays private); they receive the self-contained zip.
Push to `main` → `deploy/deploy.sh` runs within a minute (`npm ci`, build, restart, re-render nginx from `.env.local`);
`journalctl -u holo-card-autodeploy` shows each deploy, `deploy/deploy.sh --force` redeploys by hand.

### systemd (bare metal)

```bash
sudo deploy/install.sh /opt/holo-card-agent      # packages, Node 22, fonts, build, service registration
# edit /opt/holo-card-agent/.env and .env.local, then run setup / agents / listing as the service user
sudo systemctl start holo-card-agent && journalctl -fu holo-card-agent
```

### Docker

```bash
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml run --rm holo-card-agent setup
docker compose -f deploy/docker-compose.yml run --rm holo-card-agent setup listing
docker compose -f deploy/docker-compose.yml up -d
```

The container uses the host network; the gallery is on `:8787`. Both `.env` and `.env.local` are read.

### HTTP endpoints

All paths except `/health` are relative to `DASHBOARD_PATH` when it is set (the pages use `<base href>`).

| Path | Purpose |
|---|---|
| `/` | operator dashboard: status, runtime model switching (live priced catalog), usage & spend, jobs with cost and viewer / render / zip links |
| `/health` | health check (chain, agent) |
| `/cards/` | operator gallery of built cards; `/cards/<jobId>/` is the interactive Three.js viewer |
| `/api/jobs`, `/api/jobs/<id>` | job status |
| `/api/models` | read / switch models |
| `/api/models/options` | live model catalog (`?refresh=1` re-fetches) |
| `/api/usage` | tokens & cost: local per-job ledger + the relay's bill for this key (`?days=N`) |
| `/jobs/<id>/renders/hero.png` | render |

## Configuration

See `.env.example`. Highlights:

- `RELAY_BASE_URL` (default `https://www.cun.ai`) + `RELAY_API_KEY` (in `.env.local`): OpenAI-compatible relay for chat and images. `examples/relay/index.ts` is the minimal smoke test: `node --env-file=.env.local examples/relay/index.ts`.
- `PI_MODEL` / `PI_CHAT_MODEL`: `provider/model[:thinking]`. Defaults `relay/gemini-3-flash` (building) and `relay/gemini-2.5-flash-lite` (chat). Direct providers (`anthropic/claude-sonnet-4-5`, `openai/gpt-5-mini`, …) and an Anthropic-compatible relay (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` → provider `anthropic-proxy`) are supported.
- `IMAGE_PROVIDER=relay|openai|gemini|mock`, default `relay` with `RELAY_IMAGE_MODEL=gpt-image-2` (native transparent background); `mock` is for key-less dry runs only.
- `SERVICE_*`: listing title / price / currency / delivery days / category.
- `JOB_CONCURRENCY`, `JOB_TIMEOUT_MINUTES`, `SWEEP_INTERVAL_SECONDS`.
- `NOTIFY_WEBHOOK_URL`: delivery, failure and claim events are POSTed here (Slack, Feishu, Bark, …).

## Layout

```
src/
  index.ts            CLI: serve / setup / model / doctor / make / deliver / jobs / pi
  runtimeConfig.ts    runtime model overrides (data/runtime-config.json)
  termix/client.ts    wrapper over the termix-agent-skills scripts (login / wait / api / tx / upload / reply)
  agent/session.ts    pi SDK sessions: skill injection, AGENTS.md rules, custom tools, model resolution
  agent/tools.ts      image generate / edit / lineart / chroma key / inspect tools (defineTool)
  agent/imagegen.ts   relay (OpenAI Images API) / OpenAI Images / Gemini / mock back ends
  jobs/orderWorker.ts order lifecycle: accept → build → package → upload → submit → claim
  jobs/cardBuilder.ts runs the agent, verifies outputs, packages the deliverable
  jobs/chat.ts        buyer chat replies
  hosting/loop.ts     hosting loop + sweep
  server/http.ts      health + gallery + model API
skills/               both skills, vendored unchanged
tools/imgtool.py      Pillow helpers (inspect / lineart / chroma-key / mock)
examples/relay/       minimal relay smoke test (chat + image)
deploy/               Dockerfile, compose, systemd unit, install.sh
data/                 runtime data (jobs, conversations, credential caches, Blender)
```

## Notes

- Verified locally: relay text (tool use) and image generation (genuine alpha via gpt-image-2), the Blender pipeline, and a full `make` run driven by the model. Not yet exercised live: minting, publishing the listing and delivering a funded Termix order.
- Accepting and delivering are on-chain and cost gas; keep only a small balance in the hot wallet.
- There is no automatic settlement on Termix; the service claims escrow itself once the challenge window has passed.
- Skill update check: `cd data/termix && node ../../skills/termix-agent-skills/scripts/aacp-update.mjs check`.
