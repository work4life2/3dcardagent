import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";
import { logger } from "./log.js";

/**
 * Local usage ledger: one JSON line per model call in DATA_DIR/usage.jsonl.
 *
 * - pi language calls: tokens come from the provider; cost is pi's estimate from its price
 *   table (source "pi-estimate").
 * - Relay image calls: the relay reports tokens but no price, so cost is 0 (source "none").
 *
 * The relay's own billing (src/relay.ts, `npm run usage`) is the authoritative bill; this ledger
 * is what lets us attribute calls to jobs and conversations, which the relay cannot do.
 */

const log = logger("usage");

export type UsageKind = "build" | "chat" | "image" | "other";

export interface UsageRecord {
  at: string;
  kind: UsageKind;
  jobId?: string;
  conversationId?: string;
  /** e.g. relay/gemini-3-flash or gpt-image-2 */
  model: string;
  provider: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  /** USD */
  cost: number;
  source: "pi-estimate" | "relay" | "none";
  generationId?: string;
  durationMs?: number;
}

export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
}

export interface UsageSummary {
  file: string;
  allTime: UsageTotals;
  today: UsageTotals;
  last7d: UsageTotals;
  last30d: UsageTotals;
  byKind: Record<string, UsageTotals>;
  byModel: Array<{ model: string } & UsageTotals>;
  byJob: Array<{ jobId: string } & UsageTotals>;
  byDay: Array<{ day: string } & UsageTotals>;
  recent: UsageRecord[];
}

export function usageFile(): string {
  return path.join(getConfig().dataDir, "usage.jsonl");
}

export function emptyTotals(): UsageTotals {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
}

export function addTo(t: UsageTotals, r: UsageRecord): UsageTotals {
  t.calls += 1;
  t.input += r.input || 0;
  t.output += r.output || 0;
  t.cacheRead += r.cacheRead || 0;
  t.cacheWrite += r.cacheWrite || 0;
  t.reasoning += r.reasoning || 0;
  t.cost += r.cost || 0;
  return t;
}

export function recordUsage(rec: Omit<UsageRecord, "at"> & { at?: string }): UsageRecord {
  const full: UsageRecord = { ...rec, at: rec.at ?? new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
    fs.appendFileSync(usageFile(), JSON.stringify(full) + "\n");
  } catch (err) {
    log.warn(`could not write usage record: ${String(err)}`);
  }
  log.info(`${full.kind} ${full.model}`, {
    job: full.jobId,
    in: full.input,
    out: full.output,
    cacheRead: full.cacheRead || undefined,
    cost: full.cost ? `$${full.cost.toFixed(5)}` : undefined,
    source: full.source,
  });
  return full;
}

export function readUsage(): UsageRecord[] {
  let text = "";
  try {
    text = fs.readFileSync(usageFile(), "utf8");
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as UsageRecord);
    } catch {
      /* skip torn line */
    }
  }
  return out;
}

export function jobUsage(jobId: string): UsageTotals {
  const t = emptyTotals();
  for (const r of readUsage()) if (r.jobId === jobId) addTo(t, r);
  return t;
}

export function summarizeUsage(records = readUsage()): UsageSummary {
  const now = Date.now();
  const todayKey = new Date().toISOString().slice(0, 10);
  const s: UsageSummary = {
    file: usageFile(),
    allTime: emptyTotals(),
    today: emptyTotals(),
    last7d: emptyTotals(),
    last30d: emptyTotals(),
    byKind: {},
    byModel: [],
    byJob: [],
    byDay: [],
    recent: records.slice(-25).reverse(),
  };
  const models = new Map<string, UsageTotals>();
  const jobs = new Map<string, UsageTotals>();
  const days = new Map<string, UsageTotals>();
  for (const r of records) {
    const t = Date.parse(r.at);
    addTo(s.allTime, r);
    if (r.at.slice(0, 10) === todayKey) addTo(s.today, r);
    if (now - t < 7 * 86_400_000) addTo(s.last7d, r);
    if (now - t < 30 * 86_400_000) addTo(s.last30d, r);
    addTo((s.byKind[r.kind] ??= emptyTotals()), r);
    addTo(models.get(r.model) ?? models.set(r.model, emptyTotals()).get(r.model)!, r);
    if (r.jobId) addTo(jobs.get(r.jobId) ?? jobs.set(r.jobId, emptyTotals()).get(r.jobId)!, r);
    const d = r.at.slice(0, 10);
    addTo(days.get(d) ?? days.set(d, emptyTotals()).get(d)!, r);
  }
  s.byModel = [...models].map(([model, t]) => ({ model, ...t })).sort((a, b) => b.cost - a.cost);
  s.byJob = [...jobs].map(([jobId, t]) => ({ jobId, ...t })).sort((a, b) => b.cost - a.cost);
  s.byDay = [...days]
    .map(([day, t]) => ({ day, ...t }))
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, 30);
  return s;
}

/* ---------- pi session hook ---------- */

export interface UsageContext {
  kind: UsageKind;
  jobId?: string;
  conversationId?: string;
}

/** Shape of pi's AssistantMessage that we read; kept loose so pi upgrades do not break the build. */
interface PiAssistantLike {
  role?: string;
  provider?: string;
  model?: string;
  responseId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    cost?: { total?: number };
  };
}

/**
 * Subscribe to a pi session and write one ledger line per assistant message.
 * Returns the unsubscribe function; also returns the running totals for the caller.
 */
export function trackSessionUsage(
  session: { subscribe(listener: (event: { type: string; message?: unknown }) => void): () => void },
  ctx: UsageContext,
): { totals: UsageTotals; unsubscribe: () => void } {
  const totals = emptyTotals();
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_end") return;
    const m = event.message as PiAssistantLike | undefined;
    if (!m || m.role !== "assistant" || !m.usage) return;
    const u = m.usage;
    if (!(u.input || u.output || u.cacheRead || u.cacheWrite)) return;
    const rec = recordUsage({
      kind: ctx.kind,
      jobId: ctx.jobId,
      conversationId: ctx.conversationId,
      model: `${m.provider ?? "?"}/${m.model ?? "?"}`,
      provider: m.provider ?? "?",
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      reasoning: u.reasoning,
      cost: u.cost?.total ?? 0,
      source: u.cost?.total ? "pi-estimate" : "none",
      generationId: m.responseId,
    });
    addTo(totals, rec);
  });
  return { totals, unsubscribe };
}

export function fmtUsd(n: number): string {
  if (!n) return "$0";
  return n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(3)}`;
}
