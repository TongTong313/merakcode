/**
 * Monaco editor, loaded on demand. Vite bundles the language workers. Only syntax is validated: without project
 * context, semantic errors would be noise. The theme follows the UI's light / dark mode.
 */
import * as monaco from "monaco-editor"
import EditorWorker from "monaco-editor/editor/editor.worker?worker"
import CssWorker from "monaco-editor/language/css/css.worker?worker"
import HtmlWorker from "monaco-editor/language/html/html.worker?worker"
import JsonWorker from "monaco-editor/language/json/json.worker?worker"
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker"

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "json") return new JsonWorker()
    if (label === "css" || label === "scss" || label === "less") return new CssWorker()
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker()
    if (label === "typescript" || label === "javascript") return new TsWorker()
    return new EditorWorker()
  },
}

const ts = (monaco as unknown as { typescript?: { typescriptDefaults: TsDefaults; javascriptDefaults: TsDefaults } })
  .typescript
type TsDefaults = {
  setDiagnosticsOptions(options: { noSemanticValidation: boolean; noSyntaxValidation: boolean }): void
}
for (const defaults of [ts?.typescriptDefaults, ts?.javascriptDefaults])
  defaults?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })

/**
 * UI colors for the editor background, line numbers and so on, matching tokens.css. Monaco only accepts 6-digit hex,
 * so it cannot read the minified CSS variables.
 */
const COLORS = {
  light: { bg: "#ffffff", line: "#f4f4f5", number: "#9a9aa3", active: "#63636c" },
  dark: { bg: "#131315", line: "#202024", number: "#6e6e78", active: "#a0a0a9" },
}

function define() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches
  const color = COLORS[dark ? "dark" : "light"]
  monaco.editor.defineTheme("merakcode", {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": color.bg,
      "editorGutter.background": color.bg,
      "editor.lineHighlightBackground": color.line,
      "editorLineNumber.foreground": color.number,
      "editorLineNumber.activeForeground": color.active,
    },
  })
  monaco.editor.setTheme("merakcode")
}
define()
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", define)

export { monaco }
