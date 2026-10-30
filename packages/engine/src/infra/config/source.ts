import path from "path"
import os from "os"
import { Filesystem } from "@merakcode/util/filesystem"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import type { ConfigWarning } from "./recover"

/** Substitutes file and environment references, then parses a JSONC source without changing it on disk. */
export async function parseConfigSource(text: string, configFilepath: string) {
  const warnings: ConfigWarning[] = []
  text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => process.env[varName] || "")

  const fileMatches = text.match(/\{file:[^}]+\}/g)
  if (fileMatches) {
    const configDir = path.dirname(configFilepath)
    const lines = text.split("\n")

    for (const match of fileMatches) {
      const lineIndex = lines.findIndex((line) => line.includes(match))
      if (lineIndex !== -1 && lines[lineIndex].trim().startsWith("//")) continue
      let filePath = match.replace(/^\{file:/, "").replace(/\}$/, "")
      if (filePath.startsWith("~/")) filePath = path.join(os.homedir(), filePath.slice(2))
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
      const fileContent = (
        await Filesystem.readText(resolvedPath).catch((error) => {
          const errMsg =
            error.code === "ENOENT"
              ? `bad file reference: "${match}" ${resolvedPath} does not exist`
              : `bad file reference: "${match}"`
          warnings.push({
            path: configFilepath,
            item: match,
            reason: {
              zh: `${errMsg}；已临时跳过该引用，请修改后重载`,
              en: `${errMsg}; this reference is skipped for now. Fix it and reload.`,
            },
          })
          return ""
        })
      ).trim()
      text = text.replace(match, () => JSON.stringify(fileContent).slice(1, -1))
    }
  }

  const errors: ParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (!errors.length) return { data, warnings, invalid: false as const }

  const lines = text.split("\n")
  const errorDetails = errors
    .map((e) => {
      const beforeOffset = text.substring(0, e.offset).split("\n")
      const line = beforeOffset.length
      const column = beforeOffset[beforeOffset.length - 1].length + 1
      const problemLine = lines[line - 1]
      const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
      if (!problemLine) return error
      return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
    })
    .join("\n")

  warnings.push({
    path: configFilepath,
    item: "(root)",
    reason: {
      zh: `JSON 语法错误，已临时按空配置加载；请修改后重载。${errorDetails}`,
      en: `JSON syntax error; loaded as empty for now. Fix it and reload. ${errorDetails}`,
    },
  })
  return { data: undefined, warnings, invalid: true as const }
}
