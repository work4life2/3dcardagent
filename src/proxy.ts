import net from "node:net";
import { getConfig } from "./config.js";
import { logger } from "./log.js";

const log = logger("proxy");

export interface ProxyState {
  enabled: boolean;
  url: string;
  reason: string;
}

let state: ProxyState | undefined;

function portOpen(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let host = "127.0.0.1";
    let port = 1080;
    try {
      const u = new URL(url);
      host = u.hostname;
      port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    } catch {
      /* keep defaults */
    }
    const sock = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

async function directReachable(url: string, timeoutMs = 6000): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    // Any HTTP answer (even 401/403) proves connectivity.
    return res.status > 0;
  } catch {
    return false;
  }
}

function applyEnv(url: string, noProxy: string): void {
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    process.env[k] = url;
  }
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;
  // Node >= 22.21 / 24: make the built-in fetch honor HTTP(S)_PROXY. Inherited by child node processes.
  process.env.NODE_USE_ENV_PROXY = "1";
}

function clearEnv(): void {
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "NODE_USE_ENV_PROXY"]) {
    delete process.env[k];
  }
}

/**
 * Decide whether outbound traffic should go through the local proxy and export the
 * decision to the process environment so that pi, the Termix scripts (node fetch),
 * python (urllib), npm and curl all pick it up.
 *
 * Must be called before anything performs network I/O. The setting is applied to
 * process.env before NODE_USE_ENV_PROXY is read by undici, so it also affects this
 * process' own fetch() calls.
 */
export async function initProxy(): Promise<ProxyState> {
  if (state) return state;
  const { proxy } = getConfig();
  if (proxy.mode === "off") {
    clearEnv();
    state = { enabled: false, url: proxy.url, reason: "PROXY_MODE=off" };
  } else if (proxy.mode === "always") {
    applyEnv(proxy.url, proxy.noProxy);
    state = { enabled: true, url: proxy.url, reason: "PROXY_MODE=always" };
  } else {
    const direct = await directReachable(proxy.probeUrl);
    if (direct) {
      clearEnv();
      state = { enabled: false, url: proxy.url, reason: `direct access to ${proxy.probeUrl} works` };
    } else if (await portOpen(proxy.url)) {
      applyEnv(proxy.url, proxy.noProxy);
      state = { enabled: true, url: proxy.url, reason: `direct access failed, ${proxy.url} is reachable` };
    } else {
      clearEnv();
      state = { enabled: false, url: proxy.url, reason: `direct access failed and proxy ${proxy.url} is not listening` };
    }
  }
  log.info(state.enabled ? `using proxy ${state.url}` : "not using a proxy", { reason: state.reason });
  return state;
}

export function proxyState(): ProxyState | undefined {
  return state;
}

/**
 * fetch() with an automatic one-time retry through the proxy when a request fails at the
 * network layer while the proxy was not yet enabled (auto mode). Once the proxy proves to
 * work, it is switched on for the rest of the process.
 */
export async function fetchWithFallback(input: string | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    const { proxy } = getConfig();
    if (proxy.mode === "off" || state?.enabled) throw err;
    if (!(await portOpen(proxy.url))) throw err;
    log.warn(`request to ${String(input)} failed directly, retrying through ${proxy.url}`);
    applyEnv(proxy.url, proxy.noProxy);
    state = { enabled: true, url: proxy.url, reason: "direct request failed at runtime" };
    return fetch(input, init);
  }
}
