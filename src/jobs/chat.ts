import { logger } from "../log.js";
import { getConfig } from "../config.js";
import { chatSystemPrompt } from "../agent/prompts.js";
import { createChatSession, promptForText } from "../agent/session.js";
import { termix, type RemoteMessage, type WatchEvent } from "../termix/client.js";
import { briefFromMessages, imageUrlsIn, messagesForOrder, offerStateFromMessages } from "../termix/brief.js";
import { findJobByOrder, loadConversation, saveConversation, type ConversationLog, type OfferRecord } from "./store.js";
import { isChinese } from "../util/lang.js";

const log = logger("chat");

function senderName(from: WatchEvent["from"]): string {
  if (!from) return "buyer";
  if (typeof from === "string") return from;
  return from.displayName || from.handle || from.walletAddress || "buyer";
}

/** The machine-readable quote the chat model appends when it decides to send one. */
const OFFER_LINE = /^\s*OFFER:\s*(\{[\s\S]*\})\s*$/m;

export interface ParsedOffer {
  price: string;
  deliveryDays: number;
  scope: string;
}

/** Split the model's reply into buyer-facing text and an optional quote. Invalid quotes are dropped, never sent. */
export function parseOfferReply(reply: string): { text: string; offer?: ParsedOffer } {
  const m = OFFER_LINE.exec(reply);
  if (!m) return { text: reply.trim() };
  const text = reply.replace(m[0], "").trim();
  try {
    const raw = JSON.parse(m[1]) as Record<string, unknown>;
    const price = String(raw.price ?? "").trim();
    const deliveryDays = Math.round(Number(raw.deliveryDays));
    const scope = String(raw.scope ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(price) || Number(price) <= 0) return { text };
    if (!Number.isFinite(deliveryDays) || deliveryDays < 1 || deliveryDays > 30) return { text };
    if (scope.length < 10) return { text };
    return { text, offer: { price, deliveryDays, scope: scope.slice(0, 2000) } };
  } catch {
    return { text };
  }
}

/** Transcript lines for the model, from the server's message list (falls back to the local log). */
function historyLines(remote: RemoteMessage[] | undefined, conv: ConversationLog): string {
  if (remote?.length) {
    const recent = remote.filter((m) => m.direction !== "event" || m.kind === "OFFER_EVENT").slice(-16);
    return briefFromMessages(recent).transcript;
  }
  return conv.messages
    .slice(-12)
    .map((m) => `${m.role === "buyer" ? "Buyer" : "You"}: ${m.text}`)
    .join("\n");
}

async function fetchImages(urls: string[]): Promise<Array<{ mediaType: string; data: string }>> {
  const images: Array<{ mediaType: string; data: string }> = [];
  for (const url of urls.slice(-2)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) images.push({ mediaType: res.headers.get("content-type") ?? "image/png", data: Buffer.from(await res.arrayBuffer()).toString("base64") });
    } catch {
      /* ignore */
    }
  }
  return images;
}

function quoteNotice(offer: OfferRecord, zh: boolean, revised: boolean): string {
  if (zh) {
    return revised
      ? `📄 报价已更新为 ${offer.price} ${offer.currency}（${offer.deliveryDays} 天内交付）。请在本会话中接受最新报价并完成支付，付款后我们会立即开始制作。`
      : `📄 已在本会话中向您发送报价：${offer.price} ${offer.currency}，${offer.deliveryDays} 天内交付。接受报价并完成支付后，我们会立即按上述需求开始制作。`;
  }
  return revised
    ? `📄 The quote has been updated to ${offer.price} ${offer.currency} (delivery within ${offer.deliveryDays} day(s)). Accept the latest quote in this conversation and fund it; work starts right after payment.`
    : `📄 A quote has been sent in this conversation: ${offer.price} ${offer.currency}, delivery within ${offer.deliveryDays} day(s). Accept it and fund the escrow, and we start on the brief above immediately.`;
}

function quoteFallback(zh: boolean): string {
  return zh
    ? "（报价发送失败，您也可以直接购买我们的 listing 下单，需求以本会话内容为准。）"
    : "(The quote could not be sent right now; you can also order directly from our listing, and this conversation counts as the brief.)";
}

/**
 * Send (or revise) a quote in the conversation. The quote's scope is the consolidated brief: when the
 * buyer accepts, the platform copies it into the order, so the build sees exactly what was agreed.
 */
async function placeOffer(conv: ConversationLog, parsed: ParsedOffer, remote: RemoteMessage[] | undefined): Promise<{ record: OfferRecord; revised: boolean }> {
  const { service } = getConfig();
  const tx = termix();
  const local = conv.offers?.filter((o) => o.status === "active").at(-1);
  const remoteState = remote ? offerStateFromMessages(remote) : undefined;
  const activeId = remoteState?.status === "active" ? remoteState.offerId : local && remoteState?.offerId === local.offerId && remoteState.status !== "active" ? undefined : local?.offerId;
  const currency = local?.currency ?? service.currency;
  const input = { price: parsed.price, currency, deliveryDays: parsed.deliveryDays, scope: parsed.scope, message: "Quote from the studio — accept to start" };
  let revised = false;
  let res;
  if (activeId) {
    try {
      res = await tx.reviseOffer(activeId, input);
      revised = true;
    } catch (err) {
      log.warn(`revise offer ${activeId} failed (${String(err).slice(0, 200)}); sending a fresh quote`);
    }
  }
  if (!res) res = await tx.sendOffer(conv.id, input);
  conv.offers ??= [];
  for (const o of conv.offers) if (o.status === "active" && o.offerId !== res.id) o.status = "superseded";
  const record: OfferRecord = {
    offerId: res.id,
    revisionId: res.current?.id ?? res.currentRevisionId,
    version: res.current?.version,
    price: parsed.price,
    currency,
    deliveryDays: parsed.deliveryDays,
    scope: parsed.scope,
    at: new Date().toISOString(),
    status: "active",
  };
  conv.offers = [...conv.offers.filter((o) => o.offerId !== res.id), record];
  return { record, revised };
}

/** Answer a buyer message with the chat model and post the reply through the runtime. */
export async function handleChatMessage(ev: WatchEvent): Promise<void> {
  const conversationId = ev.conversationId;
  const text = (ev.text ?? "").trim();
  if (!conversationId || !text) return;
  const conv = loadConversation(conversationId);
  if (ev.messageId && conv.messages.some((m) => m.messageId === ev.messageId)) return; // already handled
  if (ev.orderId) conv.orderId = String(ev.orderId);
  conv.buyer = senderName(ev.from);
  const refs = imageUrlsIn(text);
  conv.messages.push({ role: "buyer", text, at: new Date().toISOString(), messageId: ev.messageId, from: conv.buyer, refs: refs.length ? refs : undefined });
  saveConversation(conv);

  const tx = termix();
  await tx.signal(conversationId);
  const keepAlive = setInterval(() => void tx.signal(conversationId), 30_000);
  try {
    const remote = (await tx.conversation(conversationId))?.messages;
    const context: string[] = [];
    context.push(`Buyer: ${conv.buyer}.`);
    const orderId = conv.orderId ?? (ev.orderId ? String(ev.orderId) : undefined);
    if (orderId) {
      const job = findJobByOrder(orderId);
      if (job) {
        context.push(`This conversation belongs to order ${orderId}. Job status: ${job.status}${job.previewUrl ? `, preview: ${job.previewUrl}` : ""}${job.error ? `, last error: ${job.error}` : ""}.`);
      } else {
        context.push(`This conversation belongs to order ${orderId}; no build has started yet (it starts automatically once the order is funded).`);
      }
    }
    const remoteState = remote ? offerStateFromMessages(remote) : undefined;
    const activeLocal = conv.offers?.filter((o) => o.status === "active").at(-1);
    if (remoteState?.status === "active" || (activeLocal && (!remoteState || remoteState.offerId !== activeLocal.offerId))) {
      const o = remoteState?.status === "active" ? remoteState : activeLocal!;
      context.push(`An ACTIVE quote already exists in this conversation: ${o.price} ${o.currency ?? ""}${"scope" in o && o.scope ? ` — scope: ${String(o.scope).slice(0, 400)}` : ""}. Emit an OFFER line again only to change its terms (it becomes a revision).`);
    } else if (remoteState && remoteState.status !== "active") {
      context.push(`The previous quote in this conversation is ${remoteState.status}. A new brief needs a new OFFER line.`);
    }
    const { http } = getConfig();
    if (http.publicBaseUrl) context.push(`Gallery of delivered cards: ${http.publicBaseUrl}/cards/`);
    const history = historyLines(remote, conv);
    const prompt = `Context:\n${context.join("\n")}\n\nConversation so far (chronological; "You" is us):\n${history}\n\nWrite your next reply to the buyer (reply text only, no prefix). If you are quoting, end with the single OFFER line.`;

    // Show the model the buyer's most recent reference images (this message's, else the latest in the thread).
    const window = remote && orderId ? messagesForOrder(remote, orderId) : remote;
    const recentRefs = refs.length ? refs : window ? briefFromMessages(window.slice(-10)).refs : [];
    const images = await fetchImages(recentRefs);

    const jobId = orderId ? findJobByOrder(orderId)?.id : undefined;
    const session = await createChatSession(chatSystemPrompt(), { kind: "chat", conversationId, jobId });
    let raw: string;
    try {
      raw = await promptForText(session, prompt, images.length ? images : undefined);
    } finally {
      session.dispose();
    }
    const zh = isChinese(text) || isChinese(history);
    let { text: reply, offer } = parseOfferReply(raw);
    if (!reply && !offer) reply = zh ? "收到，马上处理，请稍等。" : "Got it — I am on it, one moment please.";
    if (offer) {
      try {
        const { record, revised } = await placeOffer(conv, offer, remote);
        reply = `${reply}\n\n${quoteNotice(record, zh, revised)}`.trim();
        log.info(`quote ${revised ? "revised" : "sent"} in ${conversationId}`, { offerId: record.offerId, price: record.price, currency: record.currency, deliveryDays: record.deliveryDays });
      } catch (err) {
        log.error(`could not send quote in ${conversationId}: ${String(err)}`);
        reply = `${reply}\n\n${quoteFallback(zh)}`.trim();
      }
    }
    await tx.reply(conversationId, reply, ev.messageId ? `auto-${ev.messageId}` : undefined);
    conv.messages.push({ role: "agent", text: reply, at: new Date().toISOString() });
    saveConversation(conv);
    log.info(`replied in ${conversationId}`, { chars: reply.length, quoted: Boolean(offer) });
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
