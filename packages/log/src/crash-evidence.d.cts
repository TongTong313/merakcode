export function nativeEvidence(text: string): {
  runtime_crash_signature: boolean
  native_fault_signature: boolean
  runtime_version?: string
  fault_address?: string
  modules_observed: string[]
}
export class CrashEvidence {
  readonly file: string
  constructor(options: { root?: string; component: string; runId: string })
  write(chunk: string | Uint8Array): number
  close(options?: { keep?: boolean; code?: number | null; signal?: string | null }): void
}
