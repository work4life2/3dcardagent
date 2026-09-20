import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { run } from "../util/exec.js";
import { cardBuildGuidelines, cardBuildPrompt } from "../agent/prompts.js";
import { isChinese } from "../util/lang.js";
import { createCardSession } from "../agent/session.js";
import { pickDefaultFont } from "../agent/fonts.js";
import { getModels } from "../runtimeConfig.js";
import { buildStandaloneViewer } from "./standalone.js";
import { publishCard, renderShareImage, setShareLinks, shareTarget } from "./share.js";
import type { Job } from "./store.js";
import { saveJob } from "./store.js";

const log = logger("build");

export interface BuildOutputs {
  mode: "holographic" | "lenticular";
  blend: string;
  glb: string;
  hero?: string;
  renders: string[];
  webDir: string;
  deliveryMd?: string;
  config: Record<string, unknown>;
}

const REQUIRED = ["card.blend", "web/assets/card.glb", "web/index.html", "web/card-config.json"];

export function verifyOutputs(dir: string): { ok: boolean; missing: string[]; outputs?: BuildOutputs } {
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) return { ok: false, missing };
  const rendersDir = path.join(dir, "renders");
  const renders = fs.existsSync(rendersDir) ? fs.readdirSync(rendersDir).filter((f) => f.endsWith(".png")).map((f) => path.join(rendersDir, f)) : [];
  const hero = renders.find((r) => /hero/i.test(path.basename(r))) ?? renders[0];
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(dir, "card-config.json"), "utf8"));
  } catch {
    /* ignore */
  }
  const deliveryMd = path.join(dir, "DELIVERY.md");
  return {
    ok: true,
    missing: [],
    outputs: {
      mode: config.mode === "lenticular" ? "lenticular" : "holographic",
      blend: path.join(dir, "card.blend"),
      glb: path.join(dir, "web/assets/card.glb"),
      hero,
      renders,
      webDir: path.join(dir, "web"),
      deliveryMd: fs.existsSync(deliveryMd) ? deliveryMd : undefined,
      config,
    },
  };
}

/**
 * The viewer's own UI (buttons, hints, notes) follows the language the buyer used: the brief is
 * written in the buyer's language, so `lang` is derived from it and written into both copies of
 * card-config.json (project root and web/). The card text itself is authored by the model.
 */
export function setViewerLang(job: Job, config: Record<string, unknown>): void {
  const lang = isChinese(job.brief) ? "zh" : "en";
  config.lang = lang;
  for (const file of [path.join(job.dir, "card-config.json"), path.join(job.dir, "web", "card-config.json")]) {
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      if (json.lang === lang) continue;
      json.lang = lang;
      fs.writeFileSync(file, JSON.stringify(json, null, 2));
    } catch (err) {
      log.warn(`could not set lang in ${file}: ${String(err)}`);
    }
  }
  log.info(`job ${job.id}: viewer language ${lang}`);
}

/** Make the copied web viewer runnable by linking the pre-installed three.js dependency. */
export function linkWebDeps(webDir: string): void {
  const cfg = getConfig();
  const target = path.join(webDir, "node_modules");
  if (fs.existsSync(target)) return;
  const candidates = [
    path.join(cfg.holoSkillDir, "assets", "web-holographic", "node_modules"),
    path.join(cfg.holoSkillDir, "assets", "web-lenticular", "node_modules"),
    path.join(cfg.dataDir, "web-deps", "node_modules"),
  ];
  const src = candidates.find((c) => fs.existsSync(path.join(c, "three", "package.json")));
  if (!src) {
    log.warn("three.js is not pre-installed; run `npm run setup` (web viewer will need `npm install`)");
    return;
  }
  fs.symlinkSync(src, target, "dir");
}

async function downloadRefs(job: Job): Promise<string[]> {
  const refsDir = path.join(job.dir, "refs");
  const local: string[] = [];
  for (const [i, ref] of job.refs.entries()) {
    try {
      if (/^https?:\/\//.test(ref)) {
        const res = await fetch(ref, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = res.headers.get("content-type") ?? "";
        const ext = ct.includes("jpeg") || ct.includes("jpg") ? ".jpg" : ct.includes("webp") ? ".webp" : ".png";
        fs.mkdirSync(refsDir, { recursive: true });
        const file = path.join(refsDir, `ref-${i + 1}${ext}`);
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        local.push(path.relative(job.dir, file));
      } else if (fs.existsSync(ref)) {
        fs.mkdirSync(refsDir, { recursive: true });
        const file = path.join(refsDir, `ref-${i + 1}${path.extname(ref) || ".png"}`);
        fs.copyFileSync(ref, file);
        local.push(path.relative(job.dir, file));
      }
    } catch (err) {
      log.warn(`could not fetch reference ${ref}: ${String(err)}`);
    }
  }
  return local;
}

/**
 * Run the pi agent (with the holo-card-studio skill and the image tools) inside the job
 * directory until a verified card project exists. One retry with the failure fed back.
 */
export async function buildCard(job: Job, extraInstructions?: string): Promise<BuildOutputs> {
  const cfg = getConfig();
  fs.mkdirSync(job.dir, { recursive: true });
  const refs = await downloadRefs(job);
  const python = process.env.PYTHON ?? "python3";
  const font = await pickDefaultFont();
  if (!font) log.warn("no CJK font found (install fonts-noto-cjk); typography may fail");
  const guidelines = cardBuildGuidelines(cfg.holoSkillDir, python, font);
  const transcript = fs.createWriteStream(path.join(job.dir, "agent-transcript.log"), { flags: "a" });
  const deadline = Date.now() + cfg.jobs.timeoutMinutes * 60_000;

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    job.attempts += 1;
    saveJob(job);
    const session = await createCardSession({
      cwd: job.dir,
      guidelines,
      usage: { kind: "build", jobId: job.id },
      onText: (d) => transcript.write(d),
      onTool: (name, phase, detail) => {
        transcript.write(`\n[tool ${phase}] ${name} ${phase === "start" ? JSON.stringify(detail).slice(0, 400) : JSON.stringify(detail)}\n`);
        if (phase === "start") log.info(`job ${job.id}: tool ${name}`);
      },
    });
    const prompt =
      attempt === 1
        ? cardBuildPrompt(job.brief, refs, extraInstructions)
        : `The previous attempt did not produce a complete project. Problem: ${lastError}\n\nFix it and finish the build. The brief is unchanged:\n${job.brief}\n${extraInstructions ?? ""}`;
    const timer = setTimeout(() => void session.abort(), Math.max(60_000, deadline - Date.now()));
    try {
      log.info(`job ${job.id}: agent attempt ${attempt} started (model ${getModels().buildModel})`);
      await session.prompt(prompt);
    } finally {
      clearTimeout(timer);
      session.dispose();
    }
    const v = verifyOutputs(job.dir);
    if (v.ok && v.outputs) {
      setViewerLang(job, v.outputs.config);
      linkWebDeps(v.outputs.webDir);
      transcript.end();
      log.info(`job ${job.id}: build verified`, { mode: v.outputs.mode, renders: v.outputs.renders.length });
      return v.outputs;
    }
    lastError = `missing outputs: ${v.missing.join(", ")}` + (session.agent.state.errorMessage ? `; model error: ${session.agent.state.errorMessage}` : "");
    log.warn(`job ${job.id}: attempt ${attempt} incomplete — ${lastError}`);
    if (Date.now() > deadline) break;
  }
  transcript.end();
  throw new Error(lastError || "build failed");
}

/**
 * Build the deliverable: a folder that opens from disk (index.html at the root), plus the
 * renders, source layers and config — zipped. The Blender project stays in the job dir (not delivered).
 */
export async function packageJob(job: Job, out: BuildOutputs): Promise<{ zip: string; preview?: string; note?: string; share?: string }> {
  const distDir = path.join(job.dir, "dist");
  const pkg = path.join(distDir, "package");
  const hosted = path.join(distDir, "hosted");
  // Before packaging: buildStandaloneViewer inlines web/card-config.json into embed.js, and the
  // viewer reads that inlined copy — links written after this point never reach the buyer.
  setShareLinks(job, out.config);
  fs.rmSync(pkg, { recursive: true, force: true });
  fs.mkdirSync(pkg, { recursive: true });
  await buildStandaloneViewer(out.webDir, pkg, out.mode);
  const copyDir = (src: string, dest: string) => {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      const s = path.join(src, f);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dest, f));
    }
  };
  copyDir(path.join(job.dir, "renders"), path.join(pkg, "renders"));
  fs.copyFileSync(path.join(job.dir, "card-config.json"), path.join(pkg, "card-config.json"));
  fs.writeFileSync(
    path.join(pkg, "README.md"),
    `# Holo Card — ${String(out.config.title ?? job.id)}

## View the card
Open **index.html** in any modern browser (Chrome, Edge, Firefox, Safari) — no installation, no server.
Drag to rotate, F to flip, R to reset; the sliders tune the foil shimmer and parallax.

## Files
- index.html, embed.js, app.bundle.js, style.css   the interactive viewer (self-contained)
- assets/           source PNG layers (subject / background / lineart / text, or the A/B pair)
- renders/          rendered previews
- card-config.json  title, edition, rarity, parallax parameters
`,
  );
  const zip = path.join(distDir, `${job.id}-holo-card.zip`);
  if (fs.existsSync(zip)) fs.unlinkSync(zip);
  const res = await run("zip", ["-r", "-q", zip, "."], { cwd: pkg, timeoutMs: 10 * 60_000 });
  if (res.code !== 0) throw new Error(`zip failed: ${res.stderr.slice(-400)}`);

  // The public copy the buyer can post on X. Everything below is best-effort: a bucket problem
  // must never cost the buyer their card.
  let share: string | undefined;
  if (shareTarget(job.id)) {
    try {
      fs.rmSync(hosted, { recursive: true, force: true });
      await buildStandaloneViewer(out.webDir, hosted, out.mode, { embed: false });
      const image = await renderShareImage(job, out.hero, out.config);
      share = await publishCard(job, hosted, image, out.config);
    } catch (err) {
      log.error(`job ${job.id}: could not publish the shareable copy (the card is unaffected): ${String(err)}`);
    }
  }
  return { zip, preview: out.hero, note: out.deliveryMd, share };
}
