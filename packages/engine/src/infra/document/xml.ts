// XML and zip entry helpers shared by the excel and docx parsers, so docx does not depend on the excel module

import { TextWriter } from "@zip.js/zip.js"

/** Minimal zip entry interface (a subset of zip.js's Entry) */
export type ZipEntry = {
  filename: string
  uncompressedSize?: number
  getData(writer: unknown): Promise<unknown>
}

/** Default size limit for small parts read whole as strings (workbook, rels, styles and the like) */
export const MAX_XML_ENTRY_BYTES = 20 * 1024 * 1024

/** Reads a small part as a whole string, checking both uncompressedSize and the text length against the limit */
export async function readEntry(entry: ZipEntry | undefined, maxBytes = MAX_XML_ENTRY_BYTES): Promise<string> {
  if (!entry) return ""
  if (typeof entry.uncompressedSize === "number" && entry.uncompressedSize > maxBytes) {
    throw new Error(
      `XML entry is too large: ${entry.filename} (${formatBytes(entry.uncompressedSize)}). Limit: ${formatBytes(maxBytes)}.`,
    )
  }
  const text = ((await entry.getData(new TextWriter())) as string | undefined) ?? ""
  if (text.length > maxBytes) {
    throw new Error(
      `XML entry is too large: ${entry.filename} (${formatBytes(text.length)}). Limit: ${formatBytes(maxBytes)}.`,
    )
  }
  return text
}

/** Normalizes a zip entry path (forward slashes, no leading slash) so it matches map keys exactly */
export function normalizeEntry(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "")
}

export function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function tag(xml: string, name: string) {
  return tags(xml, name)[0]
}

/**
 * Matches every `<name ...>body</name>` or self-closing `<name .../>` tag with a regex. For small parts only: nested
 * tags of the same name are not handled.
 */
export function tags(xml: string, name: string) {
  const result: { open: string; body: string }[] = []
  const tagName = escapeRegExp(name)
  const pattern = new RegExp(
    `<([\\w:]+:)?${tagName}\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/([\\w:]+:)?${tagName}>)`,
    "gi",
  )
  for (const match of xml.matchAll(pattern)) {
    result.push({ open: `${match[1] ?? ""}${name}${match[2] ?? ""}`, body: match[3] ?? "" })
  }
  return result
}

/** Reads an attribute value from an opening tag, decoded with decodeXml */
export function attr(open: string, name: string) {
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(name)}=(["'])(.*?)\\1`, "i")
  const value = open.match(pattern)?.[2]
  return value === undefined ? undefined : decodeXml(value)
}

export function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
