---
name: excel
description: Read, analyze, or write Excel (.xlsx) spreadsheets
---

Use this skill when the task involves an Excel workbook: reading sheets, checking numbers, summarizing a table, or producing a new .xlsx file.

## Reading

- Open the workbook with read_xlsx. It lists the sheets and returns each sheet as rows of cells. Ask for one sheet at a time when the workbook is large.
- Formulas come back with their last calculated value; if a value looks stale, say so rather than recomputing it silently.
- Treat the first non-empty row as the header unless the sheet clearly has none.

## Analysis

- Do arithmetic with a command or a script rather than in your head: totals, averages and counts must be exact. Show the numbers you used.
- When rows are missing values, report how many and how you handled them.

## Writing

- Write results with write_xlsx: give it the sheet name, the header row and the data rows. Keep one table per sheet and use plain values, not formulas, unless a formula was requested.
- Save to a new file next to the original unless you were asked to change the original, and say where it is.
