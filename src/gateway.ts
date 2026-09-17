import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";
import { logger } from "./log.js";

/**
 * Vercel AI Gateway management API: live model catalog (with prices), credit balance and
 * the authoritative spend report. Everything is cached briefly and degrades to `undefined`
 * / last-known data when the key is missing or the network is down.
 */

const log = logger("gateway");
const BASE = "https://ai-gateway.vercel.sh";
const CATALOG_TTL_MS = 10 * 60_000;
const SPEND_TTL_MS = 60_000;

export type GatewayModelType = "language" | "image" | "embedding" | "video" | "speech" | "transcription" | "realtime" | "reranking" | "evaluation";

export interface GatewayModel {
  /** e.g. google/gemini-3-flash */
  id: string;
  name: string;
  owned_by: string;
  type: GatewayModelType;
  context_window: number;
  max_tokens: number;
  tags?: string[];
  modalities?: { input: string[]; output: string[] };
  /** USD per token as decimal strings; image models may have `image` (per image) or nothing. */
  pricing?: Record<string, unknown> & { input?: string; output?: string; input_cache_read?: string; input_cache_write?: string; image?: string };
  released?: number;
}

export interface GatewayCatalog {
  fetchedAt: string;
  models: GatewayModel[];
}

export function gatewayKey(): string {
  return getConfig().image.gatewayKey || process.env.AI_GATEWAY_API_KEY || "";
}

/**
 * Every request this program sends to the Gateway is tagged, so the spend report can be filtered to
 * this agent alone (the report is otherwise team-wide: every key, every client). Override with
 * GATEWAY_REPORTING_TAG when several agents share one account.
 */
export function reportingTag(): string {
  return (process.env.GATEWAY_REPORTING_TAG || "holo-card-agent").trim();
}

/** Headers understood by the Gateway for attribution (`ai-reporting-tags`, `ai-reporting-user`). */
export function reportingHeaders(): Record<string, string> {
  const tag = reportingTag();
  return { "ai-reporting-tags": tag, "ai-reporting-user": tag };
}

function cacheFile(): string {
  return path.join(getConfig().dataDir, "gateway-models.json");
}

let catalogMem: GatewayCatalog | undefined;
let catalogInflight: Promise<GatewayCatalog | undefined> | undefined;

function readCatalogCache(): GatewayCatalog | undefined {
  if (catalogMem) return catalogMem;
  try {
    catalogMem = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as GatewayCatalog;
  } catch {
    /* no cache yet */
  }
  return catalogMem;
}

/** Live model list from GET /v1/models. Cached 10 min in memory and on disk (survives restarts / outages). */
export async function gatewayCatalog(opts: { force?: boolean } = {}): Promise<GatewayCatalog | undefined> {
  const cached = readCatalogCache();
  if (!opts.force && cached && Date.now() - Date.parse(cached.fetchedAt) < CATALOG_TTL_MS) return cached;
  const key = gatewayKey();
  if (!key) return cached;
  if (catalogInflight) return catalogInflight;
  catalogInflight = (async () => {
    try {
      const res = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data: GatewayModel[] };
      const fresh: GatewayCatalog = { fetchedAt: new Date().toISOString(), models: body.data };
      catalogMem = fresh;
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
      fs.writeFileSync(cacheFile(), JSON.stringify(fresh));
      log.info(`model catalog refreshed: ${fresh.models.length} models`);
      return fresh;
    } catch (err) {
      log.warn(`could not refresh model catalog: ${String(err)}${cached ? " (using cached list)" : ""}`);
      return cached;
    } finally {
      catalogInflight = undefined;
    }
  })();
  return catalogInflight;
}

/** USD per million tokens, or undefined when the gateway reports no price. */
export function perMillion(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== null && v !== "" ? Math.round(n * 1e6 * 1e4) / 1e4 : undefined;
}

export interface ModelOption {
  /** Value to put in the model field, e.g. vercel-ai-gateway/google/gemini-3-flash or openai/gpt-image-1-mini */
  id: string;
  name: string;
  /** Short human label for the picker: "$0.5 / $3 per M · 1000k ctx · tools, reasoning" */
  label: string;
  inputPerM?: number;
  outputPerM?: number;
  /** Per image in USD, for image models that price per image */
  perImage?: number;
  contextWindow?: number;
  tags?: string[];
  source: "gateway" | "pi";
}

/**
 * Image generators: dedicated `type: "image"` models plus Gemini-style language models that emit
 * images (`type: "language"`, tagged image-generation). Both work with `gateway.imageModel()`.
 */
export function isImageGenerator(m: GatewayModel): boolean {
  return m.type === "image" || (m.tags ?? []).includes("image-generation") || (m.modalities?.output?.includes("image") ?? false);
}

/** Text models usable by pi (text out, not an image generator). */
export function isTextModel(m: GatewayModel): boolean {
  return m.type === "language" && (m.modalities?.output?.includes("text") ?? false) && !isImageGenerator(m);
}

function perImagePrice(m: GatewayModel): number | undefined {
  const direct = Number(m.pricing?.image);
  if (m.pricing?.image && Number.isFinite(direct)) return direct;
  const table = m.pricing?.image_dimension_quality_pricing as Array<{ size?: string; cost?: string }> | undefined;
  const row = table?.find((r) => r.size === "default") ?? table?.[0];
  const n = Number(row?.cost);
  return row && Number.isFinite(n) ? n : undefined;
}

function describe(m: GatewayModel): { label: string; inputPerM?: number; outputPerM?: number; perImage?: number } {
  const inputPerM = perMillion(m.pricing?.input);
  const outputPerM = perMillion(m.pricing?.output);
  const perImage = perImagePrice(m);
  const image = isImageGenerator(m);
  const parts: string[] = [];
  if (perImage !== undefined) parts.push(`$${perImage} per image`);
  if (inputPerM !== undefined || outputPerM !== undefined) parts.push(`$${inputPerM ?? "?"} in / $${outputPerM ?? "?"} out per M${image ? " tokens" : ""}`);
  if (!parts.length) parts.push(image ? "price varies (see gateway)" : "no price listed");
  if (m.context_window && !image) parts.push(`${Math.round(m.context_window / 1000)}k ctx`);
  const tags = (m.tags ?? []).filter((t) => ["tool-use", "reasoning", "vision"].includes(t));
  if (tags.length && !image) parts.push(tags.join(", "));
  return { label: `${m.name} · ${parts.join(" · ")}`, inputPerM, outputPerM, perImage };
}

/** Gateway text models as pi ids (vercel-ai-gateway/<id>), sorted by id. */
export function languageOptions(catalog: GatewayCatalog | undefined): ModelOption[] {
  if (!catalog) return [];
  return catalog.models
    .filter(isTextModel)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({ id: `vercel-ai-gateway/${m.id}`, name: m.name, contextWindow: m.context_window, tags: m.tags, source: "gateway" as const, ...describe(m) }));
}

export function imageOptions(catalog: GatewayCatalog | undefined): ModelOption[] {
  if (!catalog) return [];
  return catalog.models
    .filter(isImageGenerator)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({ id: m.id, name: m.name, tags: m.tags, source: "gateway" as const, ...describe(m) }));
}

/* ---------- credits & spend (authoritative, from the gateway's own ledger) ---------- */

export interface GatewayCredits {
  balance: number;
  totalUsed: number;
}

export interface SpendRow {
  model?: string;
  day?: string;
  totalCost: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  requestCount?: number;
}

export interface GatewaySpend {
  fetchedAt: string;
  startDate: string;
  endDate: string;
  /** Tag this agent's requests carry; byModel/byDay are filtered to it. */
  tag: string;
  credits?: GatewayCredits;
  /** This agent only (requests tagged `tag`). */
  byModel: SpendRow[];
  byDay: SpendRow[];
  /** Whole team / account: every key and client, for comparison. */
  teamByModel: SpendRow[];
  teamTotal: number;
  error?: string;
}

let spendMem: GatewaySpend | undefined;
let spendInflight: Promise<GatewaySpend> | undefined;

/** AI SDK gateway client with this agent's attribution headers on every request. */
export async function gatewayClient() {
  const { createGateway } = await import("@ai-sdk/gateway");
  return createGateway({ apiKey: gatewayKey(), headers: reportingHeaders() });
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Credits + spend report for the last `days` days (default 30), grouped by model and by day. Cached 60 s. */
export async function gatewaySpend(days = 30): Promise<GatewaySpend> {
  if (spendMem && Date.now() - Date.parse(spendMem.fetchedAt) < SPEND_TTL_MS) return spendMem;
  if (spendInflight) return spendInflight;
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const tag = reportingTag();
  const base: GatewaySpend = { fetchedAt: new Date().toISOString(), startDate: day(start), endDate: day(end), tag, byModel: [], byDay: [], teamByModel: [], teamTotal: 0 };
  if (!gatewayKey()) return { ...base, error: "AI_GATEWAY_API_KEY missing" };
  spendInflight = (async () => {
    try {
      const g = await gatewayClient();
      const range = { startDate: base.startDate, endDate: base.endDate };
      const [credits, byModel, byDay, teamByModel] = await Promise.all([
        g.getCredits(),
        g.getSpendReport({ ...range, groupBy: "model", tags: [tag] }),
        g.getSpendReport({ ...range, groupBy: "day", tags: [tag] }),
        g.getSpendReport({ ...range, groupBy: "model" }),
      ]);
      spendMem = {
        ...base,
        credits: { balance: Number(credits.balance), totalUsed: Number(credits.totalUsed) },
        byModel: byModel.results.sort((a, b) => b.totalCost - a.totalCost),
        byDay: byDay.results.sort((a, b) => (a.day ?? "").localeCompare(b.day ?? "")),
        teamByModel: teamByModel.results.sort((a, b) => b.totalCost - a.totalCost),
        teamTotal: teamByModel.results.reduce((a, r) => a + r.totalCost, 0),
      };
      return spendMem;
    } catch (err) {
      log.warn(`spend report failed: ${String(err)}`);
      return spendMem ? { ...spendMem, error: String(err) } : { ...base, error: String(err) };
    } finally {
      spendInflight = undefined;
    }
  })();
  return spendInflight;
}
