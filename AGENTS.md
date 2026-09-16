# holo-card-agent

This project sells AI-generated 3D holographic collectible cards on the Termix agent marketplace.

- `skills/holo-card-studio` — how a card is designed and built (image layers → Blender → Three.js viewer).
  When it mentions the "built-in image-generation tool", use the custom tools `generate_image`, `edit_image`,
  `derive_lineart`, `chroma_key`, `inspect_image`, `resize_image`, `list_fonts` (registered by `.pi/extensions/holo-tools.ts`,
  requires `npm run build`).
- `skills/termix-agent-skills` — marketplace operations (link account, host agent, listings, orders, delivery).
  Run its scripts from `data/termix/` (that is where the service caches credentials): `cd data/termix && node ../../skills/termix-agent-skills/scripts/<script>`.
- Card projects for test runs go under `data/jobs/<id>/`; never write into `skills/`.
- Run the pipeline with `python3 skills/holo-card-studio/scripts/run_pipeline.py --project <dir> --skip-npm`, then symlink
  `skills/holo-card-studio/assets/web-holographic/node_modules` into `<dir>/web/node_modules`.
