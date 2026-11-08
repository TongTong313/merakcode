import { expect, test } from "vitest"
import { submissionParts } from "./send"

test("sends text, images and documents in the engine's message format", () => {
  expect(
    submissionParts({
      text: "Inspect these",
      files: [
        { filename: "image.png", mime: "image/png", url: "data:image/png;base64,aW1hZ2U=" },
        { filename: "report.pdf", mime: "application/pdf", url: "data:application/pdf;base64,cGRm" },
      ],
    }),
  ).toEqual([
    { text: "Inspect these" },
    { image: { mime: "image/png", data: "aW1hZ2U=" } },
    { document: { mime: "application/pdf", name: "report.pdf", data: "cGRm" } },
  ])
})

test.each(["https://example.com/file", "data:text/plain;base64,Y===", "data:text/plain;base64,a"])(
  "rejects an invalid attachment payload %s",
  (url) => {
    expect(() => submissionParts({ text: "", files: [{ filename: "file.txt", mime: "text/plain", url }] })).toThrow(
      "MRK-3001",
    )
  },
)
