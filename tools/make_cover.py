#!/usr/bin/env python3
"""Compose the marketplace listing cover from delivered card renders.

    python3 tools/make_cover.py out.png renders/a.png [renders/b.png ...] [--price "from 1 USDC"]

Each hero.png (1080x1500, card on a dark backdrop) is cropped to the card, given a rounded mask,
tilted slightly, shadowed, and arranged on a deep-navy gradient with holographic light streaks.
"""
import argparse
import math
import os
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

W, H = 1600, 900
FONT_DIRS = ["/usr/share/fonts/google-noto", "/usr/share/fonts/truetype/noto", "/usr/share/fonts/noto"]


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.truetype("DejaVuSans.ttf", size) if os.path.exists("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf") else ImageFont.load_default()


def crop_card(path: str) -> Image.Image:
    """Cut the card out of the render (anything brighter than the backdrop), rounded corners."""
    im = Image.open(path).convert("RGBA")
    bg = im.getpixel((4, 4))[:3]
    diff = ImageChops.difference(im.convert("RGB"), Image.new("RGB", im.size, bg)).convert("L")
    mask = diff.point(lambda v: 255 if v > 28 else 0)
    bbox = mask.getbbox()
    card = im.crop(bbox)
    r = int(card.width * 0.045)
    m = Image.new("L", card.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, card.width - 1, card.height - 1], radius=r, fill=255)
    card.putalpha(ImageChops.multiply(card.getchannel("A"), m))
    return card


def gradient_bg() -> Image.Image:
    base = Image.new("RGB", (W, H))
    px = base.load()
    c0, c1, c2 = (12, 18, 34), (26, 22, 58), (8, 12, 24)
    for y in range(H):
        t = y / (H - 1)
        for x in range(0, W, 4):
            u = x / (W - 1)
            k = 0.5 * t + 0.5 * u
            if k < 0.5:
                a, b, f = c0, c1, k / 0.5
            else:
                a, b, f = c1, c2, (k - 0.5) / 0.5
            col = tuple(int(a[i] + (b[i] - a[i]) * f) for i in range(3))
            for dx in range(4):
                if x + dx < W:
                    px[x + dx, y] = col
    # holographic streaks
    streak = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(streak)
    colours = [(255, 90, 160), (120, 200, 255), (160, 255, 190), (255, 210, 120), (190, 140, 255)]
    for i, c in enumerate(colours):
        x0 = -300 + i * 380
        sd.polygon([(x0, H), (x0 + 900, -200), (x0 + 1040, -200), (x0 + 140, H)], fill=c + (85,))
    streak = streak.filter(ImageFilter.GaussianBlur(70))
    base = Image.alpha_composite(base.convert("RGBA"), streak)
    # soft glow behind the cards
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([W * 0.42, H * 0.05, W * 0.98, H * 1.05], fill=(120, 160, 255, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    base = Image.alpha_composite(base, glow)
    # sparkles
    rnd = random.Random(7)
    sp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    spd = ImageDraw.Draw(sp)
    for _ in range(260):
        x, y = rnd.randint(0, W), rnd.randint(0, H)
        r = rnd.choice([1, 1, 1, 2, 2, 3])
        spd.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, rnd.randint(60, 200)))
    base = Image.alpha_composite(base, sp.filter(ImageFilter.GaussianBlur(0.6)))
    # vignette
    vig = Image.new("L", (W, H), 0)
    ImageDraw.Draw(vig).ellipse([-W * 0.2, -H * 0.4, W * 1.2, H * 1.4], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(220)).point(lambda v: 90 + v * 165 // 255)
    dark = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    dark.putalpha(ImageChops.invert(vig))
    return Image.alpha_composite(base, dark)


def place_card(canvas: Image.Image, card: Image.Image, height: int, cx: int, cy: int, angle: float) -> None:
    scale = height / card.height
    c = card.resize((int(card.width * scale), height), Image.LANCZOS)
    c = c.rotate(angle, expand=True, resample=Image.BICUBIC)
    # shadow
    sh = Image.new("RGBA", c.size, (0, 0, 0, 0))
    sh.putalpha(c.getchannel("A").point(lambda v: int(v * 0.75)))
    sh = sh.filter(ImageFilter.GaussianBlur(28))
    canvas.alpha_composite(sh, (cx - c.width // 2 + 18, cy - c.height // 2 + 40))
    # thin light edge
    edge = Image.new("RGBA", c.size, (255, 255, 255, 0))
    edge.putalpha(c.getchannel("A").filter(ImageFilter.MaxFilter(5)).point(lambda v: int(v * 0.35)))
    canvas.alpha_composite(edge, (cx - c.width // 2, cy - c.height // 2))
    canvas.alpha_composite(c, (cx - c.width // 2, cy - c.height // 2))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("renders", nargs="+")
    ap.add_argument("--title", default="Custom 3D Holographic Cards")
    ap.add_argument("--subtitle", default="AI-painted · Blender-rendered · interactive viewer")
    ap.add_argument("--price", default="from 1 USDC per card")
    a = ap.parse_args()

    canvas = gradient_bg()
    cards = [crop_card(p) for p in a.renders[:3]]
    # right-hand fan of cards
    n = len(cards)
    if n == 1:
        place_card(canvas, cards[0], 720, 1180, 470, -6)
    elif n == 2:
        place_card(canvas, cards[1], 590, 1350, 470, 10)
        place_card(canvas, cards[0], 640, 1110, 450, -7)
    else:
        place_card(canvas, cards[2], 600, 1390, 500, 12)
        place_card(canvas, cards[1], 640, 1200, 480, 3)
        place_card(canvas, cards[0], 700, 990, 455, -8)

    d = ImageDraw.Draw(canvas)
    x = 96
    f_kicker = font("NotoSans-SemiBold.ttf", 26)
    f_title = font("NotoSans-Black.ttf", 84)
    f_sub = font("NotoSans-Regular.ttf", 30)
    f_price = font("NotoSans-Bold.ttf", 34)
    f_small = font("NotoSans-Medium.ttf", 22)

    d.text((x, 190), "HOLO CARD STUDIO", font=f_kicker, fill=(160, 210, 255, 255), spacing=4)
    y = 236
    for line in wrap(a.title, f_title, 700):
        d.text((x, y), line, font=f_title, fill=(255, 255, 255, 255))
        y += 96
    y += 10
    d.text((x, y), a.subtitle, font=f_sub, fill=(190, 200, 225, 255))
    y += 70
    # price pill
    tw = d.textlength(a.price, font=f_price)
    pill = [x, y, x + tw + 56, y + 62]
    d.rounded_rectangle(pill, radius=31, fill=(255, 255, 255, 235))
    d.text((x + 28, y + 11), a.price, font=f_price, fill=(18, 22, 40, 255))
    y += 100
    for bullet in ["Describe a character, pet or product — get a tilt-to-shimmer 3D card",
                   "Unzip & open: drag, tilt, flip on any device. Source layers included",
                   "Delivered within the hour · card text in your language"]:
        d.ellipse([x + 2, y + 10, x + 12, y + 20], fill=(255, 140, 190, 255))
        d.text((x + 30, y), bullet, font=f_small, fill=(215, 222, 240, 255))
        y += 40

    canvas.convert("RGB").save(a.out, "PNG", optimize=True)
    print(a.out, canvas.size)


def wrap(text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if f.getlength(t) <= width or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


if __name__ == "__main__":
    main()
