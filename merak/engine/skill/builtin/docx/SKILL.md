---
name: docx
description: Read, summarize, edit or create Word (.docx) documents
---

Use this skill when the task involves a Word document: reading its text, pulling out tables or headings, summarizing it, or producing a new .docx file.

## Reading

- Open the file with read_docx. It returns the headings, paragraphs and tables as plain text, in order. Do not try to read the raw file with read_file: a .docx is a zip archive.
- For a long document read it once, note the heading outline first, then quote only the parts the task needs.
- Tables come back as rows of cells separated by " | ". Keep that structure when you copy them into an answer.

## Writing

- Build the new document text as Markdown first (headings with #, lists with -, tables with pipes) and check it with the person before writing the file when the content is long.
- Write the file with write_file as a .docx only through the document tool the project offers; never fake a .docx by saving plain text under that name.
- State plainly where the file was saved and what it contains.

## Care

- Keep the original document unchanged unless you were asked to edit it; write results to a new file next to it.
- Do not guess at content you could not read: say which part of the document was unreadable (images, embedded objects).
