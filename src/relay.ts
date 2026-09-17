import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";
import { logger } from "./log.js";

/**
 * OpenAI-compatible relay (New API / one-api style, e.g. https://www.cun.ai): one key for chat
 * (OpenAI chat completions + Anthropic messages) and images (OpenAI Images API). This module
 * wraps the relay's management endpoints: the live model catalog (`GET /v1/models`, no prices)
 * and the OpenAI-compatible billing report (`/v1/dashboard/billing/*`). Everything is cached
 * briefly and degrades to `undefined` / last-known data when the key is missing or the
 * network is down.
 */

const log = logger("relay");
const CATALOG_TTL_MS = 10 * 60_000;
const SPEND_TTL_MS = 60_000;

/** pi provider id under which every relay model is registered (model ids: `relay/<id>`). */
export const RELAY_PROVIDER = "relay";

export interface RelayModel {
  /** e.g. gemini-3-flash, claude-haiku-4-5, gpt-image-2 */
  id: string;
  owned_by?: string;
  /** New API: which upstream protocols the model can be called with ("openai", "anthropic", …). */
  supported_endpoint_types?: string[] | null;
}

export interface RelayCatalog {
  fetchedAt: string;
  models: RelayModel[];
}

export function relayKey(): string {
  return getConfig().relay.apiKey;
}

export function relayBaseUrl(): string {
  return getConfig().relay.baseUrl;
}

function cacheFile(): string {
  return path.join(getConfig().dataDir, "relay-models.json");
}

let catalogMem: RelayCatalog | undefined;
let catalogInflight: Promise<RelayCatalog | undefined> | undefined;

function readCatalogCache(): RelayCatalog | undefined {
  if (catalogMem) return catalogMem;
  try {
    catalogMem = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as RelayCatalog;
  } catch {
    /* no cache yet */
  }
  return catalogMem;
}

/** Live model list from GET /v1/models. Cached 10 min in memory and on disk (survives restarts / outages). */
export async function relayCatalog(opts: { force?: boolean } = {}): Promise<RelayCatalog | undefined> {
  const cached = readCatalogCache();
  if (!opts.force && cached && Date.now() - Date.parse(cached.fetchedAt) < CATALOG_TTL_MS) return cached;
  const key = relayKey();
  if (!key) return cached;
  if (catalogInflight) return catalogInflight;
  catalogInflight = (async () => {
    try {
      const res = await fetch(`${relayBaseUrl()}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data: RelayModel[] };
      const models = (body.data ?? []).map((m) => ({ id: m.id, owned_by: m.owned_by, supported_endpoint_types: m.supported_endpoint_types ?? null }));
      const fresh: RelayCatalog = { fetchedAt: new Date().toISOString(), models };
      catalogMem = fresh;
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
      fs.writeFileSync(cacheFile(), JSON.stringify(fresh));
      log.info(`model catalog refreshed: ${fresh.models.length} models from ${relayBaseUrl()}`);
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

export interface ModelOption {
  /** Value to put in the model field, e.g. relay/gemini-3-flash or gpt-image-2 */
  id: string;
  name: string;
  /** Short human label for the picker */
  label: string;
  inputPerM?: number;
  outputPerM?: number;
  perImage?: number;
  contextWindow?: number;
  tags?: string[];
  source: "relay" | "pi";
}

/**
 * Image generators: gpt-image-* / dall-e-* go through the relay's OpenAI Images API (native alpha);
 * gemini-*-image models answer on chat completions with an inline image (no alpha, cheaper).
 */
export function isImageGenerator(m: RelayModel): boolean {
  return /^(gpt-image|dall-e)/i.test(m.id) || /^gemini.*-image/i.test(m.id);
}

/** Anthropic-native models (call them via /v1/messages so tool use and thinking work natively). */
export function isAnthropicModel(m: RelayModel): boolean {
  return (m.supported_endpoint_types ?? []).includes("anthropic") || /^claude/i.test(m.id);
}

/** Text models usable by pi: everything that is not an image generator or an obvious non-chat model. */
export function isTextModel(m: RelayModel): boolean {
  return !isImageGenerator(m) && !/(embedding|embed|tts|whisper|transcribe|rerank|imagen|-image|image-)/i.test(m.id);
}

/** Vendor guess for grouping in the picker; the relay reports most models as owned_by "openai". */
export function vendorOf(id: string): string {
  const l = id.toLowerCase();
  if (l.startsWith("claude")) return "anthropic";
  if (l.startsWith("gemini") || l.startsWith("imagen")) return "google";
  if (l.startsWith("gpt") || l.startsWith("o1") || l.startsWith("o3") || l.startsWith("o4") || l.startsWith("dall-e")) return "openai";
  if (l.startsWith("deepseek")) return "deepseek";
  if (l.startsWith("glm")) return "zai";
  if (l.startsWith("grok")) return "xai";
  if (l.startsWith("kimi") || l.startsWith("moonshot")) return "moonshotai";
  if (l.startsWith("minimax")) return "minimax";
  if (l.startsWith("qwen")) return "alibaba";
  return "other";
}

/** Relay text models as pi ids (relay/<id>), sorted by id. The relay publishes no prices. */
export function languageOptions(catalog: RelayCatalog | undefined): ModelOption[] {
  if (!catalog) return [];
  return catalog.models
    .filter(isTextModel)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({
      id: `${RELAY_PROVIDER}/${m.id}`,
      name: m.id,
      label: `${vendorOf(m.id)} · ${isAnthropicModel(m) ? "anthropic messages" : "openai chat"} · price: see relay`,
      tags: [vendorOf(m.id)],
      source: "relay" as const,
    }));
}

export function imageOptions(catalog: RelayCatalog | undefined): ModelOption[] {
  if (!catalog) return [];
  return catalog.models
    .filter(isImageGenerator)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({ id: m.id, name: m.id, label: `${vendorOf(m.id)} · ${/^gemini/i.test(m.id) ? "chat image, no alpha (chroma key)" : "images API, native alpha"} · price: see relay`, tags: [vendorOf(m.id)], source: "relay" as const }));
}

/* ---------- spend (OpenAI-compatible billing endpoints of the relay) ---------- */

export interface RelaySpend {
  fetchedAt: string;
  startDate: string;
  endDate: string;
  baseUrl: string;
  /** USD spent by this key in the date range (the relay reports `total_usage` in cents; converted here). */
  totalUsed?: number;
  /** Remaining quota in USD when the key has a limit; undefined for unlimited keys. */
  remaining?: number;
  error?: string;
}

let spendMem: RelaySpend | undefined;
let spendInflight: Promise<RelaySpend> | undefined;

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Spend for the last `days` days (default 30) plus the key's remaining quota. Cached 60 s. */
export async function relaySpend(days = 30): Promise<RelaySpend> {
  if (spendMem && Date.now() - Date.parse(spendMem.fetchedAt) < SPEND_TTL_MS) return spendMem;
  if (spendInflight) return spendInflight;
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const base: RelaySpend = { fetchedAt: new Date().toISOString(), startDate: day(start), endDate: day(end), baseUrl: relayBaseUrl() };
  const key = relayKey();
  if (!key) return { ...base, error: "RELAY_API_KEY missing" };
  spendInflight = (async () => {
    try {
      const headers = { authorization: `Bearer ${key}` };
      const [usageRes, subRes] = await Promise.all([
        fetch(`${base.baseUrl}/v1/dashboard/billing/usage?start_date=${base.startDate}&end_date=${base.endDate}`, { headers, signal: AbortSignal.timeout(20_000) }),
        fetch(`${base.baseUrl}/v1/dashboard/billing/subscription`, { headers, signal: AbortSignal.timeout(20_000) }),
      ]);
      if (!usageRes.ok) throw new Error(`billing/usage HTTP ${usageRes.status}`);
      const usage = (await usageRes.json()) as { total_usage?: number };
      const sub = subRes.ok ? ((await subRes.json()) as { hard_limit_usd?: number }) : {};
      const limit = Number(sub.hard_limit_usd);
      // OpenAI-compatible: `total_usage` is in cents (verified against cun.ai: two gpt-image-2 calls moved it by ~25).
      const totalUsed = Number(usage.total_usage) / 100;
      spendMem = {
        ...base,
        totalUsed: Number.isFinite(totalUsed) ? totalUsed : undefined,
        // New API reports an effectively infinite limit for unlimited keys.
        remaining: Number.isFinite(limit) && limit > 0 && limit < 1e7 ? limit : undefined,
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
