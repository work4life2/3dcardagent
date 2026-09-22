import fs from "node:fs";
import path from "node:path";
import { logger } from "../log.js";
import { listJobs, saveJob, type Job } from "./store.js";

const log = logger("prune");

/**
 * Disk hygiene for data/jobs. Every finished order leaves ~85 MB behind (dist/ and web/ are two
 * copies of the same site, plus card.blend and the source assets); nothing ever deleted them, so
 * the server would fill up after ~750 orders. This keeps the newest KEEP_FULL orders complete
 * and strips every older, finished one down to its renders and metadata:
 *   kept:    renders/, job.json and every other small top-level file (DELIVERY.md, *.json, logs)
 *   removed: dist/, web/, assets/, tools/, card.blend and any other top-level file over 1 MB
 * The buyer already has the zip and the public copy lives on the share bucket, so nothing that
 * is still needed lives only here. Pruned jobs stay in the dashboard list (render thumbnail still
 * works); their viewer/zip links stop working, which is expected.
 */
export const KEEP_FULL = 100;
const KEEP_DIR = "renders";
const SMALL_FILE_BYTES = 1024 * 1024;
const FINISHED: ReadonlySet<Job["status"]> = new Set(["delivered", "settled", "failed"]);

export interface PruneResult {
  pruned: string[];
  freedBytes: number;
}

function dirBytes(p: string): number {
  let total = 0;
  const st = fs.lstatSync(p);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) total += dirBytes(path.join(p, name));
  } else {
    total += st.size;
  }
  return total;
}

function pruneJob(job: Job): number {
  let freed = 0;
  for (const name of fs.readdirSync(job.dir)) {
    const p = path.join(job.dir, name);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) {
      if (name === KEEP_DIR) continue;
      freed += dirBytes(p);
      fs.rmSync(p, { recursive: true, force: true });
    } else if (st.size > SMALL_FILE_BYTES) {
      freed += st.size;
      fs.rmSync(p, { force: true });
    }
  }
  job.notes.push(`pruned ${new Date().toISOString()}: kept renders + metadata, freed ${(freed / 1048576).toFixed(1)} MB`);
  job.prunedAt = new Date().toISOString();
  saveJob(job);
  return freed;
}

/** Strip old finished jobs. Idempotent: already-pruned jobs are skipped. */
export function pruneOldJobs(keepFull = KEEP_FULL): PruneResult {
  const result: PruneResult = { pruned: [], freedBytes: 0 };
  // listJobs() is newest first.
  const older = listJobs().slice(keepFull);
  for (const job of older) {
    if (!FINISHED.has(job.status)) continue;
    if (job.prunedAt) continue;
    if (!fs.existsSync(job.dir)) continue;
    try {
      const freed = pruneJob(job);
      result.pruned.push(job.id);
      result.freedBytes += freed;
    } catch (err) {
      log.warn(`prune ${job.id} failed: ${(err as Error).message}`);
    }
  }
  if (result.pruned.length) {
    log.info(`pruned ${result.pruned.length} old job(s), freed ${(result.freedBytes / 1048576).toFixed(0)} MB`);
  }
  return result;
}

/** Run once now and then every hour while serving. */
export function startPruneSchedule(intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  const tick = () => {
    try {
      pruneOldJobs();
    } catch (err) {
      log.warn(`prune failed: ${(err as Error).message}`);
    }
  };
  tick();
  const t = setInterval(tick, intervalMs);
  t.unref();
  return t;
}
