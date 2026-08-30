from pathlib import Path
import json
import re
import sys

import pypdfium2 as pdfium
import pdfplumber
from PIL import Image
from pypdf import PdfReader


def main() -> None:
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    target.mkdir(parents=True, exist_ok=True)

    reader = PdfReader(source)
    embedded = target / "embedded"
    embedded.mkdir(exist_ok=True)
    for page_number, page in enumerate(reader.pages, 1):
        for image_number, image in enumerate(page.images, 1):
            suffix = Path(image.name).suffix or ".bin"
            output = embedded / f"p{page_number:02d}-{image_number:02d}{suffix}"
            output.write_bytes(image.data)
            if suffix.lower() in {".tif", ".tiff"}:
                with Image.open(output) as raster:
                    raster.convert("RGB").save(output.with_suffix(".jpg"), quality=94)

    pdf = pdfium.PdfDocument(source)
    pages = target / "pages"
    pages.mkdir(exist_ok=True)
    rendered_pages = []
    for page_number, page in enumerate(pdf, 1):
        bitmap = page.render(scale=2.2)
        rendered = bitmap.to_pil().convert("RGB")
        rendered.save(pages / f"page-{page_number:02d}.jpg", quality=92)
        rendered_pages.append(rendered)

    # Directly saving PDF image streams can lose ICC/Decode transforms and turn
    # white figures into black, inverted images. Crop each figure from the fully
    # rendered page instead, so the result matches what a PDF reader displays.
    figures = target / "figures"
    figures.mkdir(exist_ok=True)
    for old in figures.iterdir():
        if old.is_file():
            old.unlink()
    manifest = []
    all_crops = []
    assigned_files = set()
    with pdfplumber.open(source) as layout_pdf:
        for page_number, layout_page in enumerate(layout_pdf.pages, 1):
            rendered = rendered_pages[page_number - 1]
            scale_x = rendered.width / float(layout_page.width)
            scale_y = rendered.height / float(layout_page.height)
            page_crops = []
            for image_number, image in enumerate(layout_page.images, 1):
                x0 = max(0, round(float(image["x0"]) * scale_x) - 3)
                y0 = max(0, round(float(image["top"]) * scale_y) - 3)
                x1 = min(rendered.width, round(float(image["x1"]) * scale_x) + 3)
                y1 = min(rendered.height, round(float(image["bottom"]) * scale_y) + 3)
                if x1 - x0 < 80 or y1 - y0 < 60:
                    continue
                crop = rendered.crop((x0, y0, x1, y1))
                stem = f"p{page_number:02d}-{image_number:02d}"
                crop.save(figures / f"{stem}.png", optimize=True)
                crop_info = {
                    "file": f"{stem}.png",
                    "area": (x1 - x0) * (y1 - y0),
                    "top": y0,
                    "page": page_number,
                    "source_x0": float(image["x0"]),
                    "source_x1": float(image["x1"]),
                    "source_top": float(image["top"]),
                    "source_bottom": float(image["bottom"]),
                }
                page_crops.append(crop_info)
                all_crops.append(crop_info)
                # Keep compatibility with a workbench process that was already
                # running before the new `figures` directory was introduced.
                for legacy in embedded.glob(f"{stem}.*"):
                    if legacy.suffix.lower() in {".jpg", ".jpeg"}:
                        crop.save(legacy, quality=94)
                    elif legacy.suffix.lower() == ".png":
                        crop.save(legacy, optimize=True)
            captions = []
            seen_labels = set()
            words = layout_page.extract_words() or []
            for index, word in enumerate(words[:-1]):
                if not re.fullmatch(r"(?:Figure|Fig\.?|Scheme)", word["text"], re.I):
                    continue
                number_word = words[index + 1]
                number_match = re.fullmatch(r"(\d+)[.:]?", number_word["text"])
                if not number_match or abs(float(number_word["top"]) - float(word["top"])) > 3:
                    continue
                prefix = "Scheme" if word["text"].lower().startswith("scheme") else "Fig"
                label = f"{prefix} {number_match.group(1)}"
                normalized = re.sub(r"\s+", "", label).lower()
                if normalized in seen_labels:
                    continue
                caption_top = float(word["top"])
                caption_x0 = float(word["x0"])
                candidates = [
                    crop for crop in page_crops
                    if crop["file"] not in assigned_files
                    and crop["source_bottom"] <= caption_top + 25
                    and caption_top - crop["source_bottom"] < 110
                ]
                if not candidates:
                    continue
                def spatial_score(crop):
                    horizontally_aligned = crop["source_x0"] - 15 <= caption_x0 <= crop["source_x1"] + 15
                    return (
                        0 if horizontally_aligned else 10_000,
                        abs(crop["source_x0"] - caption_x0) * 2 + abs(caption_top - crop["source_bottom"]),
                    )
                crop_info = min(candidates, key=spatial_score)
                same_line = [
                    item["text"] for item in words[index + 2:]
                    if abs(float(item["top"]) - caption_top) <= 3
                    and float(item["x0"]) >= float(number_word["x1"])
                    and float(item["x0"]) <= min(float(layout_page.width), caption_x0 + 260)
                ]
                captions.append({"label": label, "caption": " ".join(same_line).strip(), "crop": crop_info})
                seen_labels.add(normalized)
                assigned_files.add(crop_info["file"])
            for caption in captions:
                crop_info = caption.pop("crop")
                manifest.append({**caption, "page": page_number, "file": crop_info["file"]})

    # Recover a missing rasterized caption only when it forms an unambiguous
    # numeric gap between two recognized figures (for example Fig. 4, [crop],
    # Fig. 6). This never guesses before the first or after the last figure.
    def label_parts(label):
        match = re.search(r"(Scheme|Figure|Fig)\s*(\d+)", label, re.I)
        return (match.group(1), int(match.group(2))) if match else (None, None)

    ordered_manifest = sorted(manifest, key=lambda row: (row["page"], row["file"]))
    for left, right in zip(ordered_manifest, ordered_manifest[1:]):
        left_kind, left_number = label_parts(left["label"])
        right_kind, right_number = label_parts(right["label"])
        if not left_kind or not right_kind or left_kind.lower().startswith("scheme") != right_kind.lower().startswith("scheme"):
            continue
        missing_numbers = list(range(left_number + 1, right_number))
        if not missing_numbers:
            continue
        available = [row for row in all_crops if row["file"] not in assigned_files and left["page"] <= row["page"] <= right["page"] and row["area"] >= 100_000]
        available.sort(key=lambda row: (row["page"], row["top"]))
        if len(available) != len(missing_numbers):
            continue
        prefix = "Scheme" if left_kind.lower().startswith("scheme") else "Fig"
        for number, crop_info in zip(missing_numbers, available):
            manifest.append({"label": f"{prefix} {number}", "caption": "图注为栅格内容，需对照原始PDF核验。", "page": crop_info["page"], "file": crop_info["file"]})
            assigned_files.add(crop_info["file"])

    (target / "figure-manifest.json").write_text(json.dumps({"figures": manifest}, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
