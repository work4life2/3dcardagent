import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { getConfig } from "../config.js";
import { logger } from "../log.js";

const log = logger("standalone");

export interface StandaloneOptions {
  /**
   * Inline card.glb and the textures as data URLs (default). Required for the buyer's zip, which
   * is opened over file://. Set false for a copy served over HTTP — the same bundle, but assets
   * load normally so the page streams and caches instead of arriving as one ~15 MB script.
   */
  embed?: boolean;
}

/**
 * Turn a pipeline web viewer (ES modules + importmap + fetch, which only works behind an
 * HTTP server) into a folder that opens directly from disk: unzip → double-click index.html.
 *
 * - three.js + app.js are bundled into one classic script (file:// blocks module scripts).
 * - card-config.json and card.glb are embedded and served through a tiny fetch shim
 *   (file:// blocks fetch/XHR); textures keep loading through <img>, which file:// allows.
 */
export async function buildStandaloneViewer(
  webDir: string,
  outDir: string,
  mode: "holographic" | "lenticular",
  opts: StandaloneOptions = {},
): Promise<void> {
  const embed = opts.embed !== false;
  const cfg = getConfig();
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });

  const templateDir = path.join(cfg.holoSkillDir, "assets", mode === "lenticular" ? "web-lenticular" : "web-holographic");
  const nodeModules = [path.join(webDir, "node_modules"), path.join(templateDir, "node_modules")].find((d) => fs.existsSync(path.join(d, "three")));
  if (!nodeModules) throw new Error("three.js is not installed for the web viewer (run npm run setup)");

  const config = JSON.parse(fs.readFileSync(path.join(webDir, "card-config.json"), "utf8"));
  const glb = fs.readFileSync(path.join(webDir, "assets", "card.glb"));
  // Textures: three's ImageLoader sets crossOrigin="anonymous", which file:// rejects, so they are embedded as data URLs.
  const images: Record<string, string> = {};
  if (embed) {
    for (const f of fs.readdirSync(path.join(webDir, "assets"))) {
      if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
      const mime = /\.png$/i.test(f) ? "image/png" : /\.webp$/i.test(f) ? "image/webp" : "image/jpeg";
      images[`assets/${f}`] = `data:${mime};base64,${fs.readFileSync(path.join(webDir, "assets", f)).toString("base64")}`;
    }
  }

  // Copy textures and any other static assets. Over HTTP the GLB is fetched normally, so it is
  // only left out of the folder when it has been embedded.
  for (const f of fs.readdirSync(path.join(webDir, "assets"))) {
    if (f === "card.glb" && embed) continue;
    fs.copyFileSync(path.join(webDir, "assets", f), path.join(outDir, "assets", f));
  }
  fs.copyFileSync(path.join(webDir, "style.css"), path.join(outDir, "style.css"));
  fs.writeFileSync(path.join(outDir, "card-config.json"), JSON.stringify(config, null, 2));

  const shim = !embed
    ? ""
    : `
(() => {
  const EMBED = {
    config: ${JSON.stringify(config)},
    glb: "${glb.toString("base64")}",
    images: ${JSON.stringify(images)},
  };
  const imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    get() { return imgSrc.get.call(this); },
    set(v) {
      let key = String(v).split("?")[0]; if (key.startsWith("./")) key = key.slice(2);
      const hit = EMBED.images[key] || EMBED.images["assets/" + key.split("/").pop()];
      if (hit) { this.removeAttribute("crossorigin"); imgSrc.set.call(this, hit); } else imgSrc.set.call(this, v);
    },
  });
  const b64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (/card-config\\.json(\\?|$)/.test(url)) return Promise.resolve(new Response(JSON.stringify(EMBED.config), { status: 200, headers: { "content-type": "application/json" } }));
    if (/card\\.glb(\\?|$)/.test(url)) return Promise.resolve(new Response(b64(EMBED.glb), { status: 200, headers: { "content-type": "model/gltf-binary" } }));
    return realFetch(input, init);
  };
})();
`;
  const result = await build({
    entryPoints: [path.join(webDir, "app.js")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    write: false,
    nodePaths: [nodeModules],
    logLevel: "silent",
    charset: "utf8",
  });
  const js = result.outputFiles[0].text;
  fs.writeFileSync(path.join(outDir, "app.bundle.js"), js);
  // The shim must run before the bundle starts fetching, so it is a separate, non-deferred script.
  if (embed) fs.writeFileSync(path.join(outDir, "embed.js"), shim);

  let html = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
  html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, "");
  const scripts = (embed ? '<script src="./embed.js"></script>' : "") + '<script defer src="./app.bundle.js"></script>';
  html = html.replace(/<script type="module" src="\.?\/?app\.js"><\/script>/, scripts);
  if (!html.includes("app.bundle.js")) html = html.replace("</body>", scripts + "</body>");
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  if (embed) {
    fs.writeFileSync(
      path.join(outDir, "OPEN-ME.txt"),
      "Double-click index.html to view the card (no server needed). Drag to rotate, F to flip, R to reset, sliders tune the foil.\n",
    );
  }
  log.info(`${embed ? "standalone" : "hosted"} viewer written to ${outDir} (${Math.round(js.length / 1024)} KB bundle)`);
}
