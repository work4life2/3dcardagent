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
import { isAnthropicModel, isTextModel, relayBaseUrl, relayCatalog, relayKey, RELAY_PROVIDER, type RelayCatalog } from "../relay.js";
import { trackSessionUsage, type UsageContext } from "../usage.js";

const log = logger("pi");

function readModelsJson(file: string): { providers?: Record<string, unknown> } {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

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
  const existing = readModelsJson(file);
  const providers = { ...(existing.providers ?? {}) } as Record<string, unknown>;
  providers["anthropic-proxy"] = {
    baseUrl,
    api: "anthropic-messages",
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN ? "$ANTHROPIC_AUTH_TOKEN" : "$ANTHROPIC_API_KEY",
    models: [...wanted].map((id) => ({ id, reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000 })),
  };
  fs.writeFileSync(file, JSON.stringify({ ...existing, providers }, null, 2));
  log.info(`registered anthropic-proxy provider at ${baseUrl} in ${file}`);
}

/**
 * The relay is not one of pi's built-in providers, so every text model on its live catalog is
 * written into <agentDir>/models.json under the `relay` provider: Claude models through the
 * relay's Anthropic Messages endpoint, everything else through OpenAI chat completions. The
 * relay publishes no prices, so cost is 0 and the local ledger only has token counts for pi
 * calls. Returns the ids registered.
 */
export function writeRelayModelsJson(catalog: RelayCatalog | undefined): { ids: string[]; changed: boolean } {
  const cfg = getConfig();
  const file = path.join(cfg.agentDir, "models.json");
  const existing = readModelsJson(file);
  const providers = { ...(existing.providers ?? {}) } as Record<string, unknown>;
  const before = JSON.stringify(providers[RELAY_PROVIDER] ?? null);
  const baseUrl = relayBaseUrl();
  const text = (catalog?.models ?? []).filter(isTextModel);
  const models = text.map((m) => {
    const anthropic = isAnthropicModel(m);
    const id = m.id.toLowerCase();
    return {
      id: m.id,
      name: m.id,
      api: anthropic ? "anthropic-messages" : "openai-completions",
      baseUrl: anthropic ? baseUrl : `${baseUrl}/v1`,
      reasoning: anthropic || /gemini-[3-9]|gpt-5|deepseek-v4|glm-5|grok|kimi-k[3-9]|minimax-m|qwen3/.test(id),
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: anthropic ? 200_000 : /gemini/.test(id) ? 1_000_000 : 128_000,
      maxTokens: anthropic ? 32_000 : 16_384,
    };
  });
  // Ensure whatever the operator selected is registered even if the catalog is unreachable.
  const wanted = new Set<string>();
  const current = getModels();
  for (const spec of [current.buildModel, current.chatModel]) {
    const [provider, ...rest] = spec.split("/");
    if (provider === RELAY_PROVIDER && rest.length) wanted.add(rest.join("/").split(":")[0]);
  }
  for (const id of wanted) {
    if (models.some((m) => m.id === id)) continue;
    const anthropic = /^claude/i.test(id);
    models.push({
      id, name: id, api: anthropic ? "anthropic-messages" : "openai-completions", baseUrl: anthropic ? baseUrl : `${baseUrl}/v1`, reasoning: true,
      input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: anthropic ? 200_000 : 128_000, maxTokens: 16_384,
    });
  }
  providers[RELAY_PROVIDER] = { baseUrl: `${baseUrl}/v1`, api: "openai-completions", apiKey: "$RELAY_API_KEY", models };
  const changed = JSON.stringify(providers[RELAY_PROVIDER]) !== before;
  if (changed) {
    fs.mkdirSync(cfg.agentDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...existing, providers }, null, 2));
    log.info(`registered ${models.length} relay models (${baseUrl}) in ${file}`);
  }
  return { ids: models.map((m) => m.id), changed };
}

let runtime: ModelRuntime | undefined;
let lastSyncedCatalogAt = "";

/** Pull the live relay catalog and make pi aware of its models. Safe to call often (catalog is cached). */
export async function syncRelayModels(opts: { force?: boolean } = {}): Promise<void> {
  const rt = await modelRuntime();
  const catalog = await relayCatalog(opts);
  if (catalog && catalog.fetchedAt === lastSyncedCatalogAt && !opts.force) return;
  lastSyncedCatalogAt = catalog?.fetchedAt ?? "";
  const { changed } = writeRelayModelsJson(catalog);
  if (changed) await rt.refresh();
}

export async function modelRuntime(): Promise<ModelRuntime> {
  if (runtime) return runtime;
  const cfg = getConfig();
  // pi resolves `apiKey: "$RELAY_API_KEY"` from the process environment; .env.local is loaded by getConfig().
  if (relayKey() && !process.env.RELAY_API_KEY) process.env.RELAY_API_KEY = relayKey();
  ensureModelsJson();
  writeRelayModelsJson(await relayCatalog()); // before the runtime reads models.json, so the defaults resolve on first use
  runtime = await ModelRuntime.create({
    authPath: path.join(cfg.agentDir, "auth.json"),
    modelsPath: path.join(cfg.agentDir, "models.json"),
    modelsStorePath: path.join(cfg.agentDir, "models-store.json"),
  });
  await syncRelayModels().catch((err) => log.warn(`relay model sync failed: ${String(err)}`));
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
