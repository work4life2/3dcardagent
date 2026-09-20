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
  process.stdout.write(`Wallet: ${who.wallet ?? who.address ?? "?"}${who.handle ? `  @${who.handle}` : ""}  chain: ${getConfig().termix.chain}\n`);
  const res = await t.agents();
  if (!res.items?.length) {
    process.stdout.write("This wallet owns no agents. Run `npm run setup -- mint <name> \"<display name>\"` to mint one (needs gas). Note: key mode is a standalone identity and cannot see agents registered under a website account.\n");
    return;
  }
  process.stdout.write("Agents you can host:\n");
  for (const a of res.items) process.stdout.write(`  ${a.agentId}  #${a.agentTokenId ?? "-"}  ${a.name}  [${a.a2aStatus ?? "?"}]\n`);
  process.stdout.write("\nPut the chosen agentId into A2A_AGENT_ID in .env.\n");
}

export async function mintAgent(name: string, displayName: string): Promise<void> {
  const cfg = getConfig();
  const t = termix();
  process.stdout.write(`Minting agent "${name}" (chain ${cfg.termix.chain}; needs gas and a signature)...\n`);
  const prep = await t.api<{ contract: string; callData: string; to?: string }>("POST", "/api/v1/agents/prepare", {
    name,
    displayName,
    category: cfg.service.category,
    description: "AI-generated 3D holographic collectible cards: layered Blender scenes, foil & sparkle, interactive Three.js viewer.",
    tags: ["holographic-card", "3d", "design", "illustration", "blender", "three.js"],
  });
  const tx = await t.tx({ action: "registerAgent", contract: prep.contract ?? prep.to, callData: prep.callData, value: "0" }, { name });
  const hash = tx.results?.[0]?.txHash;
  process.stdout.write(`Broadcast tx ${hash}, waiting for the indexer...\n`);
  for (let i = 0; i < 40; i++) {
    const st = await t.get<{ status?: string; agentId?: string; id?: string }>(`/api/v1/agents/by-tx/${hash}`).catch(() => ({}) as { status?: string });
    if (st.status === "CONFIRMED") {
      process.stdout.write(`✅ Agent registered: ${JSON.stringify(st)}\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  process.stdout.write("Not indexed yet; check later with `npm run setup -- agents`.\n");
}

/** Create + publish the service listing (cover image is generated if none is supplied). */
export async function publishListing(agentId: string, coverPath?: string, updateId?: string): Promise<void> {
  const cfg = getConfig();
  const t = termix();
  let cover = coverPath ? path.resolve(coverPath) : undefined;
  if (!cover) {
    cover = path.join(cfg.dataDir, "listing-cover.png");
    if (!fs.existsSync(cover)) {
      process.stdout.write("Generating the cover image...\n");
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
  const description = `Custom AI-painted 3D holographic collectible card (Holo Card Studio).
Describe the character, pet or product you want in a sentence (reference image optional) and receive a real 3D foil card that shimmers as you tilt it:
• Self-contained interactive viewer: unzip, open index.html — drag to rotate, flip, sliders for the foil (works on mobile, nothing to install)
• High-resolution renders + the source layers (subject / background / lineart / text) + card-config.json
Default art direction: full-colour ukiyo-e composition with coloured sumi-e anime linework; any style on request. Two-state lenticular flip cards (A/B artwork) available.
Pricing: ${cfg.service.price} ${cfg.service.currency} per card, flat — 2 cards = ${Number(cfg.service.price) * 2}, 3 cards = ${Number(cfg.service.price) * 3} (a lenticular A/B card counts as two). Message the agent to get a quote for several cards.
Card text is written in the language of your brief. Typical turnaround: under an hour after funding.`;
  const tags = ["holographic-card", "trading-card", "3d", "blender", "illustration", "collectible", "holographic"];
  if (updateId) {
    await t.api("PATCH", `/api/v1/listings/${updateId}`, { title: cfg.service.title, description, tags, basePrice: cfg.service.price, deliveryDays: cfg.service.deliveryDays, coverImageUrl: coverUrl, coverImageAlt: "Holographic collectible card sample" });
    process.stdout.write(`✅ Updated listing ${updateId} (title, description, tags, price, cover).\n`);
    return;
  }
  const draft = await t.api<{ id: string; status?: string }>("POST", `/api/v1/agents/${agentId}/services`, {
    title: cfg.service.title,
    category: cfg.service.category,
    basePrice: cfg.service.price,
    currency: cfg.service.currency,
    deliveryDays: cfg.service.deliveryDays,
    description,
    skillTag: cfg.service.skillTag,
    tags,
    instantBuyable: true,
    publicSearch: true,
    coverImageUrl: coverUrl,
    coverImageAlt: "Holographic collectible card sample",
  });
  process.stdout.write(`Draft created: ${draft.id}\n`);
  await t.api("POST", `/api/v1/listings/${draft.id}/publish`);
  process.stdout.write(`✅ Published listing ${draft.id} (${cfg.service.price} ${cfg.service.currency}, ${cfg.service.deliveryDays}-day delivery, instant-buyable).\n`);
  // The referral banner on every shared card points at this listing, so a new id has to be copied
  // into the environment by hand — nothing here rewrites .env.
  process.stdout.write(`   Point shared cards at it: set LISTING_URL=https://www.agent.family/listing?id=${draft.id} in .env\n`);
}

export async function fullSetup(): Promise<void> {
  process.stdout.write("== Environment check ==\n");
  await installWebDeps().catch((e) => log.warn(String(e)));
  await ensureBlender().catch((e) => log.warn(String(e)));
  exposeLocalBin();
  const checks = await runDoctor({ network: true });
  printChecks(checks);
  const next = await termix().next().catch(() => undefined);
  if (next) process.stdout.write(`\nTermix status: ${JSON.stringify(next, null, 2).slice(0, 1500)}\n`);
  process.stdout.write(`
Next steps:
  1. put WALLET_KEY=0x… (dedicated hot wallet, small gas balance) and RELAY_API_KEY into .env.local
  2. npm run setup -- agents          # list this wallet's agents → put the id into A2A_AGENT_ID in .env (or setup -- mint <name> "<display name>")
  3. npm run setup -- listing         # publish the service listing (cover image is generated)
  4. npm run make -- "a cyberpunk mechanical cat card, edition No.007"   # build one card locally
  5. npm start                        # go online and start taking orders
`);
}
