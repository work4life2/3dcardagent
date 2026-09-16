import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { run } from "../util/exec.js";
import { termix } from "../termix/client.js";
import { generateImage } from "../agent/imagegen.js";
import { printChecks, runDoctor } from "./doctor.js";

const log = logger("setup");

/** Pre-install the web viewer dependency once so every job can `--skip-npm`. */
export async function installWebDeps(): Promise<void> {
  const cfg = getConfig();
  for (const d of ["web-holographic", "web-lenticular"]) {
    const dir = path.join(cfg.holoSkillDir, "assets", d);
    if (fs.existsSync(path.join(dir, "node_modules", "three", "package.json"))) continue;
    log.info(`installing three.js for ${d}`);
    const res = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, timeoutMs: 10 * 60_000 });
    if (res.code !== 0) throw new Error(`npm install failed in ${dir}: ${res.stderr.slice(-500)}`);
  }
}

/** Download the portable Blender into DATA_DIR/blender (shared by all jobs) if none is on PATH. */
export async function ensureBlender(): Promise<string> {
  const cfg = getConfig();
  const onPath = await run("blender", ["--version"], { timeoutMs: 30_000 });
  if (onPath.code === 0) return "blender (PATH)";
  const shared = path.join(cfg.dataDir, "blender");
  fs.mkdirSync(shared, { recursive: true });
  const script = path.join(cfg.holoSkillDir, "scripts", "holographic", "ensure_blender.py");
  log.info("downloading official portable Blender 4.5 (checksum-verified) — this takes a few minutes");
  const res = await run(process.env.PYTHON ?? "python3", ["-c", `import sys;sys.path.insert(0,${JSON.stringify(path.dirname(script))});from ensure_blender import ensure_blender;print(ensure_blender(${JSON.stringify(shared)}))`], {
    timeoutMs: 30 * 60_000,
    onStderr: (s) => process.stderr.write(s),
  });
  if (res.code !== 0) throw new Error(`Blender download failed: ${res.stderr.slice(-600)}`);
  const exe = res.stdout.trim().split("\n").pop()!;
  // Expose it on PATH for child processes via a shim directory.
  const bin = path.join(cfg.dataDir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, "blender");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${exe}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return exe;
}

export function exposeLocalBin(): void {
  const bin = path.join(getConfig().dataDir, "bin");
  if (fs.existsSync(bin) && !(process.env.PATH ?? "").split(path.delimiter).includes(bin)) {
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  }
}

export async function listAgents(): Promise<void> {
  const t = termix();
  const who = (await t.login()) as { wallet?: string; address?: string; handle?: string };
  process.stdout.write(`钱包: ${who.wallet ?? who.address ?? "?"}${who.handle ? `  @${who.handle}` : ""}  链: ${getConfig().termix.chain}\n`);
  const res = await t.agents();
  if (!res.items?.length) {
    process.stdout.write("该钱包下没有 agent。运行 `npm run setup -- mint <name> \"<显示名>\"` 铸造一个（需要 gas）。注意：key 模式是独立身份，看不到网站账号下注册的 agent。\n");
    return;
  }
  process.stdout.write("可托管的 agent：\n");
  for (const a of res.items) process.stdout.write(`  ${a.agentId}  #${a.agentTokenId ?? "-"}  ${a.name}  [${a.a2aStatus ?? "?"}]\n`);
  process.stdout.write("\n把选中的 agentId 写入 .env 的 A2A_AGENT_ID。\n");
}

export async function mintAgent(name: string, displayName: string): Promise<void> {
  const cfg = getConfig();
  const t = termix();
  process.stdout.write(`准备铸造 agent "${name}"（链: ${cfg.termix.chain}，需要 gas 与签名）...\n`);
  const prep = await t.api<{ contract: string; callData: string; to?: string }>("POST", "/api/v1/agents/prepare", {
    name,
    displayName,
    category: cfg.service.category,
    description: "AI-generated 3D holographic collectible cards: layered Blender scenes, foil & sparkle, interactive Three.js viewer.",
    tags: ["holographic-card", "3d", "design", "illustration", "blender", "three.js"],
  });
  const tx = await t.tx({ action: "registerAgent", contract: prep.contract ?? prep.to, callData: prep.callData, value: "0" }, { name });
  const hash = tx.results?.[0]?.txHash;
  process.stdout.write(`已广播 tx ${hash}，等待索引...\n`);
  for (let i = 0; i < 40; i++) {
    const st = await t.get<{ status?: string; agentId?: string; id?: string }>(`/api/v1/agents/by-tx/${hash}`).catch(() => ({}) as { status?: string });
    if (st.status === "CONFIRMED") {
      process.stdout.write(`✅ agent 已注册: ${JSON.stringify(st)}\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  process.stdout.write("索引尚未确认，稍后用 `npm run setup -- agents` 查看。\n");
}

/** Create + publish the service listing (cover image is generated if none is supplied). */
export async function publishListing(agentId: string, coverPath?: string): Promise<void> {
  const cfg = getConfig();
  const t = termix();
  let cover = coverPath;
  if (!cover) {
    cover = path.join(cfg.dataDir, "listing-cover.png");
    if (!fs.existsSync(cover)) {
      process.stdout.write("生成封面图...\n");
      await generateImage({
        prompt:
          "Product hero image for a holographic collectible trading card studio: a single premium foil trading card standing at a slight angle on a clean white surface, rainbow holographic shimmer, gold frame, an ukiyo-e style koi dragon character painted with coloured sumi-e ink linework, subtle sparkles, soft studio lighting, no text.",
        outPath: cover,
        size: "1024x1024",
      });
    }
  }
  const size = fs.statSync(cover).size;
  const up = await t.api<{ uploadUrl: string; publicUrl?: string; url?: string }>("POST", "/api/v1/listings/media/upload-url", {
    fileName: path.basename(cover),
    contentType: "image/png",
    sizeBytes: size,
    purpose: "cover",
  });
  await t.upload(up.uploadUrl, cover, "image/png");
  const coverUrl = up.publicUrl ?? up.url;
  const preview = cfg.http.publicBaseUrl ? `在线预览画廊：${cfg.http.publicBaseUrl}/cards/\n` : "";
  const description = `AI 定制 3D 全息镭射闪卡（Holo Card Studio）。
一句话描述你想要的角色/宠物/产品（可附参考图），交付一张会随视角流光溢彩的 3D 闪卡：
• 可交互网页查看器（拖拽旋转、翻面、滑块调闪光，手机可玩）
• Blender 工程 card.blend（可继续调材质、灯光、重新渲染）
• 高清渲染图 + 四层源图（主体/背景/线稿/文字）+ card-config.json
默认画风：全彩浮世绘构图 + 彩色水墨动漫线稿；支持任意风格。支持"一念神魔"双图光栅翻转卡。
${preview}
Custom AI-painted 3D holographic collectible card: interactive Three.js viewer, editable Blender project, renders and source layers. Send a subject + style (reference image optional); two-state lenticular flip cards available. Typical turnaround: under an hour after funding.`;
  const draft = await t.api<{ id: string; status?: string }>("POST", `/api/v1/agents/${agentId}/services`, {
    title: cfg.service.title,
    category: cfg.service.category,
    basePrice: cfg.service.price,
    currency: cfg.service.currency,
    deliveryDays: cfg.service.deliveryDays,
    description,
    skillTag: cfg.service.skillTag,
    tags: ["holographic-card", "trading-card", "3d", "blender", "illustration", "闪卡", "全息卡"],
    instantBuyable: true,
    publicSearch: true,
    coverImageUrl: coverUrl,
    coverImageAlt: "Holographic collectible card sample",
  });
  process.stdout.write(`草稿已创建: ${draft.id}\n`);
  await t.api("POST", `/api/v1/listings/${draft.id}/publish`);
  process.stdout.write(`✅ 已发布 listing ${draft.id}（${cfg.service.price} ${cfg.service.currency}，${cfg.service.deliveryDays} 天交付，可直接购买）。\n`);
}

export async function fullSetup(): Promise<void> {
  process.stdout.write("== 环境检查 ==\n");
  await installWebDeps().catch((e) => log.warn(String(e)));
  await ensureBlender().catch((e) => log.warn(String(e)));
  exposeLocalBin();
  const checks = await runDoctor({ network: true });
  printChecks(checks);
  const next = await termix().next().catch(() => undefined);
  if (next) process.stdout.write(`\nTermix 状态: ${JSON.stringify(next, null, 2).slice(0, 1500)}\n`);
  process.stdout.write(`
下一步：
  1. 在 .env.local 里放 WALLET_KEY=0x…（专用热钱包私钥，充少量 gas）和 AI_GATEWAY_API_KEY
  2. npm run setup -- agents          # 列出该钱包的 agent，把 id 写入 .env 的 A2A_AGENT_ID（没有则 setup -- mint <name> "<显示名>"）
  3. npm run setup -- listing         # 发布服务 listing（自动生成封面）
  4. npm run make -- "一张赛博朋克机械猫闪卡，编号 No.007"   # 本地试跑一张卡
  5. npm start                        # 托管上线，开始接单
`);
}
