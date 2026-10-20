import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

/**
 * Minimal wrapper for calling system shared libraries: get a buffer's address, call an exported function, and read
 * bytes back from an address. Built on node:ffi. Pointers are bigint, library handles stay open, and functions are
 * cached per "library:function".
 */
export type Native = {
  pointer(buffer: Buffer): bigint
  call(library: string, name: string, args: string[], returns: string, values: (bigint | number)[]): bigint | number
  read(address: bigint, size: number): Buffer
}

/** Returns undefined when FFI is not available on this platform */
export function native(): Native | undefined {
  try {
    const ffi = require("node:ffi")
    const libraries = new Map<string, Record<string, (...args: unknown[]) => bigint | number>>()
    return {
      pointer: (buffer) => ffi.getRawPointer(buffer.buffer) + BigInt(buffer.byteOffset),
      call(library, name, args, returns, values) {
        const key = `${library}:${name}`
        const fn =
          libraries.get(key)?.[name] ??
          (() => {
            const { functions } = ffi.dlopen(library, {
              [name]: { arguments: args.map(nodeType), return: nodeType(returns) },
            })
            libraries.set(key, functions)
            return functions[name]
          })()
        return fn(...values)
      },
      // Copy: the caller frees that memory afterwards (e.g. LocalFree), which would invalidate a view
      read: (address, size) => Buffer.from(new Uint8Array(ffi.toArrayBuffer(address, size, true))),
    }
  } catch {
    return
  }
}

const nodeType = (type: string) => (type === "ptr" ? "pointer" : type)
