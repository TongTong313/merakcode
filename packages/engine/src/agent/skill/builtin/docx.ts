export const DOCX_SKILL = {
  name: "docx",
  description:
    "Read and create Word documents (.docx). Use when the user wants to read, extract, summarize, or generate Word documents, contracts, reports, or resumes.",
  content: `# docx

Use this skill when working with .docx files. For **reading**, use the built-in tool \`docx_parse\` (deterministic, offline, token-efficient); for **creating/editing**, follow the "Writing / editing documents" guidance below (flexible, no fixed parameter surface).

## Reading documents (preferred tool)

\`docx_parse\` is a deferred tool and is not in your tool list by default. If you don't see it, call \`tool_search("docx_parse")\` first to activate it; it becomes available on your next turn (after that, call it directly with no need to search again).

\`\`\`
docx_parse(filePath: "<file>.docx")
\`\`\`

- Default output: body paragraphs (in order) + tables (as Markdown) + embedded images (as attachments, with their positions marked in the text as \`[Image: imageN.png]\`).
- Read large documents in chunks: start with \`docx_parse(filePath, blocks: "1:100")\`, then move on to \`"101:200"\` and so on; when fewer blocks than the range length come back, you have reached the end.
- Use \`json: true\` for structured analysis.
- **Do not read a docx with \`read(filePath: "<file>.docx")\`**: it will be rejected as binary. \`docx_parse\` decodes it correctly.

## Read-side limits (important)

- A .docx is essentially a zip + OOXML. \`docx_parse\` already handles paragraph order, tables (including merged cells via gridSpan/vMerge, aligned to the rendered visual shape), and extraction of embedded bitmaps (png/jpeg/gif/bmp).
- Legacy binary \`.doc\` is not supported; if needed, ask the user to save it as .docx.
- **Not parsed in this version**: comments, tracked changes (ins/del), headers/footers, footnotes, and table-of-contents fields (TOC field). emf/wmf/svg vector images are not extracted (multimodal models can't read them); only placeholder markers are kept. When the user needs any of these, tell them about the current limitation.

## Writing / editing documents (code written on the fly at the skill layer)

To create or modify a .docx, use the TypeScript \`docx\` library (Node.js). There is no built-in \`docx_write\` tool; do it as follows:

1. Install the dependency and write a script (a temp directory is fine):
   \`\`\`bash
   npm install docx
   \`\`\`
2. Use the \`docx\` library to build paragraphs / tables / images / styles, then export with \`Packer.toBuffer\` and write the .docx file.
3. To change one specific value precisely (e.g. a contract amount): first read the structure with \`docx_parse(json: true)\` → modify it programmatically → rebuild the output with \`docx\`. **Do not hand-edit the XML** (OOXML relationships are complex and fragile).

## Pre-delivery self-check (borrowed from Codex's render gate; best effort)

- After producing a .docx, if LibreOffice is available, convert it to PDF with \`libreoffice --headless --convert-to pdf\` and visually check the layout (if it isn't available, e.g. on an intranet, skip this and tell the user the layout wasn't visually checked).
- Without LibreOffice, at least read your own file back with \`docx_parse\` to confirm no text or tables were lost.

## For detailed parameters, see \`builtin-skill://docx/docx-parse-reference.md\`
`,
  files: {
    "docx-parse-reference.md": `# docx_parse tool reference

## Parameters
- filePath (string, required): .docx path. Relative paths resolve against the project directory.
- blocks (string, optional): 1-based closed block range, such as "1:100". Defaults to the whole document (bounded by maxChars). Use it to page through large documents.
- extractImages (boolean, optional): whether to extract embedded bitmaps (png/jpeg/gif/bmp) as attachments. Default true.
- maxChars (number, optional): body text limit. Default 6000, range 500-30000.
- json (boolean, optional): output JSON instead of formatted text, for structured follow-up analysis.

## Output
\`\`\`
Word: <basename> | Blocks: <N> | Tables: <M> | Images: <K>
Path: <filePath>

=== Text ===
<paragraph text in order, with image positions marked as [Image: imageN.png]>

=== Tables ===
| Column 1 | Column 2 |
|---|---|
| value | value |

=== Images ===
[image1.png] attached
\`\`\`

## Tables
- Converted to Markdown; merged cells (gridSpan horizontal / vMerge vertical) are padded with empty cells to match the rendered visual shape.
- Nested tables are flattened to text inside the cell (simplified in this version; not expanded into a 2D table).

## Images
- Bitmaps (png/jpeg/gif/bmp) are extracted as attachments, with their positions marked in the text as \`[Image: name]\`.
- Vector images (emf/wmf/svg) are not extracted; only placeholder markers are kept.

## Known limitations (this version)
- Does not parse comments (comments.xml), tracked changes (ins/del), headers/footers, footnotes, or table-of-contents fields (TOC field).
- Legacy binary .doc is not supported.
`,
  },
}
