# 把 AI 生成的原图加工成应用图标：
#   1) 去掉圆角外的透明/白色边，做成满幅方形（窗口图标用）
#   2) 另存一张透明圆角版（托盘/任务栏用，圆角外透明）
#   3) 生成多尺寸 PNG 与 Windows .ico
# 用法：python scripts/make-icon.py
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "build", "icon-raw-2.jpg")
OUT_DIR = os.path.join(ROOT, "build")
ASSETS = os.path.join(ROOT, "assets")
os.makedirs(ASSETS, exist_ok=True)

BASE = 1024
# 生成图里圆角方块大约占中间 87%，外面是一圈深色；裁掉外边让图标占满
SQUARE = 893
BG = (27, 30, 33)  # #1b1e21


def load_square() -> Image.Image:
    """把原图中间的圆角方块裁出来并放大到 BASE。"""
    im = Image.open(SRC).convert("RGB")
    w, h = im.size
    # 原图四周有一圈纯黑边，按比例裁成正方形主体
    left = (w - SQUARE) // 2
    top = (h - SQUARE) // 2
    im = im.crop((left, top, left + SQUARE, top + SQUARE))
    return im.resize((BASE, BASE), Image.LANCZOS)


def rounded_mask(size: int, radius: int) -> Image.Image:
    """生成圆角矩形遮罩（抗锯齿：4 倍超采样后缩小）。"""
    scale = 4
    m = Image.new("L", (size * scale, size * scale), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle(
        (0, 0, size * scale - 1, size * scale - 1),
        radius=radius * scale,
        fill=255,
    )
    return m.resize((size, size), Image.LANCZOS)


def small_icon(size: int) -> Image.Image:
    """
    小尺寸（≤32px）单独画：原图缩到这个尺寸时外圈刻度和文字全糊成一团。
    这里只保留「环 + 一个加粗的 1」，按像素网格画，缩到 16px 也认得出。
    """
    scale = 8  # 超采样，缩小时得到抗锯齿边缘
    s = size * scale
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    # 圆角底
    radius = int(s * 0.22)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=radius, fill=(27, 30, 33, 255))

    # 外环保留为「计时器」的形状识别点
    ring_w = max(scale, int(s * 0.085))
    pad = int(s * 0.14)
    d.ellipse((pad, pad, s - pad, s - pad), outline=(142, 224, 164, 255), width=ring_w)

    # 中间的「1」：用矩形拼，保证小尺寸下笔画不糊
    bar_w = max(2 * scale, int(s * 0.10))
    cx = s // 2
    top = int(s * 0.30)
    bottom = int(s * 0.70)
    # 竖笔
    d.rounded_rectangle(
        (cx - bar_w // 2, top, cx + bar_w // 2, bottom),
        radius=bar_w // 3,
        fill=(142, 224, 164, 255),
    )
    # 左上角斜笔（“1”的帽）
    head = int(s * 0.16)
    d.polygon(
        [
            (cx - bar_w // 2, top + int(head * 0.55)),
            (cx - bar_w // 2 - head, top + int(head * 1.5)),
            (cx - bar_w // 2 - head, top + int(head * 1.5) + bar_w),
            (cx - bar_w // 2, top + int(head * 0.55) + bar_w),
        ],
        fill=(142, 224, 164, 255),
    )

    return im.resize((size, size), Image.LANCZOS)


def main() -> None:
    sq = load_square()

    # 1) 满幅方形（应用主图标 / 窗口图标）
    sq.save(os.path.join(ASSETS, "icon.png"), "PNG")
    print("assets/icon.png", sq.size)

    # 2) 透明圆角版（托盘、任务栏缩略图）
    #    半径按 Windows 11 应用图标习惯取 22%
    radius = int(BASE * 0.22)
    mask = rounded_mask(BASE, radius)
    rnd = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    rnd.paste(sq, (0, 0), mask)
    rnd.save(os.path.join(ASSETS, "icon-rounded.png"), "PNG")
    print("assets/icon-rounded.png", rnd.size)

    # 3) 多尺寸 PNG：≤32px 用简化绘制，更大用缩放
    d128 = os.path.join(ASSETS, "icons")
    os.makedirs(d128, exist_ok=True)
    for s in (16, 24, 32, 48, 64, 128, 256, 512):
        # 小尺寸用简化绘制；大尺寸用原图缩放（保留刻度与 "1min" 字样）
        small = small_icon(s) if s <= 32 else rnd.resize((s, s), Image.LANCZOS)
        small.save(os.path.join(d128, f"{s}x{s}.png"), "PNG")
        sq.resize((s, s), Image.LANCZOS).save(os.path.join(ASSETS, f"icon-{s}.png"), "PNG")
    print("sizes:", "16/24/32/48/64/128/256/512（≤32 用简化绘制）")

    # 4) Windows .ico：小尺寸也塞简化版，否则任务栏 16px 会糊
    #    Pillow 的 ICO 会按 sizes 各自从原图缩放，所以先给一张 256 的圆角版做底
    rnd.resize((256, 256), Image.LANCZOS).convert("RGBA").save(
        os.path.join(ASSETS, "icon.ico"),
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("assets/icon.ico")


if __name__ == "__main__":
    main()
