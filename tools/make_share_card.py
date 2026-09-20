#!/usr/bin/env python3
"""Compose the 1200x630 preview image X shows when a buyer shares their card.

    python3 tools/make_share_card.py out.png renders/hero.png \
        --title "Mecha-Neko" --subtitle "Cyber-Feline Unit" --edition "No.042 / 100" --lang en

X cannot attach an image to an intent link, so this is what the hosted page advertises through
og:image. It reuses make_cover.py's card cut-out and backdrop so a shared card looks like it
belongs to the same family as the marketplace listing cover.
"""
import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from make_cover import crop_card, font, gradient_bg, place_card  # noqa: E402

W, H = 1200, 630

# Fedora ships one variable collection, Debian/Ubuntu (what deploy/install.sh builds) ships
# per-weight collections. Try both before falling back to fontconfig.
CJK_CANDIDATES = [
    "/usr/share/fonts/google-noto-sans-cjk-vf-fonts/NotoSansCJK-VF.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
]


def _fc_match() -> list[str]:
    try:
        out = subprocess.run(["fc-match", "-f", "%{file}", ":lang=zh"], capture_output=True, text=True, timeout=15)
        return [out.stdout.strip()] if out.returncode == 0 and out.stdout.strip() else []
    except Exception:
        return []


def cjk_font(size: int, weight: str = "Bold") -> ImageFont.FreeTypeFont:
    """A face that actually covers Chinese — without this every CJK glyph renders as a tofu box."""
    for path in CJK_CANDIDATES + _fc_match():
        if not os.path.exists(path):
            continue
        try:
            f = ImageFont.truetype(path, size)
        except Exception:
            continue
        try:  # variable collections need the weight selected explicitly
            f.set_variation_by_name(weight)
        except Exception:
            pass
        print(f"[share-card] CJK font: {path}", file=sys.stderr)
        return f
    print("[share-card] no CJK font found, Chinese text will not render", file=sys.stderr)
    return font("NotoSans-Regular.ttf", size)


def fit_lines(text: str, f: ImageFont.FreeTypeFont, width: int, max_lines: int = 3) -> list[str]:
    """Wrap on spaces when there are any, on characters otherwise (Chinese titles have none)."""
    lines: list[str] = []
    cur = ""
    for ch in text:
        if f.getlength(cur + ch) <= width or not cur:
            cur += ch
            continue
        space = cur.rfind(" ")
        if space > 0 and f.getlength(cur[space + 1:] + ch) <= width:
            lines.append(cur[:space])
            cur = cur[space + 1:] + ch
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1][:-1] + "…"
    return lines


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("hero")
    ap.add_argument("--title", default="Holo Card")
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--edition", default="")
    ap.add_argument("--lang", choices=["en", "zh"], default="en")
    ap.add_argument("--cta", default="agent.family")
    a = ap.parse_args()

    zh = a.lang == "zh"
    canvas = gradient_bg().resize((W, H), Image.LANCZOS)
    # Keep the card short enough that place_card's drop shadow (offset +40y, blurred) stays inside
    # the frame — spilling past the bottom edge turns the soft shadow into a hard grey slab.
    place_card(canvas, crop_card(a.hero), height=452, cx=900, cy=H // 2 - 14, angle=-7)

    f_kicker = font("NotoSans-SemiBold.ttf", 22)
    f_title = cjk_font(58, "Bold") if zh else font("NotoSans-Black.ttf", 58)
    f_sub = cjk_font(26, "Regular") if zh else font("NotoSans-Regular.ttf", 26)
    f_small = cjk_font(20, "Regular") if zh else font("NotoSans-Medium.ttf", 20)
    f_cta = font("NotoSans-Bold.ttf", 22)

    text_w = 540
    title_lines = fit_lines(a.title, f_title, text_w)
    sub_lines = fit_lines(a.subtitle, f_sub, text_w, 2) if a.subtitle else []

    # Centre the whole text column against the card rather than pinning it to a fixed top.
    line_h = 70
    block = 34 + len(title_lines) * line_h + (len(sub_lines) * 38 + 12 if sub_lines else 0) + (32 if a.edition else 0) + 52
    y = max(60, (H - block) // 2)
    x = 80

    d = ImageDraw.Draw(canvas)
    d.text((x, y), "HOLO CARD STUDIO", font=f_kicker, fill=(160, 210, 255, 255))
    y += 48
    for line in title_lines:
        d.text((x, y), line, font=f_title, fill=(255, 255, 255, 255))
        y += line_h
    if sub_lines:
        y += 6
        for line in sub_lines:
            d.text((x, y), line, font=f_sub, fill=(196, 206, 230, 255))
            y += 38
    if a.edition:
        y += 6
        d.text((x, y), a.edition, font=f_small, fill=(150, 162, 194, 255))
        y += 32
    y += 24
    d.ellipse([x + 1, y + 8, x + 11, y + 18], fill=(255, 140, 190, 255))
    d.text((x + 28, y), a.cta, font=f_cta, fill=(255, 255, 255, 235))

    canvas.convert("RGB").save(a.out, "PNG", optimize=True)
    print(a.out, canvas.size)


if __name__ == "__main__":
    main()
