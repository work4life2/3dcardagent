// Relay smoke test: one chat completion and one image through the OpenAI-compatible relay.
//   RELAY_API_KEY lives in .env.local (git-ignored). Run from the project root:
//   node --env-file=.env.local examples/relay/index.ts
import fs from "node:fs";

const base = (process.env.RELAY_BASE_URL ?? "https://www.cun.ai").replace(/\/+$/, "");
const key = process.env.RELAY_API_KEY;
if (!key) throw new Error("RELAY_API_KEY is not set");
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

const chat = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    model: process.env.MODEL ?? "gemini-3-flash",
    messages: [{ role: "user", content: "Invent a brand-new holiday. Give it a name, the date it is celebrated, and describe three of its traditions." }],
  }),
});
const c = (await chat.json()) as { choices?: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number; completion_tokens: number }; error?: unknown };
if (!chat.ok || c.error) throw new Error(`chat failed: ${JSON.stringify(c.error ?? c).slice(0, 300)}`);
console.log(c.choices?.[0]?.message.content);
console.log(`\n[usage] input=${c.usage?.prompt_tokens} output=${c.usage?.completion_tokens}`);

const img = await fetch(`${base}/v1/images/generations`, {
  method: "POST",
  headers,
  body: JSON.stringify({ model: process.env.IMAGE_MODEL ?? "gpt-image-2", prompt: "a holographic trading card of a chrome cat, transparent background", size: "1024x1024", n: 1, background: "transparent", output_format: "png" }),
});
const i = (await img.json()) as { data?: Array<{ b64_json?: string; url?: string }>; error?: unknown };
if (!img.ok || i.error) throw new Error(`image failed: ${JSON.stringify(i.error ?? i).slice(0, 300)}`);
const item = i.data?.[0];
const buf = item?.b64_json ? Buffer.from(item.b64_json, "base64") : Buffer.from(await (await fetch(item!.url!)).arrayBuffer());
fs.writeFileSync("relay-smoke.png", buf);
console.log(`[image] wrote relay-smoke.png (${buf.length} bytes)`);
