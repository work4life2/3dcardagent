import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { listJobs, loadJob } from "../jobs/store.js";
import { getModels, setModels, MODEL_KEYS, type ModelSettings } from "../runtimeConfig.js";
import { dashboardHtml } from "./dashboard.js";
import { imageProviderReady } from "../agent/imagegen.js";

const startedAt = Date.now();
const IMAGE_MODEL_SUGGESTIONS = ["openai/gpt-image-1-mini", "openai/gpt-image-1", "openai/gpt-image-1.5", "google/gemini-3.1-flash-lite-image", "google/gemini-3.1-flash-image", "google/gemini-2.5-flash-image", "bytedance/seedream-4.5", "bfl/flux-pro-1.1"];

const log = logger("http");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".zip": "application/zip",
  ".md": "text/markdown; charset=utf-8",
  ".blend": "application/octet-stream",
};

function send(res: http.ServerResponse, code: number, body: string | Buffer, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-cache", "access-control-allow-origin": "*" });
  res.end(body);
}

function serveFile(res: http.ServerResponse, root: string, rel: string) {
  let file = path.resolve(root, "." + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, "forbidden", "text/plain");
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    const data = fs.readFileSync(file);
    return send(res, 200, data, TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
  } catch {
    return send(res, 404, "not found", "text/plain");
  }
}

function galleryHtml(): string {
  const jobs = listJobs().filter((j) => ["built", "delivering", "delivered", "settled"].includes(j.status));
  const cards = jobs
    .map((j) => {
      const hero = fs.existsSync(path.join(j.dir, "renders", "hero.png")) ? `/cards/${j.id}/../renders/hero.png` : "";
      return `<a class="card" href="/cards/${j.id}/"><div class="thumb">${hero ? `<img src="/jobs/${j.id}/renders/hero.png" alt="">` : ""}</div><div class="meta"><b>${j.id}</b><span>${j.status}</span></div></a>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Holo Card Gallery</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#fff;color:#111}header{padding:24px;border-bottom:1px solid #eee}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;padding:24px}.card{display:block;text-decoration:none;color:inherit;border:1px solid #eee;border-radius:12px;overflow:hidden}.thumb{aspect-ratio:1080/1500;background:#f4f4f4}.thumb img{width:100%;height:100%;object-fit:cover;display:block}.meta{display:flex;justify-content:space-between;padding:10px 12px;font-size:13px}</style></head>
<body><header><h1>Holo Card Gallery</h1><p>AI-generated 3D holographic collectible cards · click a card to open the interactive viewer</p></header><main>${cards || "<p>No delivered cards yet.</p>"}</main></body></html>`;
}

export function startHttpServer(): http.Server {
  const cfg = getConfig();
  const jobsRoot = path.join(cfg.dataDir, "jobs");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = decodeURIComponent(url.pathname);
    if (p === "/health" || p === "/healthz") {
      return send(res, 200, JSON.stringify({ ok: true, chain: cfg.termix.chain, agentId: cfg.termix.agentId || null, at: new Date().toISOString() }));
    }
    if (p === "/api/status") {
      const jobs = listJobs();
      return send(res, 200, JSON.stringify({
        chain: cfg.termix.chain,
        agentId: cfg.termix.agentId || null,
        walletConfigured: cfg.termix.hasWalletKey,
        imageProvider: imageProviderReady().reason,
        publicBaseUrl: cfg.http.publicBaseUrl || null,
        service: cfg.service,
        jobs: { total: jobs.length, active: jobs.filter((j) => ["queued", "accepting", "building", "delivering"].includes(j.status)).length, failed: jobs.filter((j) => j.status === "failed").length },
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      }));
    }
    if (p === "/api/models/options") {
      import("../agent/session.js")
        .then(async ({ modelRuntime }) => {
          const rt = await modelRuntime();
          const llm = (await rt.getAvailable()).map((m) => `${m.provider}/${m.id}`).sort();
          send(res, 200, JSON.stringify({ llm, image: IMAGE_MODEL_SUGGESTIONS }));
        })
        .catch((err) => send(res, 500, JSON.stringify({ error: String(err) })));
      return;
    }
    if (p === "/api/models") {
      if (req.method === "GET") return send(res, 200, JSON.stringify(getModels()));
      if (req.method === "POST" || req.method === "PUT") {
        // Switching models is an operator action: require ADMIN_TOKEN, or a loopback caller.
        const token = process.env.ADMIN_TOKEN;
        const local = /^(127\.|::1|::ffff:127\.)/.test(req.socket.remoteAddress ?? "");
        if (!(token && req.headers["x-admin-token"] === token) && !(!token && local)) return send(res, 403, JSON.stringify({ error: "forbidden" }));
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const patch = JSON.parse(body || "{}") as Partial<ModelSettings>;
            const clean: Partial<ModelSettings> = {};
            for (const k of MODEL_KEYS) if (typeof patch[k] === "string") clean[k] = patch[k];
            send(res, 200, JSON.stringify(setModels(clean)));
          } catch (err) {
            send(res, 400, JSON.stringify({ error: String(err) }));
          }
        });
        return;
      }
    }
    if (p === "/api/jobs") {
      return send(res, 200, JSON.stringify(listJobs().map(({ id, orderId, status, createdAt, updatedAt, previewUrl, error }) => ({ id, orderId, status, createdAt, updatedAt, previewUrl, error }))));
    }
    const m = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (m) {
      const j = loadJob(m[1]);
      return j ? send(res, 200, JSON.stringify(j)) : send(res, 404, "{}");
    }
    if (p === "/" || p === "/admin" || p === "/admin/") return send(res, 200, dashboardHtml(), "text/html; charset=utf-8");
    if (p === "/cards" || p === "/cards/") return send(res, 200, galleryHtml(), "text/html; charset=utf-8");
    const card = p.match(/^\/cards\/([^/]+)(\/.*)?$/);
    if (card) {
      const job = loadJob(card[1]);
      if (!job) return send(res, 404, "not found", "text/plain");
      if (!card[2]) {
        res.writeHead(302, { location: `/cards/${card[1]}/` });
        return res.end();
      }
      return serveFile(res, path.join(job.dir, "web"), card[2] || "/");
    }
    const jobFile = p.match(/^\/jobs\/([^/]+)\/(renders|dist)\/(.+)$/);
    if (jobFile) {
      const job = loadJob(jobFile[1]);
      if (!job) return send(res, 404, "not found", "text/plain");
      return serveFile(res, path.join(job.dir, jobFile[2]), "/" + jobFile[3]);
    }
    void jobsRoot;
    return send(res, 404, "not found", "text/plain");
  });
  server.listen(cfg.http.port, cfg.http.host, () => log.info(`listening on http://${cfg.http.host}:${cfg.http.port} (dashboard at /, gallery at /cards/)`));
  return server;
}
