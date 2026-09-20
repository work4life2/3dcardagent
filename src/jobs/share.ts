import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { run } from "../util/exec.js";
import { probePublicMode, putDirectory, putFile } from "../hosting/s3.js";
import { withShareMeta } from "../hosting/shareMeta.js";
import type { Job } from "./store.js";

const log = logger("share");

export interface ShareTarget {
  shareId: string;
  keyPrefix: string;
  /** Canonical page URL. Raw S3 serves no directory index, so it always ends in /index.html. */
  shareUrl: string;
  imageUrl: string;
}

/**
 * Where a job's public copy lives, or undefined when sharing is off.
 *
 * The id is derived rather than random so a redo overwrites the same prefix and the URL can be
 * recomputed at any time; it is salted so the public URL never leaks the Termix order id (job ids
 * are `order-<cuid>`, and one buyer should not be able to derive another's page from theirs).
 */
export function shareTarget(jobId: string): ShareTarget | undefined {
  const { share } = getConfig();
  if (!share.enabled) return undefined;
  const shareId = crypto.createHash("sha256").update(`${jobId}:${share.salt}`).digest("hex").slice(0, 12);
  const keyPrefix = `${share.keyPrefix}/${shareId}`;
  return {
    shareId,
    keyPrefix,
    shareUrl: `${share.baseUrl}/${keyPrefix}/index.html`,
    imageUrl: `${share.baseUrl}/${keyPrefix}/share.png`,
  };
}

/**
 * Write the share links into both copies of card-config.json, mirroring setViewerLang().
 *
 * Must run BEFORE buildStandaloneViewer(): that inlines web/card-config.json into embed.js and the
 * viewer reads the inlined copy, so anything written afterwards is silently ignored at runtime.
 */
export function setShareLinks(job: Job, config: Record<string, unknown>): void {
  const { share } = getConfig();
  const target = shareTarget(job.id);
  const fields: Record<string, unknown> = { listingUrl: share.listingUrl };
  if (target) fields.shareUrl = target.shareUrl;

  Object.assign(config, fields);
  for (const file of [path.join(job.dir, "card-config.json"), path.join(job.dir, "web", "card-config.json")]) {
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      Object.assign(json, fields);
      fs.writeFileSync(file, JSON.stringify(json, null, 2));
    } catch (err) {
      log.warn(`could not set share links in ${file}: ${String(err)}`);
    }
  }
  log.info(`job ${job.id}: share ${target ? target.shareUrl : "disabled (no S3 credentials)"}`);
}

/**
 * Compose the 1200x630 image X shows in the tweet, from the Blender hero render.
 * Best-effort: without it the tweet degrades to a plain link card.
 */
export async function renderShareImage(job: Job, hero: string | undefined, config: Record<string, unknown>): Promise<string | undefined> {
  if (!hero || !fs.existsSync(hero)) {
    log.warn(`job ${job.id}: no hero render, the shared tweet will have no image`);
    return undefined;
  }
  const cfg = getConfig();
  const out = path.join(job.dir, "dist", "share.png");
  const str = (key: string) => (typeof config[key] === "string" ? (config[key] as string) : "");
  const args = [
    path.join(cfg.toolsDir, "make_share_card.py"),
    out,
    hero,
    "--title",
    str("title") || job.id,
    "--lang",
    config.lang === "zh" ? "zh" : "en",
  ];
  if (str("subtitle")) args.push("--subtitle", str("subtitle"));
  if (str("edition")) args.push("--edition", str("edition"));

  const res = await run(process.env.PYTHON ?? "python3", args, { timeoutMs: 120_000 });
  if (res.code !== 0 || !fs.existsSync(out)) {
    log.error(`job ${job.id}: share image failed, the shared tweet will have no image: ${res.stderr.trim().slice(-300)}`);
    return undefined;
  }
  return out;
}

/**
 * Publish the hosted viewer so the buyer has something to post. Returns the page URL, or undefined
 * if anything went wrong — publishing must never take a delivery down with it.
 */
export async function publishCard(job: Job, hostedDir: string, shareImage: string | undefined, config: Record<string, unknown>): Promise<string | undefined> {
  const target = shareTarget(job.id);
  if (!target || !fs.existsSync(hostedDir)) return undefined;

  try {
    const mode = await probePublicMode(target.keyPrefix);
    if (!mode) return undefined;

    const title = (typeof config.title === "string" && config.title) || job.id;
    const lang = config.lang === "zh" ? "zh" : "en";
    const count = await putDirectory(hostedDir, target.keyPrefix, {
      mode,
      transform: (rel, body) =>
        rel === "index.html"
          ? Buffer.from(withShareMeta(body.toString("utf8"), { shareUrl: target.shareUrl, imageUrl: shareImage ? target.imageUrl : undefined, title, lang }), "utf8")
          : body,
    });
    if (shareImage) await putFile(shareImage, `${target.keyPrefix}/share.png`, mode);
    log.info(`job ${job.id}: published ${count} files to ${target.shareUrl}`);
    return target.shareUrl;
  } catch (err) {
    log.error(`job ${job.id}: publishing the shareable copy failed (the card is unaffected): ${String(err)}`);
    return undefined;
  }
}
