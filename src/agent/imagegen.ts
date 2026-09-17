import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { run } from "../util/exec.js";
import { getModels } from "../runtimeConfig.js";
import { recordUsage } from "../usage.js";

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
  /** Job to attribute the call to in the usage ledger. */
  jobId?: string;
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

interface ImagesApiTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** OpenAI Images API (generations / edits) against any compatible endpoint: OpenAI itself or the relay. */
async function imagesApiGenerate(o: GenerateOptions, t: ImagesApiTarget): Promise<{ buf: Buffer; usage?: { input_tokens?: number; output_tokens?: number } }> {
  const size = o.size ?? "1024x1536";
  const headers: Record<string, string> = { authorization: `Bearer ${t.apiKey}` };
  const image = { openaiBaseUrl: t.baseUrl, openaiModel: t.model };
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
  const json = JSON.parse(text) as { data?: Array<{ b64_json?: string; url?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
  const item = json.data?.[0];
  if (!item) throw new Error(`OpenAI images API returned no image: ${text.slice(0, 300)}`);
  let buf: Buffer;
  if (item.b64_json) buf = Buffer.from(item.b64_json, "base64");
  else if (item.url) {
    // Edits on the relay come back as a URL (asset host); fetch it right away, the link is short-lived.
    const dl = await fetch(item.url, { signal: AbortSignal.timeout(120_000) });
    if (!dl.ok) throw new Error(`could not download generated image (${dl.status}) from ${item.url}`);
    buf = Buffer.from(await dl.arrayBuffer());
  } else throw new Error("OpenAI images API returned neither b64_json nor url");
  fs.mkdirSync(path.dirname(o.outPath), { recursive: true });
  fs.writeFileSync(o.outPath, buf);
  return { buf, usage: json.usage };
}

async function openaiGenerate(o: GenerateOptions): Promise<GenerateResult> {
  const { image } = getConfig();
  if (!image.openaiKey) throw new Error("OPENAI_IMAGE_API_KEY (or OPENAI_API_KEY) is not set");
  const { buf } = await imagesApiGenerate(o, { baseUrl: image.openaiBaseUrl, apiKey: image.openaiKey, model: image.openaiModel });
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

/**
 * Image generation through the relay: gpt-image-* via the OpenAI Images API (native transparent
 * background for the subject layer), gemini-*-image via chat completions (cheaper, no alpha).
 * The relay reports token usage but no price, so the ledger records the call with cost 0.
 */
/**
 * Gemini image models on the relay (gemini-*-image) are not routed to the Images API ("only imagen
 * models are supported"); they answer on chat completions with the image inlined as a data URL
 * (markdown `![image](data:image/png;base64,…)` or an `images[]` array). No alpha: the tool tells the
 * model to use chroma_key for the subject layer.
 */
async function relayChatImageGenerate(o: GenerateOptions, t: ImagesApiTarget): Promise<{ buf: Buffer; usage?: { input_tokens?: number; output_tokens?: number } }> {
  const size = o.size ?? "1024x1536";
  const [w, h] = size.split("x").map(Number);
  const ratio = w === h ? "1:1" : w > h ? "3:2" : "2:3";
  const content: unknown[] = [];
  for (const img of o.images ?? []) content.push({ type: "image_url", image_url: { url: `data:${mimeOf(img)};base64,${fs.readFileSync(img).toString("base64")}` } });
  content.push({ type: "text", text: `${o.prompt}\n\nOutput a single image with aspect ratio ${ratio} (${size}). Reply with the image only, no text.` });
  const res = await fetch(`${t.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${t.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: t.model, messages: [{ role: "user", content }], modalities: ["image", "text"] }),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`relay chat image API ${res.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; image_url?: { url?: string }; text?: string }>; images?: Array<{ image_url?: { url?: string } }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const msg = json.choices?.[0]?.message;
  const urls: string[] = [];
  for (const im of msg?.images ?? []) if (im.image_url?.url) urls.push(im.image_url.url);
  const c = msg?.content;
  if (typeof c === "string") for (const m of c.matchAll(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g)) urls.push(m[0]);
  else for (const part of c ?? []) if (part.image_url?.url) urls.push(part.image_url.url);
  const url = urls[0];
  if (!url) throw new Error(`relay chat image API returned no image: ${text.slice(0, 300)}`);
  const m = /^data:image\/[a-z]+;base64,(.+)$/.exec(url);
  const buf = m ? Buffer.from(m[1], "base64") : Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(120_000) })).arrayBuffer());
  fs.mkdirSync(path.dirname(o.outPath), { recursive: true });
  fs.writeFileSync(o.outPath, buf);
  return { buf, usage: { input_tokens: json.usage?.prompt_tokens, output_tokens: json.usage?.completion_tokens } };
}

/** Models the relay serves through the OpenAI Images API (with native alpha); everything else goes via chat. */
const IMAGES_API_MODEL = /^(gpt-image|dall-e)/i;

async function relayGenerate(o: GenerateOptions): Promise<GenerateResult> {
  const { relay } = getConfig();
  if (!relay.apiKey) throw new Error("RELAY_API_KEY is not set (put it in .env.local)");
  const model = getModels().imageModel;
  const target = { baseUrl: `${relay.baseUrl}/v1`, apiKey: relay.apiKey, model };
  const { buf, usage } = IMAGES_API_MODEL.test(model) ? await imagesApiGenerate(o, target) : await relayChatImageGenerate(o, target);
  recordUsage({
    kind: "image",
    jobId: o.jobId,
    model,
    provider: "relay",
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    source: "none",
  });
  return {
    path: o.outPath,
    provider: "relay",
    model,
    bytes: buf.length,
    transparentRequested: Boolean(o.transparent),
    transparentSupported: IMAGES_API_MODEL.test(model),
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
  let result: GenerateResult;
  try {
    result =
      image.provider === "mock" ? await mockGenerate(o)
      : image.provider === "gemini" ? await geminiGenerate(o)
      : image.provider === "openai" ? await openaiGenerate(o)
      : await relayGenerate(o);
  } catch (err) {
    // pi hands the error text to the model (which usually retries); log it so operators see it too.
    log.warn(`generate ${path.basename(o.outPath)} failed after ${Math.round((Date.now() - started) / 1000)}s: ${String(err instanceof Error ? err.message : err).slice(0, 400)}`);
    throw err;
  }
  if (image.provider === "openai" || image.provider === "gemini") {
    // Direct providers do not tell us the price; count the call so per-job call counts stay complete.
    recordUsage({ kind: "image", jobId: o.jobId, model: `${image.provider}/${result.model}`, provider: image.provider, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, source: "none" });
  }
  log.info(`generated ${path.basename(o.outPath)} in ${Math.round((Date.now() - started) / 1000)}s (${result.bytes} bytes)`);
  return result;
}

export function imageProviderReady(): { ok: boolean; reason: string } {
  const { image } = getConfig();
  if (image.provider === "mock") return { ok: true, reason: "mock (Pillow placeholders — testing only, not for real orders)" };
  if (image.provider === "relay") {
    const { relay } = getConfig();
    return relay.apiKey ? { ok: true, reason: `relay ${getModels().imageModel} @ ${relay.baseUrl}` } : { ok: false, reason: "RELAY_API_KEY missing (.env.local)" };
  }
  if (image.provider === "gemini") return image.geminiKey ? { ok: true, reason: `gemini/${image.geminiModel}` } : { ok: false, reason: "GEMINI_API_KEY missing" };
  return image.openaiKey
    ? { ok: true, reason: `openai/${image.openaiModel} @ ${image.openaiBaseUrl}` }
    : { ok: false, reason: "OPENAI_IMAGE_API_KEY / OPENAI_API_KEY missing" };
}
