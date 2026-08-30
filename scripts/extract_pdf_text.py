import sys
from pathlib import Path

from pypdf import PdfReader


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: extract_pdf_text.py <pdf> [max_chars]", file=sys.stderr)
        return 2
    pdf_path = Path(sys.argv[1])
    max_chars = int(sys.argv[2]) if len(sys.argv) > 2 else 120_000
    reader = PdfReader(str(pdf_path))
    pages: list[tuple[int, str]] = []
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text(extraction_mode="layout") or ""
        except TypeError:
            text = page.extract_text() or ""
        pages.append((index, text.strip()))
    full_text = "".join(f"\n[PDF p.{index}]\n{text}\n" for index, text in pages)
    if len(full_text) <= max_chars:
        output = full_text
    else:
        per_page = max(400, max_chars // max(1, len(pages)) - 24)
        chunks: list[str] = []
        for index, text in pages:
            if len(text) > per_page:
                head = int(per_page * 0.72)
                tail = per_page - head
                text = f"{text[:head]}\n[…本页中段按字符预算省略…]\n{text[-tail:]}"
            chunks.append(f"\n[PDF p.{index}]\n{text}\n")
        output = "".join(chunks)[:max_chars]
    sys.stdout.reconfigure(encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
