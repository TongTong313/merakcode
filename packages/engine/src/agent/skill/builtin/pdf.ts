export const PDF_SKILL = {
  name: "pdf",
  description: "Parse PDFs with smart text extraction and visual rendering for scanned, mixed, or table-heavy pages.",
  content: `# pdf

Use this skill when the user wants to read, extract, summarize, or inspect a PDF.

## Strategy
- \`pdf_parse\` is a deferred tool - it is NOT in your tool list by default. If you don't see it, call \`tool_search("pdf_parse")\` first to activate it; it becomes available with full parameters in your NEXT turn (then call it directly, no need to call tool_search again).
- Once activated, start with \`pdf_parse(filePath: "<pdf>", pages: "1-10", mode: "auto")\` for quick inspection.
- Do not use \`read(filePath: "<pdf>")\` as the primary PDF parser after this skill is loaded.
- Do not attach or ask the model to read the original \`application/pdf\` file directly.
- If the PDF has a usable text layer, \`pdf_parse\` returns extracted text.
- If the PDF is scanned, image-only, or mixed with image/table pages, \`pdf_parse\` identifies visual pages and can render them as PNG attachments.
- If \`pdf_parse\` still cannot be activated, fall back to \`read(filePath: "<pdf>")\` - do NOT fall back to shell tools (pdftotext / qpdf / poppler / python fitz) unless the user explicitly asks.

## When To Use pdf_parse
Use \`pdf_parse\` when you need:
- A specific page range.
- Text-only extraction.
- Visual inspection of scanned, image-only, mixed, or table-heavy pages.
- Large PDF processing in chunks.

## Modes
- \`auto\`: classify pages, extract text, and render only image/mixed/table pages as PNG attachments.
- \`text\`: extract text only.
- \`vision\`: render every requested page as PNG attachments.

## Examples
\`\`\`
pdf_parse(filePath: "<path>", pages: "1-10", mode: "auto")
pdf_parse(filePath: "<path>", pages: "3,7", mode: "vision")
pdf_parse(filePath: "<path>", pages: "21-40", mode: "text", maxCharsPerPage: 12000)
\`\`\`

## Constraints
- Process at most 20 pages per call.
- \`pdf_parse\` does not perform OCR by itself; rendered images must be interpreted by an image-capable model.
- Prefer PNG attachments produced by \`pdf_parse\` over original PDF attachments for visual reading.
- Do not use shell tools such as pdftotext, qpdf, poppler, or custom scripts for normal PDF parsing unless the user explicitly asks.
- The first time vision/auto rendering is used, the tool automatically downloads the PDF rendering component on demand
  (@napi-rs/canvas, about 37MB, cached in the user directory and reused afterwards). The download requires network access.
  If the download fails, the tool automatically falls back to split-page PDFs for multimodal models to read; text extraction is unaffected.
- For details, read \`builtin-skill://pdf/pdf-parse-reference.md\`.
`,
  files: {
    "pdf-parse-reference.md": `# pdf_parse tool reference

## Parameters
- filePath (string, required): PDF path. Relative paths resolve against the project directory.
- pages (string, optional): page range such as "1-10" or "5,8-12". Default "1-10". Max 20 pages.
- mode ("auto" | "text" | "vision", optional): default "auto".
- maxCharsPerPage (number, optional): text output limit per page. Default 6000. Range 500-30000.

## Output
\`\`\`
PDF: <basename> | Total: <N> pages | Mode: <mode>

=== Text Extracted ===
--- Page 3 ---
<text>

=== Vision Suggested (Pages 7, 9) ===
  Page 7: image content
  Page 9: mixed text+image

=== Rendered Images Attached (Pages 7, 9) ===
Page 7: <tmp png path>
Page 9: <tmp png path>
\`\`\`

## Classification
- text: page has a usable text layer.
- image: page has images and little text.
- mixed: page has both meaningful text and images.
- table: page has layout/path hints that may lose structure in text extraction.
- empty: no useful text, images, or layout hints were detected.

## Rendering
- Visual pages are rendered to PNG files in the OS temp directory and returned as image attachments.
- Rendering requires @napi-rs/canvas: in dev it ships via node_modules; in the packaged build it is downloaded on first use (~37MB, cached for reuse) and requires network.
- If @napi-rs/canvas cannot be loaded, rendering degrades to split-page PDF for image-capable models; text extraction is unaffected.
- Use smaller page ranges for large scanned PDFs.
`,
  },
}
