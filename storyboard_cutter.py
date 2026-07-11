#!/usr/bin/env python3
"""
Storyboard grid cutter.

輸入資料夾內有多張「九宮格式」分鏡截圖 PNG，每張是 N 欄 x M 列的表格：
每格上半部是畫面截圖，下半部是白底黑字說明文字。

Usage:
  python3 storyboard_cutter.py --preview --input input_dir --preview-dir preview
  python3 storyboard_cutter.py --export  --input input_dir --output-dir output --lang chi_tra+eng

Phase 1 (--preview): detect grid cells, draw annotated preview images (red boxes +
provisional global index), write to preview/. Does NOT crop or OCR.

Phase 2 (--export): re-run detection, crop each cell's image region to PNG, OCR the
text region to .txt, write into output/{source_stem}/{source_stem}_{global_index}.{png,txt}
"""

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# Tunable thresholds (exposed as CLI flags so they can be adjusted without
# touching code if a particular batch of screenshots needs it).
# ---------------------------------------------------------------------------

DEFAULT_WHITE_LEVEL = 245       # pixel considered "white" if all channels >= this
DEFAULT_COL_BLANK_FRAC = 0.995  # column is a separator if >= this fraction white
DEFAULT_MIN_COL_SEPARATOR = 3   # minimum consecutive blank cols to count as a column separator
# Rows are NOT assumed to have any white gap between them (many real storyboard
# grids butt the next screenshot directly against the previous row's caption,
# with only *columns* separated by whitespace). Row boundaries are therefore
# found by scanning the full image width top-to-bottom for sustained
# transitions between "screenshot" (low white fraction) and "white caption
# background" (high white fraction) -- see compute_row_segments().
DEFAULT_TEXT_WHITE_FRAC = 0.55  # row considered "caption band" if white frac >= this
DEFAULT_TEXT_RUN = 8            # consecutive rows needed at/above threshold to confirm caption-area start
DEFAULT_IMAGE_RUN = 8           # consecutive rows needed below threshold to confirm next row's image start


@dataclass
class Cell:
    row: int
    col: int
    # image (screenshot) crop box, in (x0, y0, x1, y1), end-exclusive
    img_box: tuple
    # text-area crop box
    text_box: tuple


def to_gray(arr: np.ndarray) -> np.ndarray:
    if arr.ndim == 2:
        return arr
    # arr is H x W x C (RGB or RGBA); ignore alpha
    rgb = arr[:, :, :3].astype(np.float32)
    return rgb.mean(axis=2)


def find_bands(is_blank_1d: np.ndarray, min_separator: int):
    """Given a 1D boolean array marking 'blank' positions, return a list of
    (start, end) index ranges (end-exclusive) that are the *content* bands
    lying between separators of at least `min_separator` blank cells (and
    also from image edges)."""
    n = len(is_blank_1d)
    # collapse blank runs of length >= min_separator into separators
    separators = []
    i = 0
    while i < n:
        if is_blank_1d[i]:
            j = i
            while j < n and is_blank_1d[j]:
                j += 1
            if j - i >= min_separator:
                separators.append((i, j))
            i = j
        else:
            i += 1

    bands = []
    cursor = 0
    for (s, e) in separators:
        if s > cursor:
            bands.append((cursor, s))
        cursor = e
    if cursor < n:
        bands.append((cursor, n))

    # drop degenerate/empty bands
    bands = [b for b in bands if b[1] - b[0] > 2]
    return bands


def detect_columns(gray: np.ndarray, white_level, col_blank_frac, min_col_separator):
    is_white = gray >= white_level
    col_white_frac = is_white.mean(axis=0)
    is_blank_col = col_white_frac >= col_blank_frac
    return find_bands(is_blank_col, min_col_separator)


def compute_row_segments(gray: np.ndarray, white_level, text_white_frac, text_run, image_run,
                          x0=None, x1=None):
    """Find grid-row boundaries by scanning top-to-bottom within x-range
    [x0, x1) (defaults to the full image width), without assuming any blank
    gap between rows. Each row is: a screenshot band (low white fraction)
    immediately followed by a caption band (high white fraction, sustained
    for `text_run` rows) that runs until the next row's screenshot begins
    (white fraction drops and stays low for `image_run` rows). Handles both
    zero-gap grids and grids with a genuine blank gutter between rows (the
    gutter just becomes part of the caption band, which is harmless for
    cropping/OCR).

    Returns a list of dicts: {y0, y1, split_y} in row order."""
    height, width = gray.shape
    if x0 is None:
        x0 = 0
    if x1 is None:
        x1 = width
    is_white = gray[:, x0:x1] >= white_level
    row_white_frac = is_white.mean(axis=1)

    segments = []
    pos = 0
    while pos < height:
        # A row must start with actual screenshot content. Skip any leading
        # blank/white margin first (e.g. the outer padding above the very
        # first row) so it isn't mistaken for a zero-height row whose
        # "caption" is really just that margin.
        img_start = None
        for y in range(pos, height):
            if row_white_frac[y] < text_white_frac:
                img_start = y
                break
        if img_start is None:
            break  # nothing but blank/white remains

        split_y = None
        run = 0
        for y in range(img_start, height):
            if row_white_frac[y] >= text_white_frac:
                run += 1
                if run >= text_run:
                    split_y = y - run + 1
                    break
            else:
                run = 0

        if split_y is None:
            # no caption band found; treat the rest as a single image-only row
            segments.append({"y0": img_start, "y1": height, "split_y": height})
            break

        next_image_start = None
        run = 0
        for y in range(split_y, height):
            if row_white_frac[y] < text_white_frac:
                run += 1
                if run >= image_run:
                    next_image_start = y - run + 1
                    break
            else:
                run = 0

        if next_image_start is None:
            # rest of the image is caption/blank; this is the last row
            segments.append({"y0": img_start, "y1": height, "split_y": split_y})
            break

        segments.append({"y0": img_start, "y1": next_image_start, "split_y": split_y})
        pos = next_image_start

    return [s for s in segments if s["y1"] - s["y0"] > 2]


def detect_grid(image: Image.Image, white_level=DEFAULT_WHITE_LEVEL,
                 col_blank_frac=DEFAULT_COL_BLANK_FRAC,
                 min_col_separator=DEFAULT_MIN_COL_SEPARATOR,
                 text_white_frac=DEFAULT_TEXT_WHITE_FRAC,
                 text_run=DEFAULT_TEXT_RUN,
                 image_run=DEFAULT_IMAGE_RUN):
    """Detect grid cells in row-major order. Returns list[Cell] with row/col
    set to their position in the detected grid (row 0-indexed top to bottom,
    col 0-indexed left to right).

    Columns are detected once from the whole image (they share a consistent
    white gutter), but each column's cells are then found *independently* by
    scanning that column's own vertical strip top-to-bottom. This matters
    because real storyboard grids are not always a rigid table: caption
    length varies per cell, so one column's row boundaries commonly do not
    line up with another column's -- forcing shared row coordinates across
    columns would crop into the wrong cell's content. "Row" here is only a
    reading-order index (top-to-bottom position within a column), not a
    shared y-coordinate. A short last row (fewer cells than other rows) is
    handled naturally: that column's scan just yields one fewer segment."""
    arr = np.array(image.convert("RGB"))
    gray = to_gray(arr)

    col_bands = detect_columns(gray, white_level, col_blank_frac, min_col_separator)
    column_segments = [
        compute_row_segments(gray, white_level, text_white_frac, text_run, image_run, x0=cx0, x1=cx1)
        for (cx0, cx1) in col_bands
    ]
    n_rows = max((len(segs) for segs in column_segments), default=0)

    cells = []
    for r in range(n_rows):
        for c, (x0, x1) in enumerate(col_bands):
            segs = column_segments[c]
            if r >= len(segs):
                continue
            y0, y1, split_y = segs[r]["y0"], segs[r]["y1"], segs[r]["split_y"]
            img_box = (x0, y0, x1, split_y)
            text_box = (x0, split_y, x1, y1)
            cells.append(Cell(row=r, col=c, img_box=img_box, text_box=text_box))
    return cells


def load_font(size=18):
    for candidate in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def draw_preview(image: Image.Image, cells, start_index: int):
    """Draw red boxes around each cell's image crop region, with a provisional
    global index label. Returns (annotated_image, next_index)."""
    preview = image.convert("RGB").copy()
    draw = ImageDraw.Draw(preview)
    font = load_font(20)

    index = start_index
    for cell in cells:
        x0, y0, x1, y1 = cell.img_box
        if y1 > y0:
            draw.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(255, 0, 0), width=3)
        # also mark the text-area box in a lighter color for sanity-checking
        tx0, ty0, tx1, ty1 = cell.text_box
        if ty1 > ty0:
            draw.rectangle([tx0, ty0, tx1 - 1, ty1 - 1], outline=(0, 140, 255), width=2)

        label = str(index)
        text_pos = (x0 + 4, y0 + 2)
        # simple readable label: white halo behind red text
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                draw.text((text_pos[0] + dx, text_pos[1] + dy), label, font=font, fill=(255, 255, 255))
        draw.text(text_pos, label, font=font, fill=(255, 0, 0))
        index += 1

    return preview, index


def iter_input_images(input_dir: Path, order_file: Path = None):
    if order_file is not None:
        names = [line.strip() for line in order_file.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [input_dir / name for name in names]
    return sorted(p for p in input_dir.iterdir() if p.suffix.lower() == ".png")


def run_preview(input_dir: Path, preview_dir: Path, order_file: Path, thresholds: dict):
    preview_dir.mkdir(parents=True, exist_ok=True)
    images = iter_input_images(input_dir, order_file)
    if not images:
        print(f"No PNG files found in {input_dir}")
        return

    global_index = 1
    summary = []
    for path in images:
        image = Image.open(path)
        cells = detect_grid(image, **thresholds)
        n_rows = len(set(c.row for c in cells))
        preview_img, next_index = draw_preview(image, cells, global_index)
        out_path = preview_dir / f"{path.stem}_preview.png"
        preview_img.save(out_path)
        summary.append((path.name, len(cells), n_rows, global_index, next_index - 1))
        global_index = next_index

    print("\n=== Preview summary (row-major, global numbering) ===")
    for name, n_cells, n_rows, first_idx, last_idx in summary:
        print(f"{name}: {n_cells} cells detected across {n_rows} row(s) -> global index {first_idx}-{last_idx}")
    print(f"\nPreview images written to: {preview_dir}/")
    print("請檢查 preview/ 內的標註圖：紅框=畫面截圖裁切範圍，藍框=文字裁切範圍，數字=暫定全域編號。")
    print("確認無誤後,再執行 --export 進行正式輸出。")


def run_export(input_dir: Path, output_dir: Path, order_file: Path, lang: str, thresholds: dict):
    import pytesseract

    output_dir.mkdir(parents=True, exist_ok=True)
    images = iter_input_images(input_dir, order_file)
    if not images:
        print(f"No PNG files found in {input_dir}")
        return

    global_index = 1
    for path in images:
        image = Image.open(path)
        cells = detect_grid(image, **thresholds)
        rgb_image = image.convert("RGB")

        stem = path.stem
        out_dir = output_dir / stem
        out_dir.mkdir(parents=True, exist_ok=True)

        for cell in cells:
            img_crop = rgb_image.crop(cell.img_box)
            text_crop = rgb_image.crop(cell.text_box)

            base = f"{stem}_{global_index}"
            img_crop.save(out_dir / f"{base}.png")

            text = pytesseract.image_to_string(text_crop, lang=lang)
            (out_dir / f"{base}.txt").write_text(text, encoding="utf-8")

            global_index += 1

        print(f"{path.name}: exported {len(cells)} cell(s) -> {out_dir}/")

    print(f"\nDone. Total cells exported: {global_index - 1}")


def build_thresholds(args):
    return dict(
        white_level=args.white_level,
        col_blank_frac=args.col_blank_frac,
        min_col_separator=args.min_col_separator,
        text_white_frac=args.text_white_frac,
        text_run=args.text_run,
        image_run=args.image_run,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preview", action="store_true", help="Phase 1: detect + write annotated preview images")
    mode.add_argument("--export", action="store_true", help="Phase 2: crop + OCR + write final output")

    parser.add_argument("--input", default="input", help="Input directory containing source PNGs (default: input)")
    parser.add_argument("--preview-dir", default="preview", help="Output directory for preview images (default: preview)")
    parser.add_argument("--output-dir", default="output", help="Output directory for exported cells (default: output)")
    parser.add_argument("--order", default=None, help="Optional text file listing source filenames in desired order, one per line")
    parser.add_argument("--lang", default="chi_tra+eng", help="Tesseract language(s) for OCR (default: chi_tra+eng)")

    parser.add_argument("--white-level", type=int, default=DEFAULT_WHITE_LEVEL)
    parser.add_argument("--col-blank-frac", type=float, default=DEFAULT_COL_BLANK_FRAC)
    parser.add_argument("--min-col-separator", type=int, default=DEFAULT_MIN_COL_SEPARATOR)
    parser.add_argument("--text-white-frac", type=float, default=DEFAULT_TEXT_WHITE_FRAC)
    parser.add_argument("--text-run", type=int, default=DEFAULT_TEXT_RUN)
    parser.add_argument("--image-run", type=int, default=DEFAULT_IMAGE_RUN)

    args = parser.parse_args()
    input_dir = Path(args.input)
    if not input_dir.is_dir():
        print(f"Input directory not found: {input_dir}", file=sys.stderr)
        sys.exit(1)

    order_file = Path(args.order) if args.order else None
    thresholds = build_thresholds(args)

    if args.preview:
        run_preview(input_dir, Path(args.preview_dir), order_file, thresholds)
    else:
        run_export(input_dir, Path(args.output_dir), order_file, args.lang, thresholds)


if __name__ == "__main__":
    main()
