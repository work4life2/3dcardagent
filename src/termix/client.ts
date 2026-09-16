import path from "node:path";
import fs from "node:fs";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { lastJson, run, type ExecResult } from "../util/exec.js";

const log = logger("termix");

export interface WatchEvent {
  type: "chat.message" | "order.funded" | "offer.received" | "hosting.handoff" | string;
  what?: string;
  hint?: string;
  conversationId?: string;
  messageId?: string;
  orderId?: string;
  from?: string | { displayName?: string; handle?: string; walletAddress?: string };
  text?: string;
  agentId?: string;
  moreQueued?: number;
  [k: string]: unknown;
}

export interface WatchResult {
  timedOut: boolean;
  waitedSeconds?: number;
  polls?: number;
  watching?: string[];
  events: WatchEvent[];
  errors?: unknown[];
  next?: string;
}

export interface TxIntent {
  action?: string;
  chainId?: number | string;
  contract?: string;
  to?: string;
  callData?: string;
  data?: string;
  value?: string;
  [k: string]: unknown;
}

export interface TxResult {
  mode: string;
  from?: string;
  chainId?: number;
  signRequestId?: string;
  url?: string;
  results?: Array<{ action: string; txHash: string; status: string; blockNumber?: number }>;
}

export class TermixError extends Error {
  constructor(
    message: string,
    public readonly result?: ExecResult,
  ) {
    super(message);
  }
}

/**
 * Thin wrapper over the dependency-free scripts shipped in skills/termix-agent-skills.
 * The scripts cache credentials/cursors in files relative to `cwd`, so every call runs
 * from the same working directory (DATA_DIR/termix).
 */
export class TermixClient {
  readonly scriptsDir: string;
  readonly cwd: string;

  constructor() {
    const cfg = getConfig();
    this.scriptsDir = path.join(cfg.termixSkillDir, "scripts");
    this.cwd = path.join(cfg.dataDir, "termix");
    fs.mkdirSync(this.cwd, { recursive: true });
  }

  private script(name: string): string {
    return path.join(this.scriptsDir, name);
  }

  private env(): NodeJS.ProcessEnv {
    const cfg = getConfig();
    // Key mode only: the service signs locally with the provider hot wallet (WALLET_KEY).
    const e: NodeJS.ProcessEnv = { AACP_CHAIN: cfg.termix.chain, TERMIX_WALLET_MODE: "key" };
    if (cfg.termix.agentId) e.A2A_AGENT_ID = cfg.termix.agentId;
    return e;
  }

  async node(
    scriptName: string,
    args: string[],
    opts: { timeoutMs?: number; onStderr?: (s: string) => void } = {},
  ): Promise<ExecResult> {
    const res = await run("node", [this.script(scriptName), ...args], {
      cwd: this.cwd,
      env: this.env(),
      timeoutMs: opts.timeoutMs,
      onStderr: opts.onStderr,
    });
    return res;
  }

  private async json<T = unknown>(
    scriptName: string,
    args: string[],
    opts: { timeoutMs?: number; onStderr?: (s: string) => void; allowFail?: boolean } = {},
  ): Promise<T> {
    const res = await this.node(scriptName, args, opts);
    const parsed = lastJson<T>(res.stdout);
    if (res.code !== 0 && !opts.allowFail) {
      const msg = (res.stderr || res.stdout).trim().split("\n").slice(-6).join("\n");
      throw new TermixError(`${scriptName} ${args[0] ?? ""} failed (exit ${res.code}): ${msg}`, res);
    }
    if (parsed === undefined) {
      if (opts.allowFail) return undefined as T;
      throw new TermixError(`${scriptName} returned no JSON: ${(res.stdout + res.stderr).slice(-400)}`, res);
    }
    return parsed;
  }

  // ─── identity / setup ──────────────────────────────────────────────

  next() {
    return this.json<Record<string, unknown>>("aacp-next.mjs", [], { allowFail: true });
  }

  private loginPromise: Promise<Record<string, unknown>> | undefined;

  /** Wallet login (nonce → sign with WALLET_KEY → cached session). Idempotent per process. */
  login() {
    this.loginPromise ??= this.json<Record<string, unknown>>("a2a-runtime.mjs", ["login"]).catch((e) => {
      this.loginPromise = undefined;
      throw e;
    });
    return this.loginPromise;
  }

  /** Run a session-authenticated command, logging in first (and once more if the session expired). */
  private async withSession<T>(fn: () => Promise<T>): Promise<T> {
    await this.login();
    try {
      return await fn();
    } catch (err) {
      if (/not logged in|401|UNAUTHORIZED|session/i.test(String(err))) {
        this.loginPromise = undefined;
        await this.login();
        return await fn();
      }
      throw err;
    }
  }

  agents() {
    return this.withSession(() =>
      this.json<{ count: number; items: Array<{ agentId: string; agentTokenId?: string; name: string; a2aStatus?: string }> }>(
        "a2a-runtime.mjs",
        ["agents"],
      ),
    );
  }

  printEnv() {
    return this.json<Record<string, unknown>>("a2a-runtime.mjs", ["print-env"], { allowFail: true });
  }

  updateCheck() {
    return this.json<{ status?: string; installed?: string; latest?: string }>("aacp-update.mjs", ["check"], { allowFail: true });
  }

  // ─── REST ──────────────────────────────────────────────────────────

  async api<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    apiPath: string,
    body?: unknown,
    auth: "session" | "runtime" | "none" = "session",
  ): Promise<T> {
    const args = [method, apiPath, "--auth", auth];
    if (body !== undefined) args.push("--body", JSON.stringify(body));
    const call = () => this.json<T>("aacp-api.mjs", args, { timeoutMs: 120_000 });
    return auth === "none" ? call() : this.withSession(call);
  }

  get<T = unknown>(apiPath: string) {
    return this.api<T>("GET", apiPath);
  }

  // ─── hosting ───────────────────────────────────────────────────────

  /** Blocks until there is work or `timeoutSeconds` elapsed. */
  async wait(agentId: string, timeoutSeconds = 300, intervalSeconds = 10, extra: string[] = []): Promise<WatchResult> {
    const args = ["wait", "--agent", agentId, "--timeout", String(timeoutSeconds), "--interval", String(intervalSeconds), ...extra];
    await this.login();
    const res = await this.node("aacp-watch.mjs", args, { timeoutMs: (timeoutSeconds + 120) * 1000 });
    const parsed = lastJson<WatchResult>(res.stdout);
    if (!parsed) {
      throw new TermixError(`aacp-watch wait failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(-600)}`, res);
    }
    parsed.events ??= [];
    return parsed;
  }

  watchStatus() {
    return this.json<Record<string, unknown>>("aacp-watch.mjs", ["status"], { allowFail: true });
  }

  async ensureRuntimeToken(): Promise<void> {
    await this.withSession(() => this.json("a2a-runtime.mjs", ["token"]));
  }

  async reply(conversationId: string, text: string, clientMessageId?: string): Promise<unknown> {
    const args = ["reply", "--conversation", conversationId, "--text", text];
    if (clientMessageId) args.push("--client-msg", clientMessageId);
    try {
      return await this.json("a2a-runtime.mjs", args);
    } catch (err) {
      // Runtime token may have expired (12 h); refresh once and retry.
      if (/token|401|UNAUTHORIZED/i.test(String(err))) {
        await this.ensureRuntimeToken();
        return await this.json("a2a-runtime.mjs", args);
      }
      throw err;
    }
  }

  async signal(conversationId: string): Promise<void> {
    try {
      await this.node("a2a-runtime.mjs", ["signal", "--conversation", conversationId], { timeoutMs: 30_000 });
    } catch {
      /* documented as fire-and-forget */
    }
  }

  async hostingOff(agentId: string): Promise<void> {
    await this.node("a2a-runtime.mjs", ["hosting", "off", "--agent", agentId], { timeoutMs: 60_000 });
  }

  agentCard(agentId: string) {
    return this.json<{ status?: string; [k: string]: unknown }>("aacp-get.mjs", [`/api/v1/a2a/agents/${agentId}/card`], {
      allowFail: true,
    });
  }

  // ─── on-chain ──────────────────────────────────────────────────────

  /**
   * Execute a tx-intent: key mode signs locally with WALLET_KEY and broadcasts (`--yes`).
   */
  async tx(intent: TxIntent | TxIntent[], context?: Record<string, unknown>): Promise<TxResult> {
    await this.login();
    const args = Array.isArray(intent) ? ["--intents", JSON.stringify(intent)] : ["--intent", JSON.stringify(intent)];
    args.push("--yes");
    if (context) args.push("--context", JSON.stringify(context));
    const onStderr = (s: string) => {
      for (const line of s.split("\n")) if (line.trim()) log.debug(line.trim());
    };
    const result = await this.json<TxResult>("aacp-tx.mjs", args, { timeoutMs: 20 * 60 * 1000, onStderr });
    return result;
  }

  // ─── uploads ───────────────────────────────────────────────────────

  async upload(uploadUrl: string, file: string, contentType: string): Promise<{ ok: boolean; sha256?: string; sizeBytes?: number }> {
    const res = await this.json<{ ok: boolean; sha256?: string; sizeBytes?: number; size?: number }>("aacp-upload.mjs", [
      "--url",
      uploadUrl,
      "--file",
      file,
      "--content-type",
      contentType,
    ], { timeoutMs: 10 * 60 * 1000 });
    if (!res.ok) throw new TermixError(`upload failed: ${JSON.stringify(res)}`);
    return { ok: true, sha256: res.sha256, sizeBytes: res.sizeBytes ?? res.size };
  }
}

let shared: TermixClient | undefined;
export function termix(): TermixClient {
  return (shared ??= new TermixClient());
}
