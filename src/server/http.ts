import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { listJobs, loadJob } from "../jobs/store.js";

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
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Holo Card Gallery</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#fff;color:#111}header{padding:24px;border-bottom:1px solid #eee}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;padding:24px}.card{display:block;text-decoration:none;color:inherit;border:1px solid #eee;border-radius:12px;overflow:hidden}.thumb{aspect-ratio:1080/1500;background:#f4f4f4}.thumb img{width:100%;height:100%;object-fit:cover;display:block}.meta{display:flex;justify-content:space-between;padding:10px 12px;font-size:13px}</style></head>
<body><header><h1>Holo Card Gallery</h1><p>AI 生成的 3D 全息闪卡 · 点击进入可交互查看器</p></header><main>${cards || "<p>还没有交付的卡。</p>"}</main></body></html>`;
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
    if (p === "/api/jobs") {
      return send(res, 200, JSON.stringify(listJobs().map(({ id, orderId, status, createdAt, updatedAt, previewUrl, error }) => ({ id, orderId, status, createdAt, updatedAt, previewUrl, error }))));
    }
    const m = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (m) {
      const j = loadJob(m[1]);
      return j ? send(res, 200, JSON.stringify(j)) : send(res, 404, "{}");
    }
    if (p === "/" || p === "/cards" || p === "/cards/") return send(res, 200, galleryHtml(), "text/html; charset=utf-8");
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
  server.listen(cfg.http.port, cfg.http.host, () => log.info(`listening on http://${cfg.http.host}:${cfg.http.port} (gallery at /cards/)`));
  return server;
}
