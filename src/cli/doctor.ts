import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { run } from "../util/exec.js";
import { imageProviderReady } from "../agent/imagegen.js";
import { modelRuntime, resolveModel } from "../agent/session.js";
import { termix } from "../termix/client.js";
import { getModels } from "../runtimeConfig.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fatal?: boolean;
}

export async function runDoctor(opts: { network?: boolean } = { network: true }): Promise<Check[]> {
  const cfg = getConfig();
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, fatal = true) => checks.push({ name, ok, detail, fatal });

  const node = process.versions.node;
  add("node", Number(node.split(".")[0]) >= 22, `v${node}`);
  const py = await run(process.env.PYTHON ?? "python3", ["-c", "import PIL,sys;print(sys.version.split()[0],'Pillow',PIL.__version__)"], { timeoutMs: 20_000 });
  add("python3 + Pillow", py.code === 0, py.code === 0 ? py.stdout.trim() : (py.stderr.trim().split("\n").pop() ?? "missing"));
  const npm = await run("npm", ["--version"], { timeoutMs: 20_000 });
  add("npm", npm.code === 0, npm.stdout.trim() || "missing");
  const zip = await run("zip", ["-v"], { timeoutMs: 10_000 });
  add("zip", zip.code === 0, zip.code === 0 ? "ok" : "missing (apt install zip)");
  const blender = await run("blender", ["--version"], { timeoutMs: 30_000 });
  const portable = fs.existsSync(path.join(cfg.dataDir, "blender"));
  add("blender", blender.code === 0 || portable, blender.code === 0 ? blender.stdout.split("\n")[0].trim() : "not on PATH — pipeline auto-downloads the official portable 4.5 build on first job", false);
  const fc = await run("fc-list", [":lang=zh", "file"], { timeoutMs: 20_000 });
  const cjk = fc.stdout.split("\n").filter(Boolean);
  add("CJK font", cjk.length > 0, cjk.length ? `${cjk.length} font(s), e.g. ${cjk[0].replace(/:\s*$/, "")}` : "none — install fonts-noto-cjk for Chinese card titles", false);
  add("skill: holo-card-studio", fs.existsSync(path.join(cfg.holoSkillDir, "SKILL.md")), cfg.holoSkillDir);
  add("skill: termix-agent-skills", fs.existsSync(path.join(cfg.termixSkillDir, "SKILL.md")), cfg.termixSkillDir);
  const three = ["web-holographic", "web-lenticular"].every((d) => fs.existsSync(path.join(cfg.holoSkillDir, "assets", d, "node_modules", "three", "package.json")));
  add("web viewer deps (three.js)", three, three ? "pre-installed" : "run `npm run setup` to pre-install", false);

  const img = imageProviderReady();
  add("image provider", img.ok, img.reason);

  try {
    const rt = await modelRuntime();
    const models = getModels();
    const { model } = await resolveModel(models.buildModel);
    const auth = await rt.checkAuth(model.provider);
    const ok = Boolean((auth as { available?: boolean; ok?: boolean }).available ?? (auth as { ok?: boolean }).ok ?? auth);
    add("LLM build model", ok, `${model.provider}/${model.id}${ok ? "" : " — no credentials (set the provider API key)"}`);
    const chat = await resolveModel(models.chatModel);
    const chatAuth = await rt.checkAuth(chat.model.provider);
    const chatOk = Boolean((chatAuth as { available?: boolean; ok?: boolean }).available ?? (chatAuth as { ok?: boolean }).ok ?? chatAuth);
    add("LLM chat model", chatOk, `${chat.model.provider}/${chat.model.id}`);
  } catch (err) {
    add("LLM model", false, String(err instanceof Error ? err.message : err));
  }

  if (!cfg.share.enabled) {
    add("share to X", false, "off — set the S3_* variables (and an https:// S3_URL) to publish a shareable page per card", false);
  } else if (opts.network !== false) {
    // Sharing only works if anonymous readers (X's crawler) can fetch the objects, which depends
    // on a bucket policy the upload credentials cannot inspect — so probe it for real.
    const { probePublicMode } = await import("../hosting/s3.js");
    const mode = await probePublicMode(`${cfg.share.keyPrefix}/_doctor`).catch((err) => {
      add("share bucket", false, `upload failed: ${String(err).slice(0, 160)}`, false);
      return "failed" as const;
    });
    if (mode !== "failed") {
      add("share to X", Boolean(mode), mode ? `${cfg.share.bucket} is publicly readable (${mode})` : "bucket is not publicly readable — see the policy printed above", false);
    }
  } else {
    add("share to X", true, `${cfg.share.bucket} (public read not probed: --no-network)`, false);
  }

  if (opts.network !== false) {
    const t = termix();
    add("termix wallet", cfg.termix.hasWalletKey, cfg.termix.hasWalletKey ? `key mode, chain ${cfg.termix.chain}` : "WALLET_KEY not set — put the provider hot-wallet private key in .env.local");
    if (cfg.termix.hasWalletKey) {
      const login = await t.login().catch((e) => ({ error: String(e) }));
      const l = login as { wallet?: string; address?: string; handle?: string; error?: string };
      add("termix login", !l.error, l.error ? l.error.split("\n").pop() ?? "failed" : `wallet ${l.wallet ?? l.address ?? ""} ${l.handle ? "@" + l.handle : ""}`.trim());
    }
    add("termix agent", Boolean(cfg.termix.agentId), cfg.termix.agentId || "A2A_AGENT_ID not set — run `npm run setup -- agents`");
    const cfgRes = await t.node("aacp-config.mjs", [], { timeoutMs: 60_000 });
    add("termix backend", cfgRes.code === 0, cfgRes.code === 0 ? `chain ${cfg.termix.chain} reachable` : cfgRes.stderr.trim().split("\n").pop() ?? "unreachable", false);
  }
  return checks;
}

export function printChecks(checks: Check[]): boolean {
  let ok = true;
  for (const c of checks) {
    const mark = c.ok ? "✅" : c.fatal ? "❌" : "⚠️ ";
    if (!c.ok && c.fatal) ok = false;
    process.stdout.write(`${mark} ${c.name.padEnd(28)} ${c.detail}\n`);
  }
  return ok;
}
