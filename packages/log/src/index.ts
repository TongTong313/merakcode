import type { LogRecord } from "./record"

export type { LogLevel, LogRecord, RecordInput } from "./record"
export { buildRecord, formatText, sanitize } from "./record"

export interface Sink {
  write(record: LogRecord | string): number
  flush?(): Promise<void>
  close(): void | Promise<void>
}
export { LogQueue } from "./queue"
export { failure } from "./failure"
