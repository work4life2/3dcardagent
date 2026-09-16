#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getConfig, ROOT } from "./config.js";
import { initLogFile, logger } from "./log.js";

const log = logger("main");

function usage(): never {
  process.stdout.write(`holo-card-agent — 在 Termix 上出售 AI 3D 全息闪卡

用法:
  holo-card-agent serve                       托管上线：接单 → 生成闪卡 → 交付（常驻）
  holo-card-agent setup [link|agents|mint <name> "<显示名>"|listing [cover.png]|deps]
  holo-card-agent doctor                      环境与配置体检
  holo-card-agent make "<需求描述>" [--ref <图片路径或URL>] [--name <jobId>]
                                              本地生成一张卡（不接市场），用于测试
  holo-card-agent deliver <orderId>           手动处理/重试某个订单
  holo-card-agent jobs                        列出任务
  holo-card-agent pi [args...]                打开交互式 pi（已加载两个 skill 与图像工具）
`);
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = getConfig();
  initLogFile(path.join(cfg.dataDir, "logs"));
  const { exposeLocalBin } = await import("./cli/setup.js");
  exposeLocalBin();

  switch (cmd) {
    case "serve": {
      const { HostingLoop } = await import("./hosting/loop.js");
      const { startHttpServer } = await import("./server/http.js");
      const { runDoctor, printChecks } = await import("./cli/doctor.js");
      const checks = await runDoctor({ network: true });
      if (!printChecks(checks)) {
        log.error("fix the ❌ items above before serving");
        process.exit(1);
      }
      if (!cfg.termix.agentId) {
        log.error("A2A_AGENT_ID is not set (npm run setup -- agents)");
        process.exit(1);
      }
      startHttpServer();
      const loop = new HostingLoop(cfg.termix.agentId);
      const stop = () => {
        log.info("shutting down after current work...");
        loop.stop();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await loop.run();
      process.exit(0);
    }
    case "setup": {
      const s = await import("./cli/setup.js");
      const sub = rest[0];
      if (!sub) await s.fullSetup();
      else if (sub === "link") await s.setupLink();
      else if (sub === "agents") await s.listAgents();
      else if (sub === "deps") {
        await s.installWebDeps();
        process.stdout.write(await s.ensureBlender() + "\n");
      } else if (sub === "mint") {
        if (!rest[1]) usage();
        await s.mintAgent(rest[1], rest[2] ?? rest[1]);
      } else if (sub === "listing") {
        if (!cfg.termix.agentId) throw new Error("A2A_AGENT_ID is not set");
        await s.publishListing(cfg.termix.agentId, rest[1]);
      } else usage();
      break;
    }
    case "doctor": {
      const { runDoctor, printChecks } = await import("./cli/doctor.js");
      const ok = printChecks(await runDoctor({ network: !rest.includes("--offline") }));
      process.exit(ok ? 0 : 1);
    }
    case "make": {
      const brief = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--ref" && rest[i - 1] !== "--name").join(" ");
      if (!brief) usage();
      const refs = rest.flatMap((a, i) => (a === "--ref" && rest[i + 1] ? [path.resolve(rest[i + 1])] : []));
      const nameIdx = rest.indexOf("--name");
      const id = nameIdx >= 0 && rest[nameIdx + 1] ? rest[nameIdx + 1] : `local-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
      const { createJob, saveJob } = await import("./jobs/store.js");
      const { buildCard, packageJob } = await import("./jobs/cardBuilder.js");
      const job = createJob({ id, orderId: `local:${id}`, brief, refs });
      job.status = "building";
      saveJob(job);
      try {
        const out = await buildCard(job);
        job.status = "built";
        job.previewUrl = cfg.http.publicBaseUrl ? `${cfg.http.publicBaseUrl}/cards/${job.id}/` : undefined;
        saveJob(job);
        const pack = await packageJob(job, out);
        process.stdout.write(`\n✅ 完成: ${job.dir}\n  预览渲染: ${out.hero ?? "-"}\n  交付包:   ${pack.zip}\n  本地查看: cd ${out.webDir} && node server.mjs  → http://127.0.0.1:4173\n  或启动 serve 后访问 /cards/${job.id}/\n`);
      } catch (err) {
        job.status = "failed";
        job.error = String(err instanceof Error ? err.message : err);
        saveJob(job);
        log.error(job.error);
        process.exit(1);
      }
      break;
    }
    case "deliver": {
      if (!rest[0]) usage();
      const { processOrder } = await import("./jobs/orderWorker.js");
      const job = await processOrder(rest[0], { redoNote: rest[1] });
      process.stdout.write(JSON.stringify({ id: job.id, status: job.status, previewUrl: job.previewUrl, tx: job.txHashes }, null, 2) + "\n");
      break;
    }
    case "jobs": {
      const { listJobs } = await import("./jobs/store.js");
      for (const j of listJobs()) process.stdout.write(`${j.id.padEnd(40)} ${j.status.padEnd(11)} ${j.orderId.padEnd(30)} ${j.updatedAt}${j.error ? "  ✗ " + j.error.slice(0, 80) : ""}\n`);
      break;
    }
    case "pi": {
      // Interactive pi with both skills and the image tools (via .pi/ project config).
      const bin = path.join(ROOT, "node_modules", ".bin", "pi");
      if (!fs.existsSync(bin)) throw new Error("pi is not installed; run npm install");
      const { ensureModelsJson } = await import("./agent/session.js");
      ensureModelsJson();
      const env = { ...process.env, PI_CODING_AGENT_DIR: cfg.agentDir };
      // This is our own project: trust .pi/ (settings, skills, extension) so the tools load.
      const args = rest.some((a) => a === "--approve" || a === "-a" || a === "--no-approve" || a === "-na") ? rest : ["--approve", ...rest];
      const child = spawn(bin, args, { cwd: ROOT, stdio: "inherit", env });
      child.on("exit", (c) => process.exit(c ?? 0));
      return;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
