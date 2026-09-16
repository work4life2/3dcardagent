# holo-card-agent

把 **AI 3D 全息闪卡定制** 做成一个可以在 [Termix](https://termix.ai)（agent 雇 agent 的链上市场）上出售的服务。

- 底层 agent 框架：[pi](https://pi.dev)（`@earendil-works/pi-coding-agent` SDK）
- 能力 1：[holo-card-studio](https://github.com/EverettFish/holo-card-studio) —— 四层图 → Blender 全息卡 → Three.js 交互查看器
- 能力 2：[termix-agent-skills](https://termix.ai/skills?v=1.8.0) v1.8.0 —— 账号连接、托管上线、接单、交付、领款
- 部署形态：一个常驻进程（systemd / Docker），内置健康检查与在线预览画廊

两个 skill 都原样 vendor 在 `skills/` 下，pi 直接加载它们；pi 缺的"图像生成工具"由本项目补上（`generate_image` / `edit_image` / `derive_lineart` / `chroma_key` / `inspect_image` …）。

## 工作流程

```
买家在 Termix 购买 listing / 发消息
        │
        ▼
aacp-watch.mjs wait  ──(轮询即在线心跳)──▶  事件
        │
        ├─ chat.message ──▶ pi（聊天模型，无工具）起草回复 ──▶ a2a-runtime.mjs reply
        │
        └─ order.funded ──▶ 1. provider-accept（上链）
                            2. pi（完整工具 + holo-card-studio skill）在 data/jobs/<id>/ 生成四层图、
                               写 card-config.json、跑 run_pipeline.py（Blender 渲染 + GLB + 网页）
                            3. 打包 zip + card.blend + 预览图 + DELIVERY.md → 上传 → delivery/submit（上链）
                            4. 在订单会话里发交付说明（含在线预览链接）
        巡检（默认 5 分钟）：补漏接单 / redo 重做 / 挑战期过后 claim-after-timeout 领款
```

市场生命周期（接单、上传、上链、领款）由 TypeScript 确定性地执行，只有"创作"和"聊天"交给模型——便宜、可重试、可断点续传（任务状态持久化在 `data/jobs/<id>/job.json`）。

## 环境要求

- Node.js ≥ 22
- Python 3 + Pillow；`fontconfig` + 中文字体（`fonts-noto-cjk`）；`zip`
- Blender：不必手装，`npm run setup` 会下载官方便携版 4.5（SHA-256 校验）到 `data/blender/`；已装则直接复用
- 一把 [Vercel AI Gateway](https://vercel.com/ai-gateway) key（`npx vercel ai-gateway setup` 写入 `.env.local`），对话和生图默认都走它；也可以直接填 Anthropic / OpenAI / Gemini 的 key

## 快速开始

```bash
git clone <this repo> && cd 3dcardagent
npm install --ignore-scripts
npm run build
cp .env.example .env         # 填链、服务信息；模型默认已选好性价比款
npx vercel ai-gateway setup  # 把 AI_GATEWAY_API_KEY 写进 .env.local（git 已忽略）
npm run setup                # 预装 three.js、下载 Blender、体检
# 在 .env.local 放 WALLET_KEY=0x…（热钱包私钥）
npm run setup -- agents      # 列出钱包下的 agent → 把 id 写进 .env 的 A2A_AGENT_ID（没有则 setup -- mint）
npm run setup -- listing     # 发布服务 listing（自动生成封面图）
npm run make -- "一张赛博朋克机械猫闪卡，编号 No.007"   # 本地试跑一张，不接市场
npm start                    # 托管上线，开始接单
```

`npm run doctor` 随时体检；`npm run pi` 打开交互式 pi（两个 skill + 图像工具已加载），可以用自然语言操作 Termix 或手工做卡。

### 身份与签名（密钥模式，完全无人值守）

程序固定使用 Termix 的 **key 模式**：一个专用热钱包的私钥放在 `.env.local` 的 `WALLET_KEY`，接单、提交交付、挑战期后领款都由程序本地签名并广播，不需要人在浏览器确认。

- 钱包只充少量 gas（BSC 为 BNB），收入按 Termix 结算规则进入该钱包对应的 treasury。
- key 模式是独立身份，看不到你在 Termix 网站上注册的 agent；用 `npm run setup -- mint <name> "<显示名>"` 在这个钱包下铸造一个（需要 gas），再 `npm run setup -- agents` 拿到 id。
- 每条链（`AACP_CHAIN=bsc|base|rh`）是独立市场，agent、订单、余额互不相通。

### 运行时切换模型

模型默认值在 `.env`（按性价比选好），运行中可随时切换、立即对新会话生效，不用重启：

```bash
npm run model -- show                                   # 当前生效的 build / chat / image / thinking
npm run model -- chat  vercel-ai-gateway/openai/gpt-5-mini
npm run model -- build vercel-ai-gateway/anthropic/claude-haiku-4.5
npm run model -- image google/gemini-3.1-flash-lite-image
npm run model -- thinking medium
npm run model -- reset                                  # 回到 .env 默认
```

同样的操作也有 HTTP 接口：`GET /api/models`、`POST /api/models {"chatModel":"..."}`（本机回环直接可用，远程需带 `x-admin-token: $ADMIN_TOKEN`）。覆盖值保存在 `data/runtime-config.json`。

## 部署

### systemd（裸机）

```bash
sudo deploy/install.sh /opt/holo-card-agent      # 装依赖、Node 22、字体、构建、注册服务
# 编辑 /opt/holo-card-agent/.env，然后以服务用户执行 setup / agents / listing
sudo systemctl start holo-card-agent && journalctl -fu holo-card-agent
```

### Docker

```bash
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml run --rm holo-card-agent setup
docker compose -f deploy/docker-compose.yml run --rm holo-card-agent setup listing
docker compose -f deploy/docker-compose.yml up -d
```

容器用 host 网络，画廊在 `:8787`。

### HTTP 端点

| 路径 | 说明 |
|---|---|
| `/health` | 健康检查（含链、agent） |
| `/cards/` | 已交付卡片画廊；`/cards/<jobId>/` 是可交互的 Three.js 查看器 |
| `/api/jobs`、`/api/jobs/<id>` | 任务状态 |
| `/jobs/<id>/renders/hero.png` | 渲染图 |

配置 `PUBLIC_BASE_URL`（反代到 8787）后，交付说明和聊天回复里会带上在线预览链接。

## 配置速查

见 `.env.example`，重点：

- `AI_GATEWAY_API_KEY`（放 `.env.local`）：Vercel AI Gateway，一把 key 覆盖对话与生图。`examples/ai-gateway/index.ts` 是最小示例：`node --env-file=.env.local --experimental-strip-types examples/ai-gateway/index.ts`。
- `PI_MODEL` / `PI_CHAT_MODEL`：`provider/model[:thinking]`。默认按性价比选 `vercel-ai-gateway/google/gemini-3-flash`（做卡）和 `vercel-ai-gateway/google/gemini-3.1-flash-lite`（聊天），`.env.example` 里有价格对照表。也支持 `anthropic/claude-sonnet-4-5`、`openai/gpt-5-mini` 等直连；设置了 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 时自动注册 `anthropic-proxy` provider。
- `IMAGE_PROVIDER=gateway|openai|gemini|mock`，默认 `gateway`（Vercel AI Gateway，`GATEWAY_IMAGE_MODEL` 默认 `openai/gpt-image-1-mini`）；`mock` 仅用于无 API key 的联调。
- `SERVICE_*`：listing 的标题 / 价格 / 币种 / 交付天数 / 类目。
- `JOB_CONCURRENCY`、`JOB_TIMEOUT_MINUTES`、`SWEEP_INTERVAL_SECONDS`。
- `NOTIFY_WEBHOOK_URL`：交付、失败、领款等事件 POST 到这里（接 Bark / 飞书 / Slack 都行）。

## 目录

```
src/
  index.ts            CLI：serve / setup / doctor / make / deliver / jobs / pi
  termix/client.ts    封装 termix-agent-skills 的脚本（wait / api / tx / upload / reply）
  agent/session.ts    用 pi SDK 创建会话：注入 skill、AGENTS.md、自定义工具、模型
  agent/tools.ts      图像生成 / 编辑 / 线稿 / 抠图 / 检查工具（defineTool）
  agent/imagegen.ts   OpenAI Images / Gemini / mock 后端
  jobs/orderWorker.ts 订单生命周期：接单 → 生成 → 打包 → 上传 → 提交交付 → 领款
  jobs/cardBuilder.ts 跑 agent、校验产物、打包
  jobs/chat.ts        买家消息回复
  hosting/loop.ts     托管循环 + 巡检
  server/http.ts      健康检查 + 画廊
skills/               两个 skill 原样 vendor
tools/imgtool.py      Pillow 辅助（inspect / lineart / chroma-key / mock）
deploy/               Dockerfile、compose、systemd、install.sh
data/                 运行数据（任务、会话、凭据缓存、Blender）
```

## 注意事项

- `make` 用 `mock` 图像后端已在本机跑通全链路（LLM 驱动 skill → Blender → 打包）。真实订单请配置 `openai` 或 `gemini`。
- Termix 交付/接单是链上操作，需要 gas；热钱包只放少量资金。
- 挑战期没有自动结算，程序会在窗口结束后自动 `claim-after-timeout`。
- skill 升级：`cd data/termix && node ../../skills/termix-agent-skills/scripts/aacp-update.mjs check`。
