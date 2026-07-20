#!/usr/bin/env python3
"""
ZAO - OCR extraction (free/open-source tools only)

Reads one file path from argv[1] (a PDF or an image) and prints a JSON
result to stdout. Called by server/ocr.js as a subprocess - this is the
"real OCR" pdfExtractor.js's own comments say ZAO doesn't have, now
handled server-side on the PC instead of client-side in React Native
(there's no good pure-JS OCR option; the PC has real CPU + Python).

Tools used, all free/open-source, no paid API or cloud call:
  - pytesseract      (MIT) - thin Python wrapper around the Tesseract OCR
                      engine (Apache 2.0). Tesseract itself must be
                      installed separately (it's a system binary, not a
                      pip package) - see server/README.md.
  - PyMuPDF / fitz    (AGPL/commercial dual-license, free for this use) -
                      renders each PDF page to an image so Tesseract has
                      something to read. Chosen over pdf2image because it
                      has no external Poppler dependency to install
                      separately - just `pip install pymupdf`.
  - Pillow            (HPND, permissive) - image loading for direct image
                      OCR (no PDF rendering step needed).

Install once on the PC:
    pip install pytesseract pymupdf pillow
    (+ the Tesseract engine itself - see server/README.md)

Usage:
    python ocr_extract.py <path-to-pdf-or-image> [--max-pages N]

Output (stdout, single JSON object, always - errors are reported in the
JSON rather than via a Python traceback so ocr.js can parse it either way):
    {
      "success": bool,
      "text": str,
      "pageCount": int | null,
      "pagesProcessed": int | null,
      "error": str | null
    }
"""

import sys
import json
import argparse

MAX_PAGES_DEFAULT = 15  # cap so a huge scanned PDF can't hang the request forever


def ocr_image_bytes(image, pytesseract):
    return pytesseract.image_to_string(image)


def extract_from_pdf(path, max_pages):
    import fitz  # PyMuPDF
    import pytesseract
    from PIL import Image
    import io

    doc = fitz.open(path)
    page_count = doc.page_count
    pages_to_process = min(page_count, max_pages)

    text_parts = []
    # Render at ~200 DPI (zoom factor ~2.78 from the default 72 DPI) - a
    # reasonable balance between OCR accuracy and speed/memory on CPU.
    zoom = 200 / 72
    matrix = fitz.Matrix(zoom, zoom)

    for i in range(pages_to_process):
        page = doc.load_page(i)
        pix = page.get_pixmap(matrix=matrix)
        image = Image.open(io.BytesIO(pix.tobytes("png")))
        page_text = ocr_image_bytes(image, pytesseract).strip()
        if page_text:
            text_parts.append(f"--- Page {i + 1} ---\n{page_text}")

    doc.close()

    return {
        "success": len(text_parts) > 0,
        "text": "\n\n".join(text_parts),
        "pageCount": page_count,
        "pagesProcessed": pages_to_process,
        "error": None if text_parts else "OCR ran but found no readable text on any processed page.",
    }


def extract_from_image(path):
    import pytesseract
    from PIL import Image

    image = Image.open(path)
    text = ocr_image_bytes(image, pytesseract).strip()

    return {
        "success": len(text) > 0,
        "text": text,
        "pageCount": None,
        "pagesProcessed": None,
        "error": None if text else "OCR ran but found no readable text in this image.",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--max-pages", type=int, default=MAX_PAGES_DEFAULT)
    args = parser.parse_args()

    try:
        if args.path.lower().endswith(".pdf"):
            result = extract_from_pdf(args.path, args.max_pages)
        else:
            result = extract_from_image(args.path)
    except ImportError as err:
        result = {
            "success": False,
            "text": "",
            "pageCount": None,
            "pagesProcessed": None,
            "error": (
                f"Missing OCR dependency ({err}). On the PC, run: "
                "pip install pytesseract pymupdf pillow - and make sure the "
                "Tesseract engine itself is installed (see server/README.md)."
            ),
        }
    except Exception as err:  # noqa: BLE001 - deliberately broad, this is a leaf process
        result = {
            "success": False,
            "text": "",
            "pageCount": None,
            "pagesProcessed": None,
            "error": f"OCR failed: {err}",
        }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
