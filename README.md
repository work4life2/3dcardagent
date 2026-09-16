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
buyer buys the listing / sends a message on Termix
        │
        ▼
aacp-watch.mjs wait  ──(polling is the presence heartbeat)──▶  events
        │
        ├─ chat.message ──▶ pi (chat model, no tools) drafts a reply ──▶ a2a-runtime.mjs reply
        │
        └─ order.funded ──▶ 1. provider-accept (on-chain)
                            2. pi (full tools + holo-card-studio skill) works in data/jobs/<id>/: paints the layers,
                               writes card-config.json, runs run_pipeline.py (Blender render + GLB + web viewer)
                            3. package: self-contained viewer (unzip → open index.html, no server) +
                               renders + source layers; DELIVERY.md becomes the delivery note → upload → delivery/submit (on-chain)
                            4. posts the delivery note (with the online preview link) in the order conversation
        sweep (every 5 min by default): accept missed orders / redo / claim-after-timeout once the challenge window ends
```

The marketplace lifecycle (accept, upload, sign, claim) is deterministic TypeScript; only painting and chatting go to a model. Jobs are persisted in `data/jobs/<id>/job.json`, so a restart resumes where it stopped.

## Requirements

- Node.js ≥ 22
- Python 3 + Pillow; `fontconfig` + a CJK font (`fonts-noto-cjk`); `zip`
- Blender: not required up front. `npm run setup` downloads the official portable 4.5 build (SHA-256 verified) into `data/blender/`; an installed Blender is reused
- A [Vercel AI Gateway](https://vercel.com/ai-gateway) key (`AI_GATEWAY_API_KEY` in `.env.local`) — chat and image generation both default to it. Direct Anthropic / OpenAI / Gemini keys work too
- A dedicated hot wallet private key (`WALLET_KEY` in `.env.local`) with a little gas for on-chain accept / deliver / claim

## Quick start

```bash
git clone git@github.com:work4life2/3dcardagent.git && cd 3dcardagent
npm install --ignore-scripts
npm run build
cp .env.example .env           # chain, listing info; models already default to cost-effective picks
#   put AI_GATEWAY_API_KEY=... and WALLET_KEY=0x... into .env.local (git-ignored)
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
npm run model -- chat  vercel-ai-gateway/openai/gpt-5-mini
npm run model -- build vercel-ai-gateway/anthropic/claude-haiku-4.5
npm run model -- image google/gemini-3.1-flash-lite-image
npm run model -- thinking medium
npm run model -- reset                                  # back to the .env defaults
```

Same thing in the dashboard at `http://<host>:8787/` (models form with a list of every model your keys unlock) or over HTTP: `GET /api/models`, `POST /api/models {"chatModel":"..."}` (loopback callers need nothing; remote callers send `x-admin-token: $ADMIN_TOKEN`). Overrides are stored in `data/runtime-config.json`.

## Deployment

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

| Path | Purpose |
|---|---|
| `/` | operator dashboard: status, runtime model switching, jobs with viewer / render / zip links |
| `/health` | health check (chain, agent) |
| `/cards/` | gallery of delivered cards; `/cards/<jobId>/` is the interactive Three.js viewer |
| `/api/jobs`, `/api/jobs/<id>` | job status |
| `/api/models` | read / switch models |
| `/jobs/<id>/renders/hero.png` | render |

With `PUBLIC_BASE_URL` set (reverse-proxied to 8787), delivery notes and chat replies include the online preview link.

## Configuration

See `.env.example`. Highlights:

- `AI_GATEWAY_API_KEY` (in `.env.local`): Vercel AI Gateway for chat and images. `examples/ai-gateway/index.ts` is the minimal AI SDK example: `node --env-file=.env.local --experimental-strip-types examples/ai-gateway/index.ts`.
- `PI_MODEL` / `PI_CHAT_MODEL`: `provider/model[:thinking]`. Defaults `vercel-ai-gateway/google/gemini-3-flash` (building) and `vercel-ai-gateway/google/gemini-3.1-flash-lite` (chat); `.env.example` has a price table. Direct providers (`anthropic/claude-sonnet-4-5`, `openai/gpt-5-mini`, …) and an Anthropic-compatible relay (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` → provider `anthropic-proxy`) are supported.
- `IMAGE_PROVIDER=gateway|openai|gemini|mock`, default `gateway` with `GATEWAY_IMAGE_MODEL=openai/gpt-image-1-mini`; `mock` is for key-less dry runs only.
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
  agent/imagegen.ts   gateway / OpenAI Images / Gemini / mock back ends
  jobs/orderWorker.ts order lifecycle: accept → build → package → upload → submit → claim
  jobs/cardBuilder.ts runs the agent, verifies outputs, packages the deliverable
  jobs/chat.ts        buyer chat replies
  hosting/loop.ts     hosting loop + sweep
  server/http.ts      health + gallery + model API
skills/               both skills, vendored unchanged
tools/imgtool.py      Pillow helpers (inspect / lineart / chroma-key / mock)
examples/ai-gateway/  minimal AI SDK + gateway example
deploy/               Dockerfile, compose, systemd unit, install.sh
data/                 runtime data (jobs, conversations, credential caches, Blender)
```

## Notes

- Verified locally: gateway text and image generation (genuine alpha), the Blender pipeline, and a full `make` run driven by the model. Not yet exercised live: minting, publishing the listing and delivering a funded Termix order.
- Accepting and delivering are on-chain and cost gas; keep only a small balance in the hot wallet.
- There is no automatic settlement on Termix; the service claims escrow itself once the challenge window has passed.
- Skill update check: `cd data/termix && node ../../skills/termix-agent-skills/scripts/aacp-update.mjs check`.
