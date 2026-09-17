#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getConfig, ROOT } from "./config.js";
import { initLogFile, logger } from "./log.js";

const log = logger("main");

function usage(): never {
  process.stdout.write(`holo-card-agent — sell AI 3D holographic cards on Termix

Usage:
  holo-card-agent serve                       go online: accept orders → build cards → deliver (long-running)
  holo-card-agent setup [agents|mint <name> "<display name>"|listing [cover.png] [--update <listingId>]|deps]
  holo-card-agent model [show|list [filter] [--refresh]|build <id>|chat <id>|image <id>|thinking <lvl>|reset]
                                              switch models at runtime (takes effect immediately, no restart);
                                              "list" prints the relay's live model catalog
  holo-card-agent usage [--days N]            token & cost report: per job/model (local) + the relay's bill
  holo-card-agent doctor                      check environment and configuration
  holo-card-agent make "<brief>" [--ref <image path or URL>] [--name <jobId>]
                                              build one card locally (no marketplace), for testing
  holo-card-agent deliver <orderId>           process / retry one order manually
  holo-card-agent jobs                        list jobs
  holo-card-agent pi [args...]                interactive pi with both skills and the image tools loaded
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
      else if (sub === "agents") await s.listAgents();
      else if (sub === "deps") {
        await s.installWebDeps();
        process.stdout.write(await s.ensureBlender() + "\n");
      } else if (sub === "mint") {
        if (!rest[1]) usage();
        await s.mintAgent(rest[1], rest[2] ?? rest[1]);
      } else if (sub === "listing") {
        if (!cfg.termix.agentId) throw new Error("A2A_AGENT_ID is not set");
        const upd = rest.indexOf("--update");
        const cover = rest.slice(1).find((a, i, arr) => !a.startsWith("--") && arr[i - 1] !== "--update");
        await s.publishListing(cfg.termix.agentId, cover, upd >= 0 ? rest[upd + 1] : undefined);
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
        process.stdout.write(`\n✅ Done: ${job.dir}\n  preview render: ${out.hero ?? "-"}\n  deliverable:    ${pack.zip}\n  view locally:   cd ${out.webDir} && node server.mjs  → http://127.0.0.1:4173\n  or run serve and open /cards/${job.id}/\n`);
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
    case "model": {
      const { getModels, setModels, MODEL_KEYS } = await import("./runtimeConfig.js");
      const sub = rest[0] ?? "show";
      const map: Record<string, (typeof MODEL_KEYS)[number]> = { build: "buildModel", chat: "chatModel", image: "imageModel", thinking: "thinking" };
      if (sub === "show") {
        const m = getModels();
        process.stdout.write(`build    ${m.buildModel}${m.overrides.buildModel ? "" : "  (env default)"}\nchat     ${m.chatModel}${m.overrides.chatModel ? "" : "  (env default)"}\nimage    ${m.imageModel}${m.overrides.imageModel ? "" : "  (env default)"}\nthinking ${m.thinking}${m.overrides.thinking ? "" : "  (env default)"}\n`);
      } else if (sub === "reset") {
        setModels({ buildModel: "", chatModel: "", imageModel: "", thinking: "" });
        process.stdout.write("Reset to the .env defaults\n");
      } else if (sub === "list") {
        // Live relay catalog + whatever else pi has credentials for.
        const { relayCatalog, languageOptions, imageOptions } = await import("./relay.js");
        const { syncRelayModels } = await import("./agent/session.js");
        const catalog = await relayCatalog({ force: rest.includes("--refresh") });
        await syncRelayModels().catch(() => undefined);
        const filter = rest.slice(1).find((a) => !a.startsWith("--"))?.toLowerCase();
        const show = (title: string, rows: Array<{ id: string; label: string }>) => {
          const list = rows.filter((r) => !filter || r.id.toLowerCase().includes(filter));
          process.stdout.write(`\n${title} (${list.length})\n`);
          for (const r of list) process.stdout.write(`  ${r.id.padEnd(58)} ${r.label}\n`);
        };
        if (!catalog) process.stdout.write("Relay catalog unavailable (RELAY_API_KEY missing or offline)\n");
        else process.stdout.write(`Relay catalog fetched ${catalog.fetchedAt} (${getConfig().relay.baseUrl}; prices are on the relay's own pricing page)\n`);
        show("Text models (pi ids)", languageOptions(catalog));
        show("Image models (relay ids, OpenAI Images API)", imageOptions(catalog));
      } else if (map[sub] && rest[1]) {
        if (sub !== "image" && sub !== "thinking") {
          const { resolveModel } = await import("./agent/session.js");
          await resolveModel(rest[1]); // fail fast on unknown model ids
        }
        const m = setModels({ [map[sub]]: rest[1] });
        process.stdout.write(`✅ ${sub} → ${m[map[sub]]} (applies to new sessions immediately)\n`);
      } else usage();
      break;
    }
    case "jobs": {
      const { listJobs } = await import("./jobs/store.js");
      const { summarizeUsage, fmtUsd } = await import("./usage.js");
      const usageByJob = new Map(summarizeUsage().byJob.map((j) => [j.jobId, j]));
      for (const j of listJobs()) {
        const u = usageByJob.get(j.id);
        process.stdout.write(`${j.id.padEnd(40)} ${j.status.padEnd(11)} ${j.orderId.padEnd(30)} ${j.updatedAt}  ${u ? `${fmtUsd(u.cost)} (${u.calls} calls)` : "-"}${j.error ? "  ✗ " + j.error.slice(0, 80) : ""}\n`);
      }
      break;
    }
    case "usage": {
      // Token & cost report: the local per-job ledger and the relay's own bill.
      const { summarizeUsage, fmtUsd } = await import("./usage.js");
      const { relaySpend } = await import("./relay.js");
      const days = Number(rest[rest.indexOf("--days") + 1]) || 30;
      const l = summarizeUsage();
      const row = (t: { calls: number; input: number; output: number; cacheRead: number; cost: number }) => `${String(t.calls).padStart(6)} calls ${String(t.input).padStart(11)} in ${String(t.output).padStart(10)} out ${String(t.cacheRead).padStart(11)} cached  ${fmtUsd(t.cost)}`;
      process.stdout.write(`This agent (local ledger ${l.file}; pi calls carry pi's estimate, relay image calls carry no price)\n  today     ${row(l.today)}\n  last 7 d  ${row(l.last7d)}\n  last 30 d ${row(l.last30d)}\n  all time  ${row(l.allTime)}\n`);
      if (l.byModel.length) {
        process.stdout.write(`\n  by model\n`);
        for (const m of l.byModel) process.stdout.write(`    ${m.model.padEnd(52)} ${row(m)}\n`);
      }
      if (l.byJob.length) {
        process.stdout.write(`\n  by job (top 15)\n`);
        for (const j of l.byJob.slice(0, 15)) process.stdout.write(`    ${j.jobId.padEnd(52)} ${row(j)}\n`);
      }
      const g = await relaySpend(days);
      process.stdout.write(`\nRelay bill (${g.baseUrl}, authoritative, ${g.startDate} → ${g.endDate})\n`);
      if (g.error) process.stdout.write(`  unavailable: ${g.error}\n`);
      if (g.totalUsed !== undefined) process.stdout.write(`  used by this key in range ${fmtUsd(g.totalUsed)}\n`);
      process.stdout.write(`  remaining quota ${g.remaining !== undefined ? fmtUsd(g.remaining) : "unlimited / not reported"}\n`);
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
  log.error(err instanceof Error ? (process.env.DEBUG ? err.stack ?? err.message : err.message) : String(err));
  process.exit(1);
});
