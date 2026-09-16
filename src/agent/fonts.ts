import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { run } from "../util/exec.js";

let cachedFont: string | undefined | null;

/**
 * Pick a font file with CJK coverage for the typography layer. Order: FONT_FILE env,
 * bundled tools/fonts/*, fontconfig's best match for zh, then any TTF/OTF found by fc-list.
 */
export async function pickDefaultFont(): Promise<string | undefined> {
  if (cachedFont !== undefined) return cachedFont ?? undefined;
  const envFont = process.env.FONT_FILE;
  if (envFont && fs.existsSync(envFont)) return (cachedFont = envFont);
  const bundled = path.join(getConfig().toolsDir, "fonts");
  if (fs.existsSync(bundled)) {
    const f = fs.readdirSync(bundled).find((n) => /\.(ttf|otf|ttc)$/i.test(n));
    if (f) return (cachedFont = path.join(bundled, f));
  }
  for (const query of ["Noto Sans CJK SC", "Noto Serif CJK SC", "Source Han Sans SC", "WenQuanYi Zen Hei", ":lang=zh"]) {
    const res = await run("fc-match", ["-f", "%{file}", query], { timeoutMs: 15_000 });
    const file = res.stdout.trim();
    if (res.code === 0 && file && /\.(ttf|otf|ttc)$/i.test(file) && fs.existsSync(file)) {
      // fc-match always returns *something*; make sure it really covers Chinese.
      const check = await run("fc-list", [":lang=zh", "file"], { timeoutMs: 15_000 });
      if (check.stdout.includes(file)) return (cachedFont = file);
    }
  }
  const any = await run("fc-list", [":lang=zh", "file"], { timeoutMs: 15_000 });
  const first = any.stdout.split("\n").map((l) => l.replace(/:\s*$/, "").trim()).find((l) => /\.(ttf|otf|ttc)$/i.test(l));
  cachedFont = first ?? null;
  return first;
}
