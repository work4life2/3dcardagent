import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { notify } from "../notify.js";
import { sleep } from "../util/exec.js";
import { termix, type TxIntent } from "../termix/client.js";
import { buildCard, packageJob } from "./cardBuilder.js";
import { createJob, findJobByOrder, loadConversation, saveJob, type Job } from "./store.js";
import { postNotice } from "./chat.js";

const log = logger("order");

export interface Order {
  id: string;
  status: string;
  redoUsed?: boolean;
  deliveryDueAt?: string;
  challengeWindowEndsAt?: string;
  availableActions?: Record<string, boolean>;
  conversationId?: string;
  [k: string]: unknown;
}

const BRIEF_KEYS = new Set([
  "note", "brief", "requirements", "requirement", "scope", "description", "title", "message", "packageName", "package", "addons",
  "redoNote", "redoReason", "instructions", "details", "spec", "summary", "clientNote", "buyerNote",
]);

/** Collect every plausible brief field from the order payload (shape is backend-defined). */
export function extractBrief(order: Record<string, unknown>): { text: string; refs: string[] } {
  const lines: string[] = [];
  const refs = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (v: unknown, keyPath: string, depth: number) => {
    if (depth > 6 || v === null || v === undefined) return;
    if (typeof v === "string") {
      if (/^https?:\/\/\S+\.(png|jpe?g|webp)(\?\S*)?$/i.test(v.trim())) refs.add(v.trim());
      const last = keyPath.split(".").pop() ?? "";
      if (BRIEF_KEYS.has(last) && v.trim() && !/^(0x[0-9a-f]{40}|c[a-z0-9]{20,})$/i.test(v)) lines.push(`${keyPath}: ${v.trim()}`);
      return;
    }
    if (typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${keyPath}[${i}]`, depth + 1));
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/^(buyer|client|provider|seller|wallet|tx|signature|callData)$/i.test(k)) continue;
      walk(x, keyPath ? `${keyPath}.${k}` : k, depth + 1);
    }
  };
  walk(order, "", 0);
  // De-duplicate while preserving order.
  const uniq = [...new Set(lines)];
  return { text: uniq.join("\n"), refs: [...refs] };
}

function orderConversationId(order: Order): string | undefined {
  const c = order.conversationId ?? (order.conversation as { id?: string } | undefined)?.id;
  return typeof c === "string" ? c : undefined;
}

async function getOrder(orderId: string): Promise<Order> {
  const res = await termix().get<Order | { order: Order }>(`/api/v1/orders/${orderId}`);
  return ("order" in (res as object) && (res as { order: Order }).order ? (res as { order: Order }).order : (res as Order));
}

async function pollOrder(orderId: string, until: (o: Order) => boolean, timeoutMs = 10 * 60_000): Promise<Order> {
  const end = Date.now() + timeoutMs;
  let last = await getOrder(orderId);
  while (!until(last) && Date.now() < end) {
    await sleep(8000);
    last = await getOrder(orderId);
  }
  return last;
}

function intentFrom(res: unknown): TxIntent {
  const r = res as Record<string, unknown>;
  const candidate = (r.intent ?? r.txIntent ?? r.transaction ?? r) as TxIntent;
  if (!candidate.callData && !candidate.data) throw new Error(`no tx-intent in response: ${JSON.stringify(res).slice(0, 300)}`);
  return candidate;
}

async function acceptOrder(job: Job, order: Order): Promise<Order> {
  if (order.status !== "PENDING_ACCEPT") return order;
  job.status = "accepting";
  saveJob(job);
  log.info(`order ${order.id}: accepting on-chain`);
  const prep = await termix().api("POST", `/api/v1/orders/${order.id}/provider-accept/prepare`, {});
  const tx = await termix().tx(intentFrom(prep), { orderId: order.id });
  const hash = tx.results?.[0]?.txHash;
  if (hash) job.txHashes.acceptOrder = hash;
  saveJob(job);
  const o = await pollOrder(order.id, (x) => x.status === "FUNDED" || x.status === "IN_PROGRESS");
  if (o.status !== "FUNDED" && o.status !== "IN_PROGRESS") throw new Error(`order ${order.id} did not reach FUNDED/IN_PROGRESS after accept (status ${o.status})`);
  return o;
}

async function uploadArtifact(job: Job, file: string, contentType: string, label: string): Promise<string> {
  const tx = termix();
  const sizeBytes = fs.statSync(file).size;
  const fileName = path.basename(file);
  const up = await tx.api<{ uploadUrl: string; s3Key?: string; publicUrl?: string; url?: string; key?: string }>(
    "POST",
    `/api/v1/orders/${job.orderId}/delivery/upload-url`,
    { fileName, contentType, sizeBytes },
  );
  const uploaded = await tx.upload(up.uploadUrl, file, contentType);
  const reg = await tx.api<{ id?: string; artifactId?: string; artifact?: { id: string } }>("POST", `/api/v1/orders/${job.orderId}/delivery/artifacts`, {
    s3Key: up.s3Key ?? up.key,
    url: up.publicUrl ?? up.url,
    sha256: uploaded.sha256,
    contentType,
    sizeBytes,
  });
  const artifactId = reg.id ?? reg.artifactId ?? reg.artifact?.id;
  if (!artifactId) throw new Error(`artifact registration returned no id: ${JSON.stringify(reg).slice(0, 300)}`);
  job.artifacts.push({ name: label, file, contentType, sizeBytes, sha256: uploaded.sha256, artifactId, url: up.publicUrl ?? up.url });
  saveJob(job);
  log.info(`order ${job.orderId}: uploaded ${label} (${sizeBytes} bytes)`);
  return artifactId;
}

async function deliver(job: Job, pack: { zip: string; blend: string; preview?: string; note?: string }): Promise<void> {
  job.status = "delivering";
  job.artifacts = [];
  saveJob(job);
  const ids: string[] = [];
  ids.push(await uploadArtifact(job, pack.zip, "application/zip", "holo-card-project.zip"));
  ids.push(await uploadArtifact(job, pack.blend, "application/octet-stream", "card.blend"));
  if (pack.preview) ids.push(await uploadArtifact(job, pack.preview, "image/png", "preview.png"));
  if (pack.note) ids.push(await uploadArtifact(job, pack.note, "text/markdown", "DELIVERY.md"));
  const noteText = `Delivered: interactive web viewer + Blender project + renders.${job.previewUrl ? ` Online preview: ${job.previewUrl}` : ""}`;
  const submit = await termix().api("POST", `/api/v1/orders/${job.orderId}/delivery/submit`, { artifactIds: ids, note: noteText });
  const tx = await termix().tx(intentFrom(submit), { orderId: job.orderId });
  const hash = tx.results?.[0]?.txHash;
  if (hash) job.txHashes[job.redoRound ? `submitDelivery-redo${job.redoRound}` : "submitDelivery"] = hash;
  saveJob(job);
  const o = await pollOrder(job.orderId, (x) => x.status === "DELIVERED");
  if (o.status !== "DELIVERED") throw new Error(`order ${job.orderId} not DELIVERED after submit (status ${o.status})`);
  job.status = "delivered";
  saveJob(job);
}

function previewUrlFor(job: Job): string | undefined {
  const { http } = getConfig();
  return http.publicBaseUrl ? `${http.publicBaseUrl}/cards/${job.id}/` : undefined;
}

/**
 * Full lifecycle for one funded order: accept → build → package → upload → submit delivery.
 * Idempotent: re-running resumes from the persisted job state.
 */
export async function processOrder(orderId: string, opts: { redoNote?: string } = {}): Promise<Job> {
  let order = await getOrder(orderId);
  let job = findJobByOrder(orderId);
  const { text, refs } = extractBrief(order as Record<string, unknown>);
  if (!job) {
    const conv = orderConversationId(order);
    let brief = text;
    if (conv) {
      const log_ = loadConversation(conv);
      const buyerLines = log_.messages.filter((m) => m.role === "buyer").map((m) => m.text);
      if (buyerLines.length) brief += `\n\nBuyer messages in the order conversation:\n${buyerLines.join("\n")}`;
    }
    if (!brief.trim()) brief = "(The order carries no written brief. Design a striking original collectible card: choose an appealing fantasy character, default art direction, Chinese title text, edition 001/001.)";
    job = createJob({ id: `order-${orderId}`, orderId, brief, refs, conversationId: conv });
    log.info(`order ${orderId}: job created`, { refs: refs.length });
  }
  try {
    if ((opts.redoNote || order.redoUsed) && job.status === "delivered") {
      job.redoRound += 1;
      job.status = "queued";
      const redoLines = text.split("\n").filter((l) => /redo|note|change|修改/i.test(l)).join("\n");
      job.notes.push(`redo ${job.redoRound}: ${opts.redoNote ?? ""}\n${redoLines}`.trim());
      saveJob(job);
    }
    if (order.status === "PENDING_ACCEPT") order = await acceptOrder(job, order);
    if (!["FUNDED", "IN_PROGRESS"].includes(order.status)) {
      log.info(`order ${orderId}: status ${order.status}, nothing to do`);
      return job;
    }
    if (job.status === "queued" || job.status === "accepting" || job.status === "failed" || job.status === "building") {
      job.status = "building";
      job.error = undefined;
      saveJob(job);
      await notify("job.building", { orderId, jobId: job.id });
      const extra = job.redoRound ? `This is redo round ${job.redoRound}. Buyer's change request: ${opts.redoNote ?? job.notes.at(-1)}` : undefined;
      const outputs = await buildCard(job, extra);
      job.previewUrl = previewUrlFor(job);
      job.status = "built";
      saveJob(job);
      const pack = await packageJob(job, outputs);
      await deliver(job, pack);
    } else if (job.status === "built") {
      const v = await import("./cardBuilder.js").then((m) => m.verifyOutputs(job!.dir));
      if (!v.ok || !v.outputs) throw new Error("job marked built but outputs are missing");
      const pack = await packageJob(job, v.outputs);
      await deliver(job, pack);
    }
    if (job.status === "delivered") {
      await notify("job.delivered", { orderId, jobId: job.id, previewUrl: job.previewUrl, tx: job.txHashes });
      if (job.conversationId) {
        const msg = `✅ 您的闪卡已交付！${job.previewUrl ? `在线预览：${job.previewUrl}\n` : ""}交付包含：可交互网页查看器、Blender 工程 card.blend、渲染图与四层源图。请在订单页验收；如需修改，可在订单中提出一次修改请求（redo）。`;
        try {
          await postNotice(job.conversationId, msg);
        } catch (err) {
          log.warn(`could not post delivery notice: ${String(err)}`);
        }
      }
    }
    return job;
  } catch (err) {
    job.status = "failed";
    job.error = String(err instanceof Error ? err.message : err);
    saveJob(job);
    log.error(`order ${orderId}: failed — ${job.error}`);
    await notify("job.failed", { orderId, jobId: job.id, error: job.error });
    throw err;
  }
}

/** Claim escrow for DELIVERED orders whose challenge window has elapsed. */
export async function claimExpiredDeliveries(): Promise<number> {
  const tx = termix();
  const res = await tx.get<{ items?: Order[] } | Order[]>(`/api/v1/orders?side=provider`);
  const items = Array.isArray(res) ? res : (res.items ?? []);
  let claimed = 0;
  for (const o of items) {
    if (o.status !== "DELIVERED" || !o.challengeWindowEndsAt) continue;
    if (new Date(o.challengeWindowEndsAt).getTime() > Date.now()) continue;
    try {
      log.info(`order ${o.id}: challenge window elapsed, claiming`);
      const prep = await tx.api("POST", `/api/v1/orders/${o.id}/claim-after-timeout/prepare`, {});
      const r = await tx.tx(intentFrom(prep), { orderId: o.id });
      const job = findJobByOrder(o.id);
      if (job) {
        job.txHashes.claimAfterTimeout = r.results?.[0]?.txHash ?? "";
        job.status = "settled";
        saveJob(job);
      }
      claimed++;
      await notify("order.claimed", { orderId: o.id, tx: r.results?.[0]?.txHash });
    } catch (err) {
      log.warn(`order ${o.id}: claim failed — ${String(err)}`);
    }
  }
  return claimed;
}

/** Sweep provider orders: accept/build anything actionable that events may have missed. */
export async function sweepOrders(): Promise<string[]> {
  const tx = termix();
  const res = await tx.get<{ items?: Order[] } | Order[]>(`/api/v1/orders?side=provider`);
  const items = Array.isArray(res) ? res : (res.items ?? []);
  const actionable: string[] = [];
  for (const o of items) {
    const job = findJobByOrder(o.id);
    if (o.status === "PENDING_ACCEPT") actionable.push(o.id);
    else if ((o.status === "FUNDED" || o.status === "IN_PROGRESS") && (!job || ["queued", "failed", "built", "accepting"].includes(job.status))) actionable.push(o.id);
    else if (o.status === "IN_PROGRESS" && o.redoUsed && job?.status === "delivered") actionable.push(o.id);
    else if (o.status === "SETTLED" && job && job.status !== "settled") {
      job.status = "settled";
      saveJob(job);
    }
  }
  return actionable;
}
