import path from "path"
import { Global } from "../../infra/global"
import { Instance } from "../../infra/project/instance"
import { MEMORY_TYPES, type MemoryType } from "./types"

export namespace MemoryPath {
  export const ENTRYPOINT_NAME = "MEMORY.md"

  function root() {
    return Instance.worktree === "/" ? Instance.directory : Instance.worktree
  }

  function segment(input: string, fallback: string, limit: number) {
    return (
      input
        .normalize("NFC")
        .replace(/^[A-Za-z]:/, (drive) => drive[0])
        .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-+/g, "-")
        .slice(0, limit) || fallback
    )
  }

  export function projectKey(input: string) {
    return segment(input, "project", 180)
  }

  function topicKey(input: string) {
    return (
      segment(input.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"), "memory", 80)
        .replace(/^\.+|\.+$/g, "")
        .replace(/-+/g, "-") || "memory"
    )
  }

  export function directory() {
    return path.join(Global.Path.data, "memory", "projects", projectKey(root())) + path.sep
  }

  export function entrypoint() {
    return path.join(directory(), ENTRYPOINT_NAME)
  }

  export function typeDir(type: MemoryType) {
    return path.join(directory(), type) + path.sep
  }

  export function typeDirs() {
    return MEMORY_TYPES.map(typeDir)
  }

  export function topic(type: MemoryType, name: string) {
    return path.join(typeDir(type), topicKey(name) + ".md")
  }
}
