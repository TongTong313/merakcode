/**
 * Tool inputs and metadata as read by `run`. Only fields it prints are listed, and any of them may be missing
 * (mid-stream, old messages). Engine events carry them as untyped objects (see the SDK's ToolPart); this module gives
 * the command's view of them per tool name.
 */
import type { Todo } from "@merakcode/sdk/client"

type Diagnostic = { range: { start: { line: number; character: number } }; message: string; severity?: number }
type Question = {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiple?: boolean
}

export type ToolView = {
  bash: { input: { command: string; description: string; workdir: string }; metadata: { output: string } }
  write: { input: { content: string; filePath: string }; metadata: { diagnostics: Record<string, Diagnostic[]> } }
  glob: { input: { path: string; pattern: string }; metadata: { count: number } }
  read: { input: { filePath: string; offset: number; limit: number }; metadata: { loaded: string[] } }
  grep: { input: { path: string; pattern: string; include: string }; metadata: { matches: number } }
  ls: { input: { path: string }; metadata: {} }
  webfetch: { input: { url: string; format: string }; metadata: {} }
  codesearch: { input: { query: string }; metadata: {} }
  websearch: { input: { query: string }; metadata: {} }
  edit: {
    input: { filePath: string; oldString: string; newString: string; replaceAll: boolean }
    metadata: { diagnostics: Record<string, Diagnostic[]>; diff: string }
  }
  multi_edit: {
    input: { filePath: string; edits: { oldString: string; newString: string; replaceAll?: boolean }[] }
    metadata: { diagnostics: Record<string, Diagnostic[]>; diff: string }
  }
  subagent: {
    input: { description: string; prompt: string; subagent_type: string }
    metadata: { phase: string; sessionId: string }
  }
  question: { input: { questions: Question[] }; metadata: { answers: string[][] } }
  rule: { input: { name: string; filepath: string }; metadata: {} }
  skill: { input: { name: string; query: string }; metadata: { matched: string[] } }
  todowrite: { input: { todos: Todo[] }; metadata: { todos: Todo[] } }
}

export type ToolInput<Name extends keyof ToolView> = Partial<ToolView[Name]["input"]>
export type ToolMetadata<Name extends keyof ToolView> = Partial<ToolView[Name]["metadata"]>
