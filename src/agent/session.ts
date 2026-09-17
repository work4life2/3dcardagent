import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { createHoloTools, HOLO_TOOL_NAMES } from "./tools.js";
import { getModels } from "../runtimeConfig.js";
import { gatewayCatalog, isTextModel, perMillion, reportingHeaders, type GatewayCatalog } from "../gateway.js";
import { trackSessionUsage, type UsageContext } from "../usage.js";

const log = logger("pi");
const GATEWAY_PROVIDER = "vercel-ai-gateway";
const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";

/**
 * If the operator uses an Anthropic-compatible relay (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN),
 * register it as a custom pi provider called `anthropic-proxy` in <agentDir>/models.json.
 */
export function ensureModelsJson(): void {
  const cfg = getConfig();
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "");
  const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const file = path.join(cfg.agentDir, "models.json");
  if (!baseUrl || !token) return;
  const wanted = new Set<string>();
  const models = getModels();
  for (const m of [models.buildModel, models.chatModel]) {
    const [provider, ...rest] = m.split("/");
    if (provider === "anthropic-proxy" && rest.length) wanted.add(rest.join("/").split(":")[0]);
  }
  if (wanted.size === 0) wanted.add("claude-sonnet-4-5");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* new file */
  }
  const providers = ((existing.providers as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  providers["anthropic-proxy"] = {
    baseUrl,
    api: "anthropic-messages",
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN ? "$ANTHROPIC_AUTH_TOKEN" : "$ANTHROPIC_API_KEY",
    // If the relay is the Gateway itself, tag the traffic like everything else we send there.
    ...(/ai-gateway\.vercel\.sh/.test(baseUrl) ? { headers: reportingHeaders() } : {}),
    models: [...wanted].map((id) => ({ id, reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000 })),
  };
  fs.writeFileSync(file, JSON.stringify({ ...existing, providers }, null, 2));
  log.info(`registered anthropic-proxy provider at ${baseUrl} in ${file}`);
}

/**
 * pi ships a static snapshot of the Gateway catalog. Models the Gateway added since then are
 * written into <agentDir>/models.json under the built-in `vercel-ai-gateway` provider (with the
 * Gateway's own prices), so anything on the live list can be selected. Returns the ids added.
 */
export function writeGatewayModelsJson(catalog: GatewayCatalog | undefined, known: Set<string>): { added: string[]; changed: boolean } {
  const cfg = getConfig();
  const file = path.join(cfg.agentDir, "models.json");
  let existing: { providers?: Record<string, unknown> } = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* new file */
  }
  const providers = { ...(existing.providers ?? {}) } as Record<string, unknown>;
  const before = JSON.stringify(providers[GATEWAY_PROVIDER] ?? null);
  // `known` comes from the running registry, which already includes our previous overlay; only ids
  // that are *not* from the overlay count as built-in.
  const overlayIds = new Set(((providers[GATEWAY_PROVIDER] as { models?: Array<{ id: string }> } | undefined)?.models ?? []).map((m) => m.id));
  const builtin = new Set([...known].filter((id) => !overlayIds.has(id)));
  const missing = (catalog?.models ?? []).filter((m) => isTextModel(m) && !builtin.has(m.id));
  // The overlay is always present: the attribution headers make every pi → Gateway request show up
  // under this agent's tag in the spend report. Auth still comes from AI_GATEWAY_API_KEY.
  const { models: _prevModels, ...operatorKeys } = (providers[GATEWAY_PROVIDER] as Record<string, unknown> | undefined) ?? {};
  providers[GATEWAY_PROVIDER] = {
    ...operatorKeys, // keep anything the operator added by hand (e.g. baseUrl, compat)
    headers: { ...(operatorKeys.headers as Record<string, string> | undefined), ...reportingHeaders() },
    ...(missing.length && {
      models: missing.map((m) => ({
        id: m.id,
        name: m.name,
        api: "anthropic-messages",
        baseUrl: GATEWAY_BASE_URL,
        reasoning: (m.tags ?? []).includes("reasoning"),
        input: (m.modalities?.input ?? ["text"]).filter((x) => x === "text" || x === "image"),
        cost: {
          input: perMillion(m.pricing?.input) ?? 0,
          output: perMillion(m.pricing?.output) ?? 0,
          cacheRead: perMillion(m.pricing?.input_cache_read) ?? 0,
          cacheWrite: perMillion(m.pricing?.input_cache_write) ?? 0,
        },
        contextWindow: m.context_window > 0 ? m.context_window : 128_000,
        maxTokens: m.max_tokens > 0 ? m.max_tokens : 16_384,
      })),
    }),
  };
  if (JSON.stringify(providers[GATEWAY_PROVIDER] ?? null) !== before) {
    fs.mkdirSync(cfg.agentDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...existing, providers }, null, 2));
    if (missing.length) log.info(`registered ${missing.length} gateway models pi did not know: ${missing.slice(0, 5).map((m) => m.id).join(", ")}${missing.length > 5 ? ", …" : ""}`);
  }
  return { added: missing.map((m) => m.id), changed: JSON.stringify(providers[GATEWAY_PROVIDER] ?? null) !== before };
}

let runtime: ModelRuntime | undefined;
let lastSyncedCatalogAt = "";

/** Pull the live Gateway catalog and make pi aware of new models. Safe to call often (catalog is cached). */
export async function syncGatewayModels(opts: { force?: boolean } = {}): Promise<void> {
  const rt = await modelRuntime();
  const catalog = await gatewayCatalog(opts);
  if (!catalog || (catalog.fetchedAt === lastSyncedCatalogAt && !opts.force)) return;
  lastSyncedCatalogAt = catalog.fetchedAt;
  // Built-in ids = whatever pi knows for the provider *before* our overlay is applied. Reading from
  // the runtime includes our own additions, so subtract those that came from models.json.
  const known = new Set(rt.getModels().filter((m) => m.provider === GATEWAY_PROVIDER).map((m) => m.id));
  const { changed } = writeGatewayModelsJson(catalog, known);
  if (changed) await rt.refresh();
}

export async function modelRuntime(): Promise<ModelRuntime> {
  if (runtime) return runtime;
  const cfg = getConfig();
  ensureModelsJson();
  runtime = await ModelRuntime.create({
    authPath: path.join(cfg.agentDir, "auth.json"),
    modelsPath: path.join(cfg.agentDir, "models.json"),
    modelsStorePath: path.join(cfg.agentDir, "models-store.json"),
  });
  await syncGatewayModels().catch((err) => log.warn(`gateway model sync failed: ${String(err)}`));
  return runtime;
}

export async function resolveModel(spec: string) {
  const rt = await modelRuntime();
  const r = resolveCliModel({ cliModel: spec, modelRuntime: rt });
  if (r.error || !r.model) throw new Error(`cannot resolve model "${spec}": ${r.error ?? "unknown"}`);
  if (r.warning) log.warn(r.warning);
  return { model: r.model, thinkingLevel: r.thinkingLevel };
}

function skillFrom(dir: string, source: string): Skill {
  const filePath = path.join(dir, "SKILL.md");
  const head = fs.readFileSync(filePath, "utf8").slice(0, 4000);
  const name = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? path.basename(dir);
  const description = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? "";
  return {
    name,
    description,
    filePath,
    baseDir: dir,
    disableModelInvocation: false,
    sourceInfo: { path: filePath, source, scope: "project", origin: "top-level", baseDir: dir },
  } as Skill;
}

export interface CardSessionOptions {
  cwd: string;
  guidelines: string;
  onText?: (delta: string) => void;
  onTool?: (name: string, phase: "start" | "end", detail?: unknown) => void;
  /** Attribution for the usage ledger (tokens + cost per job). */
  usage?: UsageContext;
}

/** A full tool-using session with the holo-card-studio skill, working inside `cwd`. */
export async function createCardSession(o: CardSessionOptions) {
  const cfg = getConfig();
  const models = getModels();
  const { model, thinkingLevel } = await resolveModel(models.buildModel);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 4 },
    enableSkillCommands: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: o.cwd,
    agentDir: cfg.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPrompts: true,
    noThemes: true,
    skillsOverride: (base) => ({
      skills: [...base.skills, skillFrom(cfg.holoSkillDir, "holo-card-agent")],
      diagnostics: base.diagnostics,
    }),
    agentsFilesOverride: (base) => ({ agentsFiles: [...base.agentsFiles, { path: path.join(o.cwd, "AGENTS.md"), content: o.guidelines }] }),
  } as ConstructorParameters<typeof DefaultResourceLoader>[0]);
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: o.cwd,
    agentDir: cfg.agentDir,
    model,
    thinkingLevel: (thinkingLevel ?? models.thinking) as never,
    modelRuntime: await modelRuntime(),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", ...HOLO_TOOL_NAMES],
    customTools: createHoloTools(o.cwd),
    resourceLoader: loader,
    sessionManager: SessionManager.create(o.cwd),
    settingsManager,
  });

  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") o.onText?.(event.assistantMessageEvent.delta);
    else if (event.type === "tool_execution_start") o.onTool?.(event.toolName, "start", event.args);
    else if (event.type === "tool_execution_end") o.onTool?.(event.toolName, "end", { isError: event.isError });
  });
  trackSessionUsage(session, o.usage ?? { kind: "build", jobId: path.basename(o.cwd) });
  return session;
}

/** A tools-free session for drafting chat replies. */
export async function createChatSession(systemPrompt: string, usage: UsageContext = { kind: "chat" }) {
  const cfg = getConfig();
  const { model } = await resolveModel(getModels().chatModel);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3 } });
  const loader = new DefaultResourceLoader({
    cwd: cfg.dataDir,
    agentDir: cfg.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPrompts: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
  } as ConstructorParameters<typeof DefaultResourceLoader>[0]);
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: cfg.dataDir,
    agentDir: cfg.agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime: await modelRuntime(),
    noTools: "all",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cfg.dataDir),
    settingsManager,
  });
  trackSessionUsage(session, usage);
  return session;
}

/** Collect the assistant's final text for a prompt. */
export async function promptForText(
  session: Awaited<ReturnType<typeof createChatSession>>,
  prompt: string,
  images?: Array<{ mediaType: string; data: string }>,
): Promise<string> {
  let out = "";
  const unsub = session.subscribe((e) => {
    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") out += e.assistantMessageEvent.delta;
  });
  try {
    await session.prompt(prompt, {
      images: images?.map((i) => ({ type: "image" as const, mimeType: i.mediaType, data: i.data })),
    });
  } finally {
    unsub();
  }
  const err = session.agent.state.errorMessage;
  if (!out.trim() && err) throw new Error(`model error: ${err}`);
  return out.trim();
}
