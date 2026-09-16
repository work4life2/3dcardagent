import path from "node:path";
import fs from "node:fs";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../config.js";
import { run } from "../util/exec.js";
import { generateImage, type ImageSize } from "./imagegen.js";

/**
 * Custom tools exposed to the pi agent. They are the "built-in image-generation tool"
 * that the holo-card-studio skill assumes exists, plus Pillow helpers for verification.
 *
 * `baseDir` restricts every path argument to the job directory.
 */
export function createHoloTools(baseDir: string) {
  const resolveIn = (p: string): string => {
    const abs = path.resolve(baseDir, p);
    if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) {
      throw new Error(`path ${p} is outside the project directory ${baseDir}`);
    }
    return abs;
  };

  const python = process.env.PYTHON ?? "python3";
  const imgtool = path.join(getConfig().toolsDir, "imgtool.py");

  async function pyJson(args: string[]): Promise<Record<string, unknown>> {
    const res = await run(python, [imgtool, ...args], { cwd: baseDir, timeoutMs: 120_000 });
    const text = res.stdout.trim().split("\n").pop() ?? "";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`imgtool ${args[0]} failed: ${(res.stderr || res.stdout).slice(-500)}`);
    }
    if (parsed.error) throw new Error(String(parsed.error));
    return parsed;
  }

  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

  const sizeSchema = Type.Union([Type.Literal("1024x1536"), Type.Literal("1024x1024"), Type.Literal("1536x1024")], {
    description: "Output size. Cards are portrait: use 1024x1536 for every card layer.",
  });

  const generate_image = defineTool({
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate a raster image (PNG) from a text prompt with the configured image model and save it into the project. " +
      "Use transparent=true for the isolated subject layer so the PNG carries real alpha. " +
      "Optional reference_images (paths) are sent to the model as visual references / edit sources.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Detailed art prompt (style, subject, composition, palette, what must stay empty)." }),
      out_path: Type.String({ description: "Relative output path, e.g. assets/background.png" }),
      size: Type.Optional(sizeSchema),
      transparent: Type.Optional(Type.Boolean({ description: "Request a transparent background (subject cut-out)." })),
      reference_images: Type.Optional(Type.Array(Type.String(), { description: "Relative paths of reference images." })),
    }),
    execute: async (_id, p) => {
      const out = resolveIn(p.out_path);
      const refs = (p.reference_images ?? []).map(resolveIn);
      const r = await generateImage({
        prompt: p.prompt,
        outPath: out,
        size: (p.size as ImageSize | undefined) ?? "1024x1536",
        transparent: p.transparent,
        images: refs.length ? refs : undefined,
      });
      const info = await pyJson(["inspect", out]);
      const note =
        p.transparent && !r.transparentSupported
          ? " NOTE: this provider cannot output alpha. Generate the subject on a flat solid green (#00FF00) background and run chroma_key, or use derive tools."
          : "";
      return text(`Saved ${p.out_path} (${r.provider}/${r.model}, ${r.bytes} bytes). Inspection: ${JSON.stringify(info)}.${note}`);
    },
  });

  const edit_image = defineTool({
    name: "edit_image",
    label: "Edit image",
    description:
      "Edit an existing image with a text instruction while keeping its canvas, framing and identity (e.g. turn artwork A into state B, " +
      "or trace a subject into lineart). Optional mask_path (PNG; transparent = editable area).",
    parameters: Type.Object({
      prompt: Type.String(),
      image_path: Type.String({ description: "Relative path of the source image." }),
      out_path: Type.String(),
      size: Type.Optional(sizeSchema),
      transparent: Type.Optional(Type.Boolean()),
      mask_path: Type.Optional(Type.String()),
    }),
    execute: async (_id, p) => {
      const out = resolveIn(p.out_path);
      const r = await generateImage({
        prompt: p.prompt,
        outPath: out,
        size: (p.size as ImageSize | undefined) ?? "1024x1536",
        transparent: p.transparent,
        images: [resolveIn(p.image_path)],
        maskPath: p.mask_path ? resolveIn(p.mask_path) : undefined,
      });
      const info = await pyJson(["inspect", out]);
      return text(`Saved ${p.out_path} (${r.provider}/${r.model}). Inspection: ${JSON.stringify(info)}`);
    },
  });

  const inspect_image = defineTool({
    name: "inspect_image",
    label: "Inspect image",
    description:
      "Report size, mode and whether a PNG has genuine transparency (alpha), plus dark/light fractions. " +
      "Use it to verify subject.png / text.png have real alpha and lineart.png is dark-on-white before running the pipeline.",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, p) => text(JSON.stringify(await pyJson(["inspect", resolveIn(p.path)]))),
  });

  const derive_lineart = defineTool({
    name: "derive_lineart",
    label: "Derive lineart",
    description:
      "Deterministically derive lineart.png (dark contours on white, pixel-registered to the subject canvas) from subject.png " +
      "using its alpha silhouette and luminance edges. Preferred over asking the image model to trace, because registration is exact.",
    parameters: Type.Object({
      subject_path: Type.String({ description: "Relative path to the subject PNG with alpha." }),
      out_path: Type.String({ description: "e.g. assets/lineart.png" }),
      threshold: Type.Optional(Type.Integer({ minimum: 10, maximum: 200, description: "Edge threshold (default 60). Lower = more inner detail." })),
      thickness: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "Line thickness in px (default 2)." })),
    }),
    execute: async (_id, p) => {
      const args = ["lineart", resolveIn(p.subject_path), resolveIn(p.out_path)];
      if (p.threshold) args.push("--threshold", String(p.threshold));
      if (p.thickness) args.push("--thickness", String(p.thickness));
      return text(JSON.stringify(await pyJson(args)));
    },
  });

  const chroma_key = defineTool({
    name: "chroma_key",
    label: "Chroma key",
    description:
      "Remove a flat background colour (sampled from the corners) from an image and write a PNG with real alpha. " +
      "Fallback when the image model cannot output transparency: generate the subject on a flat #00FF00 background first.",
    parameters: Type.Object({
      image_path: Type.String(),
      out_path: Type.String(),
      tolerance: Type.Optional(Type.Integer({ minimum: 5, maximum: 200 })),
      feather: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
    }),
    execute: async (_id, p) => {
      const args = ["chroma-key", resolveIn(p.image_path), resolveIn(p.out_path)];
      if (p.tolerance) args.push("--tolerance", String(p.tolerance));
      if (p.feather !== undefined) args.push("--feather", String(p.feather));
      return text(JSON.stringify(await pyJson(args)));
    },
  });

  const resize_image = defineTool({
    name: "resize_image",
    label: "Resize image",
    description: "Resize/crop an image to exact dimensions (cover fit) so all card layers share one canvas size.",
    parameters: Type.Object({
      image_path: Type.String(),
      out_path: Type.String(),
      width: Type.Integer({ minimum: 64 }),
      height: Type.Integer({ minimum: 64 }),
    }),
    execute: async (_id, p) =>
      text(JSON.stringify(await pyJson(["resize", resolveIn(p.image_path), resolveIn(p.out_path), String(p.width), String(p.height)]))),
  });

  const list_fonts = defineTool({
    name: "list_fonts",
    label: "List fonts",
    description: "List installed font files (TTF/OTF/TTC) that can be referenced by card-config.json `font` for the typography layer.",
    parameters: Type.Object({}),
    execute: async () => {
      const res = await run("fc-list", ["--format", "%{file}|%{family}\n"], { timeoutMs: 20_000 });
      const lines = res.stdout.split("\n").filter(Boolean);
      const preferred = lines.filter((l) => /cjk|noto|source han|wenquanyi|simkai|kai|hei|song|dejavu/i.test(l));
      const shown = (preferred.length ? preferred : lines).slice(0, 60);
      const bundled = path.join(getConfig().toolsDir, "fonts");
      const extra = fs.existsSync(bundled) ? fs.readdirSync(bundled).map((f) => path.join(bundled, f) + "|bundled") : [];
      return text([...extra, ...shown].join("\n") || "no fonts found by fc-list");
    },
  });

  return [generate_image, edit_image, inspect_image, derive_lineart, chroma_key, resize_image, list_fonts];
}

export const HOLO_TOOL_NAMES = ["generate_image", "edit_image", "inspect_image", "derive_lineart", "chroma_key", "resize_image", "list_fonts"];
