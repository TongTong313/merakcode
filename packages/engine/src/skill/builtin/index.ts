import { LOOP_SKILL } from "./loop"
import { AUTO_CLI_SKILL } from "./auto-cli"
import { PDF_SKILL } from "./pdf"
import { EXCEL_SKILL } from "./excel"
import { DOCX_SKILL } from "./docx"

export type BuiltinSkill = {
  name: string
  description: string
  content: string
  // Optional sub-files of the skill (filename -> content), read on demand by ReadTool via
  // builtin-skill://<skill-name>/<filename>. undefined means no sub-files
  files?: Record<string, string>
}

// Annotated as Record<string, BuiltinSkill> so TS does not infer a union of literal object types, which would make
// accessing optional fields such as files a type error
export const BUILTIN_SKILLS: Record<string, BuiltinSkill> = {
  loop: LOOP_SKILL,
  "auto-cli": AUTO_CLI_SKILL,
  pdf: PDF_SKILL,
  excel: EXCEL_SKILL,
  docx: DOCX_SKILL,
}
