import { logger } from "../log.js";
import { getConfig } from "../config.js";
import { chatSystemPrompt } from "../agent/prompts.js";
import { createChatSession, promptForText } from "../agent/session.js";
import { termix, type WatchEvent } from "../termix/client.js";
import { findJobByOrder, loadConversation, saveConversation } from "./store.js";
import { fetchWithFallback } from "../proxy.js";

const log = logger("chat");

function senderName(from: WatchEvent["from"]): string {
  if (!from) return "buyer";
  if (typeof from === "string") return from;
  return from.displayName || from.handle || from.walletAddress || "buyer";
}

function extractImageUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/\S+\.(?:png|jpe?g|webp)(?:\?\S*)?/gi)].map((m) => m[0]);
}

/** Answer a buyer message with the chat model and post the reply through the runtime. */
export async function handleChatMessage(ev: WatchEvent): Promise<void> {
  const conversationId = ev.conversationId;
  const text = (ev.text ?? "").trim();
  if (!conversationId || !text) return;
  const conv = loadConversation(conversationId);
  if (ev.messageId && conv.messages.some((m) => m.messageId === ev.messageId)) return; // already handled
  if (ev.orderId) conv.orderId = String(ev.orderId);
  conv.messages.push({ role: "buyer", text, at: new Date().toISOString(), messageId: ev.messageId });

  const tx = termix();
  await tx.signal(conversationId);
  const keepAlive = setInterval(() => void tx.signal(conversationId), 30_000);
  try {
    const context: string[] = [];
    context.push(`Buyer: ${senderName(ev.from)}.`);
    const orderId = conv.orderId ?? (ev.orderId ? String(ev.orderId) : undefined);
    if (orderId) {
      const job = findJobByOrder(orderId);
      if (job) {
        context.push(`This conversation belongs to order ${orderId}. Job status: ${job.status}${job.previewUrl ? `, preview: ${job.previewUrl}` : ""}${job.error ? `, last error: ${job.error}` : ""}.`);
      } else {
        context.push(`This conversation belongs to order ${orderId}; no build has started yet (it starts automatically once the order is funded).`);
      }
    }
    const { http } = getConfig();
    if (http.publicBaseUrl) context.push(`Gallery of delivered cards: ${http.publicBaseUrl}/cards/`);
    const history = conv.messages
      .slice(-12)
      .map((m) => `${m.role === "buyer" ? "Buyer" : "You"}: ${m.text}`)
      .join("\n");
    const prompt = `Context:\n${context.join("\n")}\n\nConversation so far (last messages):\n${history}\n\nWrite your next reply to the buyer (reply text only, no prefix).`;

    const images: Array<{ mediaType: string; data: string }> = [];
    for (const url of extractImageUrls(text).slice(0, 2)) {
      try {
        const res = await fetchWithFallback(url, { signal: AbortSignal.timeout(30_000) });
        if (res.ok) images.push({ mediaType: res.headers.get("content-type") ?? "image/png", data: Buffer.from(await res.arrayBuffer()).toString("base64") });
      } catch {
        /* ignore */
      }
    }

    const session = await createChatSession(chatSystemPrompt());
    let reply: string;
    try {
      reply = await promptForText(session, prompt, images.length ? images : undefined);
    } finally {
      session.dispose();
    }
    if (!reply) reply = "收到，我马上处理，请稍等。";
    await tx.reply(conversationId, reply, ev.messageId ? `auto-${ev.messageId}` : undefined);
    conv.messages.push({ role: "agent", text: reply, at: new Date().toISOString() });
    saveConversation(conv);
    log.info(`replied in ${conversationId}`, { chars: reply.length });
  } finally {
    clearInterval(keepAlive);
  }
}

/** Post a plain notice (delivery summary, failure) into a conversation, without the model. */
export async function postNotice(conversationId: string, text: string): Promise<void> {
  const conv = loadConversation(conversationId);
  await termix().reply(conversationId, text);
  conv.messages.push({ role: "agent", text, at: new Date().toISOString() });
  saveConversation(conv);
}
