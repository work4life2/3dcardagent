/**
 * pi extension for interactive use (`npm run pi`): registers the same image tools the
 * unattended worker uses, so an operator can drive holo-card-studio and the Termix skill
 * conversationally from this project.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const mod = await import(path.join(root, "dist", "agent", "tools.js")).catch(() => undefined);
  if (!mod) {
    pi.on("session_start", (_ev, ctx) => ctx.ui.notify("holo-tools: run `npm run build` first to enable image tools", "warning"));
    return;
  }
  const cwd = process.cwd();
  for (const tool of mod.createHoloTools(cwd)) pi.registerTool(tool);
}
