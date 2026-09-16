import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { run } from "../util/exec.js";

const log = logger("imagegen");

export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";

export interface GenerateOptions {
  prompt: string;
  outPath: string;
  size?: ImageSize;
  transparent?: boolean;
  /** Reference / source images. With OpenAI these go to /images/edits; Gemini takes them inline. */
  images?: string[];
  maskPath?: string;
}

export interface GenerateResult {
  path: string;
  provider: string;
  model: string;
  bytes: number;
  transparentRequested: boolean;
  transparentSupported: boolean;
}

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
}

async function openaiGenerate(o: GenerateOptions): Promise<GenerateResult> {
  const { image } = getConfig();
  if (!image.openaiKey) throw new Error("OPENAI_IMAGE_API_KEY (or OPENAI_API_KEY) is not set");
  const size = o.size ?? "1024x1536";
  const headers: Record<string, string> = { authorization: `Bearer ${image.openaiKey}` };
  let res: Response;
  if (o.images && o.images.length > 0) {
    const form = new FormData();
    form.set("model", image.openaiModel);
    form.set("prompt", o.prompt);
    form.set("size", size);
    form.set("n", "1");
    if (o.transparent) form.set("background", "transparent");
    for (const img of o.images) {
      const buf = fs.readFileSync(img);
      form.append("image[]", new Blob([buf], { type: mimeOf(img) }), path.basename(img));
    }
    if (o.maskPath) {
      form.set("mask", new Blob([fs.readFileSync(o.maskPath)], { type: "image/png" }), "mask.png");
    }
    res = await fetch(`${image.openaiBaseUrl}/images/edits`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
  } else {
    const body: Record<string, unknown> = { model: image.openaiModel, prompt: o.prompt, size, n: 1 };
    if (o.transparent) body.background = "transparent";
    if (/gpt-image/i.test(image.openaiModel)) body.output_format = "png";
    res = await fetch(`${image.openaiBaseUrl}/images/generations`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI images API ${res.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text) as { data?: Array<{ b64_json?: string; url?: string }> };
  const item = json.data?.[0];
  if (!item) throw new Error(`OpenAI images API returned no image: ${text.slice(0, 300)}`);
  let buf: Buffer;
  if (item.b64_json) buf = Buffer.from(item.b64_json, "base64");
  else if (item.url) buf = Buffer.from(await (await fetch(item.url)).arrayBuffer());
  else throw new Error("OpenAI images API returned neither b64_json nor url");
  fs.mkdirSync(path.dirname(o.outPath), { recursive: true });
  fs.writeFileSync(o.outPath, buf);
  return {
    path: o.outPath,
    provider: "openai",
    model: image.openaiModel,
    bytes: buf.length,
    transparentRequested: Boolean(o.transparent),
    transparentSupported: true,
  };
}

async function geminiGenerate(o: GenerateOptions): Promise<GenerateResult> {
  const { image } = getConfig();
  if (!image.geminiKey) throw new Error("GEMINI_API_KEY is not set");
  const parts: unknown[] = [];
  for (const img of o.images ?? []) {
    parts.push({ inline_data: { mime_type: mimeOf(img), data: fs.readFileSync(img).toString("base64") } });
  }
  const size = o.size ?? "1024x1536";
  const [w, h] = size.split("x").map(Number);
  const ratio = w === h ? "1:1" : w > h ? "3:2" : "2:3";
  parts.push({ text: `${o.prompt}\n\nOutput a single image with aspect ratio ${ratio}.` });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${image.geminiModel}:generateContent?key=${encodeURIComponent(image.geminiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE"] } }),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data: string; mimeType: string } }> } }>;
  };
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part?.inlineData) throw new Error(`Gemini returned no image: ${text.slice(0, 300)}`);
  const buf = Buffer.from(part.inlineData.data, "base64");
  fs.mkdirSync(path.dirname(o.outPath), { recursive: true });
  fs.writeFileSync(o.outPath, buf);
  return {
    path: o.outPath,
    provider: "gemini",
    model: image.geminiModel,
    bytes: buf.length,
    transparentRequested: Boolean(o.transparent),
    transparentSupported: false,
  };
}

async function mockGenerate(o: GenerateOptions): Promise<GenerateResult> {
  const [w, h] = (o.size ?? "1024x1536").split("x");
  const { toolsDir } = getConfig();
  fs.mkdirSync(path.dirname(o.outPath), { recursive: true });
  const res = await run(process.env.PYTHON ?? "python3", [
    path.join(toolsDir, "imgtool.py"), "mock", o.outPath, "--width", w, "--height", h, "--transparent", o.transparent ? "1" : "0", "--seed", o.prompt.slice(0, 200),
  ], { timeoutMs: 60_000 });
  if (res.code !== 0) throw new Error(`mock image failed: ${res.stderr.slice(-300)}`);
  return { path: o.outPath, provider: "mock", model: "pillow", bytes: fs.statSync(o.outPath).size, transparentRequested: !!o.transparent, transparentSupported: true };
}

export async function generateImage(o: GenerateOptions): Promise<GenerateResult> {
  const { image } = getConfig();
  log.info(`generate via ${image.provider}`, { out: path.basename(o.outPath), transparent: !!o.transparent, refs: o.images?.length ?? 0 });
  const started = Date.now();
  const result = image.provider === "mock" ? await mockGenerate(o) : image.provider === "gemini" ? await geminiGenerate(o) : await openaiGenerate(o);
  log.info(`generated ${path.basename(o.outPath)} in ${Math.round((Date.now() - started) / 1000)}s (${result.bytes} bytes)`);
  return result;
}

export function imageProviderReady(): { ok: boolean; reason: string } {
  const { image } = getConfig();
  if (image.provider === "mock") return { ok: true, reason: "mock (Pillow placeholders — testing only, not for real orders)" };
  if (image.provider === "gemini") return image.geminiKey ? { ok: true, reason: `gemini/${image.geminiModel}` } : { ok: false, reason: "GEMINI_API_KEY missing" };
  return image.openaiKey
    ? { ok: true, reason: `openai/${image.openaiModel} @ ${image.openaiBaseUrl}` }
    : { ok: false, reason: "OPENAI_IMAGE_API_KEY / OPENAI_API_KEY missing" };
}
