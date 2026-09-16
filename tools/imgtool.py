#!/usr/bin/env python3
"""Pillow helpers used by the agent's custom image tools.

    imgtool.py inspect <image>
    imgtool.py lineart <subject.png> <out.png> [--threshold 60] [--thickness 2]
    imgtool.py chroma-key <in.png> <out.png> [--tolerance 40] [--feather 2]
    imgtool.py resize <in.png> <out.png> <width> <height>
    imgtool.py trim-alpha <in.png> <out.png>   (keep canvas size; zero out near-transparent pixels)

All commands print one JSON object on stdout.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


def inspect(path):
    with Image.open(path) as im:
        info = {"path": str(path), "width": im.width, "height": im.height, "mode": im.mode, "format": im.format}
        if "A" in im.getbands():
            alpha = im.getchannel("A")
            hist = alpha.histogram()
            total = im.width * im.height
            transparent = sum(hist[:8])
            opaque = sum(hist[248:])
            info["alpha"] = {
                "has_alpha": True,
                "transparent_fraction": round(transparent / total, 4),
                "opaque_fraction": round(opaque / total, 4),
                "genuine_transparency": transparent / total > 0.02,
            }
            bbox = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
            info["alpha"]["opaque_bbox"] = list(bbox) if bbox else None
        else:
            info["alpha"] = {"has_alpha": False, "transparent_fraction": 0.0, "opaque_fraction": 1.0, "genuine_transparency": False}
        gray = ImageOps.grayscale(im.convert("RGB"))
        h = gray.histogram()
        total = im.width * im.height
        info["luminance"] = {"dark_fraction": round(sum(h[:64]) / total, 4), "light_fraction": round(sum(h[192:]) / total, 4)}
        # Detect painted checkerboards masquerading as transparency: many mid-grey pixels in a
        # regular pattern. A cheap proxy: large fraction of exactly two grey values.
        top = sorted(range(256), key=lambda i: h[i], reverse=True)[:2]
        two = (h[top[0]] + h[top[1]]) / total
        info["luminance"]["checkerboard_suspect"] = bool(two > 0.5 and all(90 < t < 230 for t in top) and not info["alpha"]["has_alpha"])
        return info


def lineart(src, out, threshold=60, thickness=2):
    """Dark contours on white, registered 1:1 to the subject canvas.

    Combines the alpha silhouette edge (strong outer contour) with luminance edges
    inside the subject (inner detail), then thickens and cleans them up.
    """
    with Image.open(src) as im:
        im = im.convert("RGBA")
        w, h = im.size
        alpha = im.getchannel("A")
        rgb = im.convert("RGB")
        gray = ImageOps.grayscale(rgb)
        # Inner detail edges (only where the subject is opaque).
        inner = gray.filter(ImageFilter.GaussianBlur(0.6)).filter(ImageFilter.FIND_EDGES)
        inner = inner.point(lambda v: 255 if v > threshold else 0)
        mask = alpha.point(lambda v: 255 if v > 128 else 0).filter(ImageFilter.MinFilter(3))
        inner = ImageChops.multiply(inner, mask)
        # Outer silhouette edge.
        sil = alpha.point(lambda v: 255 if v > 128 else 0)
        outer = ImageChops.difference(sil.filter(ImageFilter.MaxFilter(3)), sil.filter(ImageFilter.MinFilter(3)))
        edges = ImageChops.lighter(inner, outer)
        if thickness > 1:
            edges = edges.filter(ImageFilter.MaxFilter(thickness * 2 - 1))
        edges = edges.filter(ImageFilter.GaussianBlur(0.4)).point(lambda v: 255 if v > 90 else 0)
        # Dark on white.
        result = ImageOps.invert(edges).convert("RGB")
        result.save(out)
        dark = sum(edges.histogram()[128:]) / (w * h)
        return {"path": str(out), "width": w, "height": h, "dark_fraction": round(dark, 4)}


def chroma_key(src, out, tolerance=40, feather=2):
    """Remove a flat background colour sampled from the four corners; writes real alpha."""
    with Image.open(src) as im:
        im = im.convert("RGBA")
        w, h = im.size
        px = im.load()
        corners = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
        key = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
        r, g, b, _ = im.split()

        def dist(ch, k):
            return ch.point(lambda v, k=k: abs(v - k))

        d = ImageChops.add(ImageChops.add(dist(r, key[0]), dist(g, key[1])), dist(b, key[2]))
        alpha = d.point(lambda v: 0 if v <= tolerance else (255 if v >= tolerance * 2 else int((v - tolerance) * 255 / tolerance)))
        if feather > 0:
            alpha = alpha.filter(ImageFilter.GaussianBlur(feather)).point(lambda v: 0 if v < 12 else v)
        im.putalpha(alpha)
        # Premultiplied edge cleanup: push edge pixels toward their own colour rather than the key.
        im.save(out)
        transparent = sum(alpha.histogram()[:8]) / (w * h)
        return {"path": str(out), "width": w, "height": h, "key_color": key, "transparent_fraction": round(transparent, 4)}


def resize(src, out, width, height):
    with Image.open(src) as im:
        im = im.convert("RGBA") if "A" in im.getbands() else im.convert("RGB")
        im = ImageOps.fit(im, (int(width), int(height)), method=Image.LANCZOS)
        im.save(out)
        return {"path": str(out), "width": im.width, "height": im.height}


def trim_alpha(src, out):
    with Image.open(src) as im:
        im = im.convert("RGBA")
        a = im.getchannel("A").point(lambda v: 0 if v < 16 else v)
        im.putalpha(a)
        im.save(out)
        return inspect(out)


def mock(out, width, height, transparent, seed_text):
    """Placeholder artwork for dry runs (IMAGE_PROVIDER=mock): no external API needed."""
    import hashlib
    import math
    import random

    rnd = random.Random(int(hashlib.sha256(seed_text.encode()).hexdigest()[:8], 16))
    w, h = int(width), int(height)
    if transparent:
        im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        cx, cy = w // 2, int(h * 0.48)
        body = (rnd.randint(120, 240), rnd.randint(60, 180), rnd.randint(60, 200), 255)
        d.ellipse((cx - w // 4, cy - h // 6, cx + w // 4, cy + h // 6), fill=body)
        d.polygon([(cx - w // 5, cy + h // 8), (cx + w // 5, cy + h // 8), (cx, cy + h // 3)], fill=(body[2], body[0], body[1], 255))
        for i in range(6):
            a = i * math.pi / 3
            d.ellipse((cx + int(math.cos(a) * w * 0.28) - 30, cy + int(math.sin(a) * h * 0.18) - 30, cx + int(math.cos(a) * w * 0.28) + 30, cy + int(math.sin(a) * h * 0.18) + 30), fill=(255, 235, 180, 255))
        d.ellipse((cx - 70, cy - 40, cx - 30, cy), fill=(255, 255, 255, 255))
        d.ellipse((cx + 30, cy - 40, cx + 70, cy), fill=(255, 255, 255, 255))
    else:
        im = Image.new("RGB", (w, h), (rnd.randint(10, 60), rnd.randint(10, 60), rnd.randint(40, 90)))
        d = ImageDraw.Draw(im)
        for i in range(40):
            x0, y0 = rnd.randint(-w // 2, w), rnd.randint(-h // 2, h)
            r = rnd.randint(w // 10, w // 2)
            col = (rnd.randint(20, 120), rnd.randint(40, 140), rnd.randint(80, 200))
            d.ellipse((x0, y0, x0 + r, y0 + r), outline=col, width=rnd.randint(2, 12))
        im = im.filter(ImageFilter.GaussianBlur(2))
    im.save(out)
    return {"path": str(out), "width": w, "height": h, "mock": True}


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd, args = argv[1], argv[2:]
    opts = {}
    pos = []
    i = 0
    while i < len(args):
        if args[i].startswith("--"):
            opts[args[i][2:]] = args[i + 1]
            i += 2
        else:
            pos.append(args[i])
            i += 1
    try:
        if cmd == "inspect":
            out = inspect(Path(pos[0]))
        elif cmd == "lineart":
            out = lineart(pos[0], pos[1], int(opts.get("threshold", 60)), int(opts.get("thickness", 2)))
        elif cmd == "chroma-key":
            out = chroma_key(pos[0], pos[1], int(opts.get("tolerance", 40)), int(opts.get("feather", 2)))
        elif cmd == "resize":
            out = resize(pos[0], pos[1], pos[2], pos[3])
        elif cmd == "trim-alpha":
            out = trim_alpha(pos[0], pos[1])
        elif cmd == "mock":
            out = mock(pos[0], opts.get("width", 1024), opts.get("height", 1536), opts.get("transparent", "0") == "1", opts.get("seed", ""))
        else:
            print(json.dumps({"error": f"unknown command {cmd}"}))
            return 2
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e)}))
        return 1
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
