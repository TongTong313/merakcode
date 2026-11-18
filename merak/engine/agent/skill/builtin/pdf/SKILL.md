---
name: pdf
description: Extract text and tables from PDF files and answer questions about them
---

Use this skill when the task involves a PDF: reading it, finding a passage, pulling out a table, or summarizing it.

## Reading

- Read the PDF with read_file. It returns the text of the pages in order. Long PDFs are cut; read page ranges when you need a later part and say which pages you used.
- Text that comes back as one line per word usually means a scanned or columnar layout. Say so, and read the surrounding lines to rebuild columns before you trust any numbers.

## Extracting tables

- Rebuild a table by finding its header line and grouping the following lines into rows by their column positions. Check the row count against the page and report rows you could not place.
- Put the result in Markdown or CSV as the person asks, and keep the original numbers exactly as written.

## Care

- Quote with the page number so the person can check. Do not fill gaps from memory: if a page has no extractable text (a scan), say that the page is an image.
