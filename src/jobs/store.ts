import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";

export type JobStatus =
  | "queued"
  | "accepting"
  | "building"
  | "built"
  | "delivering"
  | "delivered"
  | "settled"
  | "failed";

export interface JobArtifact {
  name: string;
  file: string;
  contentType: string;
  sizeBytes?: number;
  sha256?: string;
  artifactId?: string;
  url?: string;
}

export interface Job {
  id: string;
  /** Termix order id, or "local:<name>" for `make` runs. */
  orderId: string;
  conversationId?: string;
  status: JobStatus;
  brief: string;
  refs: string[];
  createdAt: string;
  updatedAt: string;
  attempts: number;
  redoRound: number;
  error?: string;
  dir: string;
  /**
   * Public page for this card on the share bucket, once published. Never this server: the online
   * preview that leaked the host's IP was removed in 2fdcf89 and stays removed.
   */
  shareUrl?: string;
  /** Set by jobs/prune.ts once dist/, web/, assets/ and card.blend were removed; only renders + metadata remain. */
  prunedAt?: string;
  artifacts: JobArtifact[];
  txHashes: Record<string, string>;
  notes: string[];
}

export interface OfferRecord {
  offerId: string;
  revisionId?: string;
  version?: number;
  price: string;
  currency: string;
  deliveryDays: number;
  scope: string;
  at: string;
  status: "active" | "accepted" | "withdrawn" | "superseded";
}

export interface ConversationLog {
  id: string;
  orderId?: string;
  kind?: string;
  /** Buyer identity as seen in the watch events (handle / display name / wallet). */
  buyer?: string;
  messages: Array<{ role: "buyer" | "agent"; text: string; at: string; messageId?: string; from?: string; refs?: string[] }>;
  /** Quotes we sent in this conversation (latest last). */
  offers?: OfferRecord[];
}

function jobsDir() {
  const d = path.join(getConfig().dataDir, "jobs");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function convDir() {
  const d = path.join(getConfig().dataDir, "conversations");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);

export function jobPath(id: string) {
  return path.join(jobsDir(), safe(id));
}

export function saveJob(job: Job): Job {
  job.updatedAt = new Date().toISOString();
  fs.mkdirSync(job.dir, { recursive: true });
  const file = path.join(job.dir, "job.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(job, null, 2));
  fs.renameSync(file + ".tmp", file);
  return job;
}

export function loadJob(id: string): Job | undefined {
  const file = path.join(jobPath(id), "job.json");
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Job;
}

export function listJobs(): Job[] {
  const out: Job[] = [];
  for (const name of fs.readdirSync(jobsDir())) {
    const j = loadJob(name);
    if (j) out.push(j);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function findJobByOrder(orderId: string): Job | undefined {
  return listJobs().find((j) => j.orderId === orderId);
}

export function createJob(init: { id: string; orderId: string; brief: string; refs?: string[]; conversationId?: string }): Job {
  const now = new Date().toISOString();
  const job: Job = {
    id: safe(init.id),
    orderId: init.orderId,
    conversationId: init.conversationId,
    status: "queued",
    brief: init.brief,
    refs: init.refs ?? [],
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    redoRound: 0,
    dir: jobPath(init.id),
    artifacts: [],
    txHashes: {},
    notes: [],
  };
  return saveJob(job);
}

export function loadConversation(id: string): ConversationLog {
  const file = path.join(convDir(), safe(id) + ".json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as ConversationLog;
  return { id, messages: [] };
}

export function saveConversation(c: ConversationLog): void {
  const file = path.join(convDir(), safe(c.id) + ".json");
  fs.writeFileSync(file, JSON.stringify(c, null, 2));
}
