/**
 * Open Graph / Twitter card tags for the hosted copy of a card.
 *
 * X's post composer cannot attach an image to an intent link: the picture in the tweet is whatever
 * its crawler finds behind `url=`. So the hosted page — and only the hosted page — carries absolute
 * og:/twitter: tags. They are injected on the way to the bucket rather than written to disk, which
 * keeps the buyer's zip free of host-specific URLs (they would do nothing under file:// anyway).
 */

export interface ShareMeta {
  /** Canonical page URL, without the ?from=x tracking marker used in tweets. */
  shareUrl: string;
  imageUrl?: string;
  title: string;
  lang: "zh" | "en";
}

const DESCRIPTION = {
  zh: "拖动转卡，看光影随角度流动 · 由 Holo Card Studio 生成",
  en: "Drag to tilt this 3D holo card and watch the foil move — made by Holo Card Studio",
} as const;

const TITLE_SUFFIX = { zh: " · 全息典藏卡", en: " · a 3D holographic card" } as const;

/** Card text is model-authored and routinely contains quotes, ampersands and angle brackets. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function meta(attr: "property" | "name", key: string, value: string): string {
  return `<meta ${attr}="${key}" content="${escapeAttr(value)}">`;
}

/** Insert the tags right after <head>, leaving the rest of the document untouched. */
export function withShareMeta(html: string, m: ShareMeta): string {
  const description = DESCRIPTION[m.lang];
  const title = m.title + TITLE_SUFFIX[m.lang];
  const tags = [
    meta("property", "og:type", "website"),
    meta("property", "og:url", m.shareUrl),
    meta("property", "og:title", title),
    meta("property", "og:description", description),
    meta("name", "twitter:title", title),
    meta("name", "twitter:description", description),
  ];
  if (m.imageUrl) {
    tags.push(
      meta("property", "og:image", m.imageUrl),
      meta("property", "og:image:width", "1200"),
      meta("property", "og:image:height", "630"),
      meta("name", "twitter:card", "summary_large_image"),
      meta("name", "twitter:image", m.imageUrl),
    );
  } else {
    // No render to show: a plain link card still beats a broken image reference.
    tags.push(meta("name", "twitter:card", "summary"));
  }
  const block = tags.join("");
  return html.includes("<head>") ? html.replace("<head>", `<head>${block}`) : html.replace(/(<head[^>]*>)/, `$1${block}`);
}
