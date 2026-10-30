import { LOOP_SKILL } from "./loop"
import { ADAPTER_GENERATOR_SKILL } from "./adapter-generator"
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
  // The folder the sub-files are in on disk, when they are: they are listed there too, for shell commands to copy them
  // (they cannot read builtin-skill://)
  dir?: string
}

// Annotated as Record<string, BuiltinSkill> so TS does not infer a union of literal object types, which would make
// accessing optional fields such as files a type error
export const BUILTIN_SKILLS: Record<string, BuiltinSkill> = {
  loop: LOOP_SKILL,
  "adapter-generator": ADAPTER_GENERATOR_SKILL,
  pdf: PDF_SKILL,
  excel: EXCEL_SKILL,
  docx: DOCX_SKILL,
}
