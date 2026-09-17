import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";

/**
 * Models can be switched at runtime without restarting the service. Overrides live in
 * DATA_DIR/runtime-config.json and win over the .env defaults; every new pi session /
 * image call reads them fresh.
 */
export interface ModelSettings {
  /** pi model for building cards (tool use), e.g. relay/gemini-3-flash */
  buildModel: string;
  /** pi model for buyer chat replies */
  chatModel: string;
  /** image model id for IMAGE_PROVIDER=relay, e.g. gpt-image-2 */
  imageModel: string;
  /** off | minimal | low | medium | high */
  thinking: string;
}

export type ModelKey = keyof ModelSettings;
export const MODEL_KEYS: ModelKey[] = ["buildModel", "chatModel", "imageModel", "thinking"];

function file(): string {
  return path.join(getConfig().dataDir, "runtime-config.json");
}

function readOverrides(): Partial<ModelSettings> {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<ModelSettings>;
  } catch {
    return {};
  }
}

export function getModels(): ModelSettings & { overrides: Partial<ModelSettings>; defaults: ModelSettings } {
  const cfg = getConfig();
  const o = readOverrides();
  const defaults: ModelSettings = { buildModel: cfg.llm.model, chatModel: cfg.llm.chatModel, imageModel: cfg.image.relayModel, thinking: cfg.llm.thinking };
  return {
    defaults,
    buildModel: o.buildModel || cfg.llm.model,
    chatModel: o.chatModel || cfg.llm.chatModel,
    imageModel: o.imageModel || cfg.image.relayModel,
    thinking: o.thinking || cfg.llm.thinking,
    overrides: o,
  };
}

export function setModels(patch: Partial<ModelSettings>): ModelSettings {
  const current = readOverrides();
  for (const k of MODEL_KEYS) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v === "" || v === "default") delete current[k];
    else current[k] = v.trim();
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(current, null, 2));
  const { overrides: _o, defaults: _d, ...rest } = getModels();
  return rest;
}
