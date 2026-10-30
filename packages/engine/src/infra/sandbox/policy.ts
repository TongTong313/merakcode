/** Plain execution constraints shared by the OS backends and their helper processes. */
export type Policy = {
  read: { deny: string[] }
  write: { allow: string[]; protect: string[] }
  network: { allow: string[]; deny: string[]; blockPorts: number[]; localPorts: number[] }
}

/** Machine-level grants and denials, supplied by the caller rather than chosen by a backend. */
export type BasePolicy = { readDeny: string[]; writeAllow: string[] }
