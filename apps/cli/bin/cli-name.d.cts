/**
 * Types for cli-name.cjs, declared as ESM named exports so importers can use named imports
 * under verbatimModuleSyntax.
 */

export const commandName: "merak"

export const packageName: "merakcode"

export function binMap(): { readonly merak: string }

/** merakcode-<os>-<arch>; Windows is spelled "windows" */
export function platformPackage(platform: string, arch: string): string
