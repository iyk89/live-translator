"""Generate the PDF fixtures used by Passage's sample action and tests.

Requires: pip install typst pymupdf

    python fixtures/generate.py

All documents are written for Passage and released under CC BY 4.0, so they
can be redistributed with the repository.
"""

from __future__ import annotations

import pathlib

import pymupdf
import typst

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "pdfs"
PUBLIC = ROOT.parent / "public" / "samples"


def compile_typst(name: str) -> pathlib.Path:
    target = OUT / f"{name}.pdf"
    typst.compile(str(SRC / f"{name}.typ"), output=str(target))
    return target


def scanned_copy(source: pathlib.Path, target: pathlib.Path, pages: list[int], dpi: int = 110) -> None:
    """Image-only copy: every page is a raster picture with no text layer."""
    src = pymupdf.open(source)
    out = pymupdf.open()
    for index in pages:
        page = src[index]
        pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
        new_page = out.new_page(width=page.rect.width, height=page.rect.height)
        new_page.insert_image(new_page.rect, pixmap=pix)
    out.set_metadata({"title": "Scanned sample (image only)"})
    out.save(target, garbage=4, deflate=True)


def mixed_copy(source: pathlib.Path, target: pathlib.Path) -> None:
    """First page keeps its text layer, second page is image-only."""
    src = pymupdf.open(source)
    out = pymupdf.open()
    out.insert_pdf(src, from_page=0, to_page=0)
    page = src[1]
    pix = page.get_pixmap(dpi=110, colorspace=pymupdf.csGRAY)
    new_page = out.new_page(width=page.rect.width, height=page.rect.height)
    new_page.insert_image(new_page.rect, pixmap=pix)
    out.set_metadata({"title": "Mixed sample (page 2 is scanned)"})
    out.save(target, garbage=4, deflate=True)


def encrypted_copy(source: pathlib.Path, target: pathlib.Path) -> None:
    doc = pymupdf.open(source)
    doc.save(
        target,
        encryption=pymupdf.PDF_ENCRYPT_AES_256,
        user_pw="passage-test",
        owner_pw="passage-owner",
    )


def long_copy(source: pathlib.Path, target: pathlib.Path, repeats: int) -> None:
    src = pymupdf.open(source)
    out = pymupdf.open()
    for _ in range(repeats):
        out.insert_pdf(src)
    out.set_metadata({"title": "Long sample (repeated sample paper)"})
    out.save(target, garbage=4, deflate=True)


def many_pages(target: pathlib.Path, count: int) -> None:
    out = pymupdf.open()
    for number in range(1, count + 1):
        page = out.new_page(width=612, height=792)
        page.insert_text((72, 96), f"Page {number} of a document that exceeds the page limit.", fontsize=12)
    out.set_metadata({"title": f"{count}-page document"})
    out.save(target, garbage=4, deflate=True)


def cjk_sample(target: pathlib.Path) -> None:
    """Korean and Japanese paragraphs set with PyMuPDF's bundled CJK font."""
    font = pymupdf.Font("cjk")
    out = pymupdf.open()
    page = out.new_page(width=595, height=842)
    page.insert_font(fontname="cjk", fontbuffer=font.buffer)
    korean = (
        "신경망 기계 번역은 하나의 학습 가능한 네트워크로 한 언어의 문장을 다른 언어의 문장으로 옮긴다. "
        "초기의 인코더-디코더 시스템은 원문 전체를 고정 길이의 벡터 하나로 압축했기 때문에 긴 문장을 번역하기 어려웠다. "
        "어텐션 메커니즘은 디코더가 매 단계마다 원문의 모든 위치를 참고할 수 있게 하여 이 병목을 없앴다."
    )
    japanese = (
        "ニューラル機械翻訳は、一つの学習可能なネットワークによって、ある言語の文を別の言語の文に変換する。"
        "初期のエンコーダ・デコーダ方式では、原文全体を固定長のベクトル一つに圧縮していたため、長い文の翻訳が難しかった。"
        "注意機構は、デコーダが各ステップで原文のすべての位置を参照できるようにすることで、この問題を解消した。"
    )
    page.insert_textbox(pymupdf.Rect(72, 90, 523, 110), "어텐션과 신경망 기계 번역", fontname="cjk", fontsize=15)
    page.insert_textbox(pymupdf.Rect(72, 130, 523, 330), korean, fontname="cjk", fontsize=11, lineheight=1.6)
    page.insert_textbox(pymupdf.Rect(72, 350, 523, 380), "注意機構とニューラル機械翻訳", fontname="cjk", fontsize=15)
    page.insert_textbox(pymupdf.Rect(72, 390, 523, 600), japanese, fontname="cjk", fontsize=11, lineheight=1.6)
    out.set_metadata({"title": "CJK sample"})
    out.subset_fonts()
    out.save(target, garbage=4, deflate=True)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)

    paper = compile_typst("sample-paper")
    compile_typst("sample-paper-de")
    (PUBLIC / "sample-paper.pdf").write_bytes(paper.read_bytes())

    scanned_copy(paper, OUT / "scanned.pdf", pages=[0, 1])
    mixed_copy(paper, OUT / "mixed-scanned.pdf")
    encrypted_copy(paper, OUT / "encrypted.pdf")
    long_copy(paper, OUT / "long-sample.pdf", repeats=14)
    many_pages(OUT / "too-many-pages.pdf", 201)
    cjk_sample(OUT / "cjk-sample.pdf")

    (OUT / "not-a-pdf.pdf").write_text("This is plain text with a .pdf extension.\n")
    (OUT / "corrupt.pdf").write_bytes(b"%PDF-1.7\n" + bytes(range(256)) * 64 + b"\n%%EOF\n")

    for path in sorted(OUT.iterdir()):
        print(f"{path.name:24} {path.stat().st_size:>9,} bytes")


if __name__ == "__main__":
    main()
