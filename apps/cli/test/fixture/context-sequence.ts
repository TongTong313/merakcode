import { join } from "node:path"
import { response, sequence } from "./sdk-sequence"
import { Filesystem } from "@merakcode/util/filesystem"

export async function context(mode: "attachment" | "hierarchy" | "auto" | "refresh" | "manual") {
  const rule = `RULE_${crypto.randomUUID()}`
  const other = `OTHER_${crypto.randomUUID()}`
  const observations: { rule: boolean; attached: boolean; fresh: boolean }[] = []
  const kit = await sequence(
    "read",
    false,
    ({ input, messages, outputs, project, send }) => {
      if (mode === "attachment") {
        if (input.includes("S07_MISSING")) {
          if (!input.includes("Read tool failed to read") || /MARKER_[a-f0-9-]+/.test(input))
            throw new Error("S07 missing attachment must report real failure without old content")
          return response("S07_MISSING_SHOWN")
        }
        const marker = input.match(/MARKER_[a-f0-9-]+/)?.[0]
        const second = input.match(/OTHER_[a-f0-9-]+/)?.[0]
        if (!marker || !input.includes("Called the Read tool")) throw new Error("S07 actual attachment read missing")
        if (input.includes("S07_TWO") && (second !== other || !input.includes("b.txt")))
          throw new Error("S07 second attachment content or identity missing")
        if (outputs.length) throw new Error("S07 attachments unexpectedly replaced with model tool calls")
        observations.push({ rule: false, attached: true, fresh: false })
        return response(`S07_ATTACHED_DONE ${marker} ${second ?? ""}`)
      }
      if (mode === "auto") {
        if (!outputs.length)
          return send("grep", { pattern: "export const add", path: join(project, "src"), include: "*.ts" })
        if (outputs.length === 1) {
          if (!outputs[0].text.includes("calc.ts")) throw new Error("S07 auto rule target not found by actual search")
          return send("read", { filePath: join(project, "src/calc.ts") })
        }
        if (outputs.length === 2) {
          const consumed = JSON.stringify(messages).includes(rule)
          observations.push({ rule: consumed, attached: false, fresh: false })
          if (!consumed || !outputs[1].text.includes("a - b"))
            throw new Error("S07 matching auto rule not consumed before edit")
          return send("edit", { filePath: join(project, "src/calc.ts"), oldString: "a - b", newString: "a + b" })
        }
      } else if (!outputs.length) return send("read", { filePath: join(project, "src/a.txt") })
      const marker = outputs
        .map((item) => item.text)
        .join("\n")
        .match(/MARKER_[a-f0-9-]+/)?.[0]
      if (!marker) throw new Error("S07 current actual read marker missing")
      if (mode === "hierarchy" || mode === "manual") {
        const consumed = JSON.stringify(messages).includes(rule)
        observations.push({ rule: consumed, attached: false, fresh: false })
        if (mode === "manual" && input.includes("S07_BASELINE")) {
          if (consumed) throw new Error("S07 unmentioned manual rule leaked into baseline")
          return response(`S07_BASELINE_DONE ${marker}`)
        }
        if (!consumed) throw new Error("S07 nested AGENTS did not reach actual model request")
        if (mode === "manual")
          return response(`${input.includes("S07_MANUAL_FOLLOW") ? "S07_PINNED_DONE" : "S07_MANUAL_DONE"} ${marker}`)
        return response(`S07_RULE_DONE ${marker}`)
      }
      if (mode === "auto") return response(`S07_AUTO_DONE ${marker}`)
      if (input.includes("S07_WRITE") && outputs.length === 1)
        return send("write", { filePath: join(project, "history.txt"), content: marker })
      if (input.includes("S07_WRITE") && !outputs[1]?.text.includes("Wrote file"))
        throw new Error("S07 actual history write did not finish")
      const fresh = outputs[0].text.match(/FRESH_[a-f0-9-]+/)?.[0]
      observations.push({ rule: false, attached: false, fresh: Boolean(fresh) })
      return response(
        `${input.includes("S07_FOLLOW") ? "S07_FRESH_DONE" : "S07_INITIAL_DONE"} ${marker} ${fresh ?? ""}`,
      )
    },
    async ({ project }) => {
      await Filesystem.write(join(project, "src/b.txt"), other)
      if (mode === "hierarchy")
        await Filesystem.write(
          join(project, "src/AGENTS.md"),
          `For files in this directory, record ${rule} in your reasoning and preserve keep.txt.\n`,
        )
      if (mode === "manual")
        await Filesystem.write(
          join(project, ".merakcode/rules/manual.mdc"),
          `---\nalwaysApply: false\nagents: [plan]\n---\n${rule}: Preserve keep.txt and report the file marker.\n`,
        )
      if (mode === "auto") {
        const marker = await Filesystem.readText(join(project, "src/a.txt"))
        await Filesystem.write(
          join(project, "src/calc.ts"),
          `// ${marker}\nexport const add = (a: number, b: number) => a - b\n`,
        )
        await Filesystem.write(
          join(project, ".merakcode/rules/calculation.mdc"),
          `---\nalwaysApply: false\nglobs: ["src/*.ts"]\n---\n${rule}: Replace subtraction with addition in the target function. Preserve keep.txt.\n`,
        )
      }
    },
  )
  return { ...kit, rule, other, contextObservations: observations }
}
