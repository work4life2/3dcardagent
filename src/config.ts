import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (the directory that contains package.json / skills / tools). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal .env loader: never overrides variables already present in the process env. */
export function loadDotEnv(file = path.join(ROOT, ".env")): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function envInt(name: string, fallback: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface Config {
  root: string;
  dataDir: string;
  skillsDir: string;
  holoSkillDir: string;
  termixSkillDir: string;
  toolsDir: string;
  agentDir: string;
  llm: { model: string; chatModel: string; thinking: string };
  image: {
    provider: "openai" | "gemini" | "mock";
    openaiKey: string;
    openaiBaseUrl: string;
    openaiModel: string;
    geminiKey: string;
    geminiModel: string;
  };
  termix: { chain: string; agentId: string; apiKey: string; walletMode: string; hasWalletKey: boolean };
  http: { port: number; host: string; publicBaseUrl: string };
  jobs: { timeoutMinutes: number; concurrency: number; sweepIntervalSeconds: number; notifyWebhook: string };
  service: {
    title: string;
    price: string;
    currency: string;
    deliveryDays: number;
    category: string;
    skillTag: string;
  };
}

let cached: Config | undefined;

export function getConfig(): Config {
  if (cached) return cached;
  loadDotEnv();
  const dataDir = path.resolve(ROOT, env("DATA_DIR", "./data"));
  const skillsDir = path.join(ROOT, "skills");
  const providerRaw = env("IMAGE_PROVIDER", "openai").toLowerCase();
  const provider = providerRaw === "gemini" ? "gemini" : providerRaw === "mock" ? "mock" : "openai";
  cached = {
    root: ROOT,
    dataDir,
    skillsDir,
    holoSkillDir: path.join(skillsDir, "holo-card-studio"),
    termixSkillDir: path.join(skillsDir, "termix-agent-skills"),
    toolsDir: path.join(ROOT, "tools"),
    agentDir: path.resolve(ROOT, env("PI_CODING_AGENT_DIR", path.join(dataDir, "pi-agent"))),
    llm: {
      model: env("PI_MODEL", "anthropic/claude-sonnet-4-5"),
      chatModel: env("PI_CHAT_MODEL", env("PI_MODEL", "anthropic/claude-sonnet-4-5")),
      thinking: env("PI_THINKING", "medium"),
    },
    image: {
      provider,
      openaiKey: env("OPENAI_IMAGE_API_KEY", env("OPENAI_API_KEY")),
      openaiBaseUrl: env("OPENAI_IMAGE_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),
      openaiModel: env("OPENAI_IMAGE_MODEL", "gpt-image-1"),
      geminiKey: env("GEMINI_API_KEY"),
      geminiModel: env("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image"),
    },
    termix: {
      chain: env("AACP_CHAIN", "bsc"),
      agentId: env("A2A_AGENT_ID"),
      apiKey: env("TERMIX_API_KEY"),
      walletMode: env("TERMIX_WALLET_MODE"),
      hasWalletKey: Boolean(env("WALLET_KEY")),
    },
    http: {
      port: envInt("HTTP_PORT", 8787),
      host: env("HTTP_HOST", "0.0.0.0"),
      publicBaseUrl: env("PUBLIC_BASE_URL").replace(/\/+$/, ""),
    },
    jobs: {
      timeoutMinutes: envInt("JOB_TIMEOUT_MINUTES", 40),
      concurrency: envInt("JOB_CONCURRENCY", 1),
      sweepIntervalSeconds: envInt("SWEEP_INTERVAL_SECONDS", 300),
      notifyWebhook: env("NOTIFY_WEBHOOK_URL"),
    },
    service: {
      title: env("SERVICE_TITLE", "AI 3D 全息闪卡定制（Holo Card Studio）"),
      price: env("SERVICE_PRICE", "15"),
      currency: env("SERVICE_CURRENCY", "USDC"),
      deliveryDays: envInt("SERVICE_DELIVERY_DAYS", 2),
      category: env("SERVICE_CATEGORY", "Design & Brand"),
      skillTag: env("SERVICE_SKILL_TAG", "holo-card-design"),
    },
  };
  fs.mkdirSync(cached.dataDir, { recursive: true });
  fs.mkdirSync(cached.agentDir, { recursive: true });
  return cached;
}
