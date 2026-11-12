import { gitDirectory } from "../../state/git"
import z from "zod"
import { MerakCodeError } from "../../state/error"
import { t } from "../../i18n"
import { decodeDir, encodeDir } from "../../lib/route"
import { persistent } from "../../lib/persistence"
import { client } from "../../state/client"
import { storedReviewDirectories } from "../review/protection"

type Address = { directory: string; path: string }
export type RecoveryMode = "resolve" | "cached"
const resolved = new Map<string, Address>()
const prepared = new Set<string>()
const pending = new Map<string, Promise<Address>>()
const keyOf = (value: Address) => `${normalize(value.directory)}\0${value.path}`
const identitySchema = z.object({ directory: z.string().min(1) }).nullish()
const directorySchema = z.union([z.string().min(1), z.object({ version: z.literal(1), directory: z.string().min(1) })])
const recoverySchema = z.object({
  directory: z.string().min(1),
  previous: z.string().min(1),
  actual: z.string().min(1),
  recoverable: z.literal(true),
})
const draftIdentitySchema = z.object({
  identity: identitySchema,
  alternatives: z.array(z.object({ identity: identitySchema })).optional(),
})

async function draftDirectories(directory: string) {
  const roots = new Set<string | undefined>()
  for (const [, raw] of await persistent.entries(`draft-${encodeDir(directory)}`)) {
    try {
      const draft = draftIdentitySchema.parse(JSON.parse(raw))
      for (const value of [draft, ...(draft.alternatives ?? [])]) roots.add(value.identity?.directory)
    } catch {
      roots.add(undefined)
    }
  }
  return roots
}

/** Two spellings of one directory share an identity. A failed lookup stays unequal so protection is unchanged. */
async function sameIdentity(left: string, right: string) {
  if (normalize(left) === normalize(right)) return true
  try {
    const [first, second] = await Promise.all([directoryIdentity(left), directoryIdentity(right)])
    return normalize(first.directory) === normalize(second.directory)
  } catch {
    return false
  }
}

function recoveryFailure(directory: string, cause?: unknown) {
  if (cause instanceof MerakCodeError && cause.code === "MRK-5023") return cause
  return new MerakCodeError({
    code: "MRK-5023",
    message: t("code.directoryRecovery", { directory }),
    requestID: cause instanceof MerakCodeError ? cause.requestID : undefined,
    data: { directory },
    cause,
  })
}

async function directoryRecord(directory: string) {
  const saved = await persistent.get("file-directories", normalize(directory))
  try {
    return saved === null ? undefined : directorySchema.parse(JSON.parse(saved))
  } catch (cause) {
    throw recoveryFailure(directory, cause)
  }
}

/** A link changing its target cannot change the owner of recovery records left under its old spelling. */
async function rememberDirectory(directory: string, actual: string) {
  const record = await directoryRecord(directory)
  const previous = typeof record === "string" ? record : record?.directory
  if (previous === actual && typeof record !== "string") return
  const reviews = await storedReviewDirectories()
  const matches = (value: string | undefined) => value !== undefined && normalize(value) === normalize(directory)
  if (!previous || typeof record === "string") {
    const roots = [
      ...(await draftDirectories(directory)),
      ...reviews
        .filter((review) => matches(review.directory))
        .flatMap((review) => review.confirmed.filter((root) => !matches(root))),
    ]
    for (const root of roots) {
      if (!root || normalize(root) === normalize(actual) || (await sameIdentity(root, actual))) continue
      throw recoveryFailure(directory)
    }
  }
  const sameSpelling = !!previous && normalize(previous) !== normalize(actual) && (await sameIdentity(previous, actual))
  const selfMapping = typeof record === "string" && !!previous && normalize(previous) === normalize(directory)
  if (previous && normalize(previous) !== normalize(actual) && (!sameSpelling || selfMapping)) {
    const protectedReview = reviews.some((review) => matches(review.directory) || review.targets.some(matches))
    const files = await Promise.all(
      ["draft-", "file-links-"].map((prefix) => persistent.entries(`${prefix}${encodeDir(directory)}`)),
    )
    if (protectedReview || files.some((entries) => entries.length)) {
      const error = recoveryFailure(directory)
      if (typeof record === "string" && normalize(previous) === normalize(directory))
        throw new MerakCodeError({
          code: error.code,
          message: error.message,
          data: { directory, previous, actual, recoverable: true },
        })
      throw error
    }
  }
  await persistent.set("file-directories", normalize(directory), JSON.stringify({ version: 1, directory: actual }))
}

/** Only ambiguous legacy self-mappings offer an explicit choice; confirmed retargets stay protected. */
export function directoryRecovery(error: unknown): z.infer<typeof recoverySchema> | undefined {
  if (!(error instanceof Error)) return
  if (error instanceof MerakCodeError && error.code === "MRK-5023") {
    const result = recoverySchema.safeParse(error.data)
    if (result.success) return result.data
  }
  if (error.cause !== error) return directoryRecovery(error.cause)
}

export async function recoverDirectory(input: z.infer<typeof recoverySchema>) {
  const choice = recoverySchema.parse(input)
  const record = await directoryRecord(choice.directory)
  const actual = await directoryIdentity(choice.directory)
  if (record !== choice.previous || normalize(actual.directory) !== normalize(choice.actual))
    throw recoveryFailure(choice.directory)
  await persistent.set(
    "file-directories",
    normalize(choice.directory),
    JSON.stringify({ version: 1, directory: actual.directory }),
  )
}

/** The engine names a directory by one canonical form; a failed lookup keeps drafts protected as a recovery error. */
async function directoryIdentity(directory: string) {
  return (await client()).file.identity({ directory, path: "." }).catch((cause: unknown) => {
    throw recoveryFailure(directory, cause)
  })
}

/** Records which directory an alias confirmed to be. */
export async function confirmDirectory(directory: string, actual: string) {
  await rememberDirectory(directory, actual)
  if (normalize(directory) !== normalize(actual)) await rememberDirectory(actual, actual)
  return actual
}

/** Keep mounted editors' keys stable across spelling-only renames, after verifying both paths through the SDK. */
async function liveAddress(value: Address, requested: Address) {
  const fold = (path: string) => path.normalize("NFC").toLowerCase()
  const candidates = new Map([...resolved.values()].map((address) => [keyOf(address), address]))
  for (const [key, address] of candidates) {
    if (key === keyOf(value)) return address
    if (normalize(address.directory) !== normalize(value.directory) || fold(address.path) !== fold(value.path)) continue
    const actual =
      key === keyOf(requested)
        ? value
        : await (await client()).file.identity({ directory: address.directory, path: address.path })
    if (keyOf(actual) === keyOf(value)) return address
  }
  return value
}

/** Explicit opens refresh disk spelling; draft and reference migration share the resolved aliases. */
export async function resolveFile(directory: string, path: string, fresh = true): Promise<Address> {
  const address = lexicalAddress(directory, path)
  if (path.startsWith("merakcode-plan://")) return address
  const key = keyOf(address)
  if (!fresh && resolved.has(key)) return resolved.get(key)!
  const known = pending.get(key)
  if (known) return known
  const request = client()
    .then((connection) => connection.file.identity({ directory: address.directory, path: address.path }))
    .then(async (value) => {
      const live = await liveAddress(value, address)
      for (const source of new Set([directory, address.directory, value.directory]))
        await rememberDirectory(source, value.directory)
      resolved.set(key, live)
      resolved.set(keyOf(value), live)
      prepared.add(normalize(address.directory))
      prepared.add(normalize(value.directory))
      return live
    })
    .finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}

/** Persist SDK-confirmed roots so an unrelated offline directory is not a prerequisite for recovery. */
async function recoveryDirectory(directory: string, mode: RecoveryMode) {
  const saved = await directoryRecord(directory)
  if (saved !== undefined && typeof saved !== "string") return saved.directory
  if (typeof saved === "string" && normalize(saved) !== normalize(directory)) return saved
  if (mode === "cached") throw recoveryFailure(directory)
  const roots = await draftDirectories(directory)
  // Older composers stored the SDK-normalized target even when their layout kept the route alias.
  for (const review of await storedReviewDirectories()) {
    if (!review.directory || normalize(review.directory) === normalize(directory)) continue
    if (review.confirmed.some((root) => normalize(root) === normalize(directory))) roots.add(directory)
  }
  try {
    // Old Git drafts already carry the SDK-confirmed checkout used to protect their save target.
    const recorded = roots.size === 1 ? [...roots][0]! : undefined
    if (!recorded) return await confirmDirectory(directory, (await directoryIdentity(directory)).directory)
    await rememberDirectory(directory, recorded)
    return recorded
  } catch (cause) {
    throw recoveryFailure(directory, cause)
  }
}

export async function sameRecoveryDirectory(a: string, b: string, mode: RecoveryMode = "resolve") {
  if (normalize(a) === normalize(b)) return true
  const source = await recoveryDirectory(a, mode)
  if (normalize(source) === normalize(b)) return true
  return normalize(source) === normalize(await recoveryDirectory(b, mode))
}

export async function storedFileAddress(
  directory: string,
  path: string,
  planSessionID?: string,
  mode: RecoveryMode = "resolve",
) {
  if (
    planSessionID ||
    path.startsWith("merakcode-plan://") ||
    (gitDirectory(directory) === directory &&
      !prepared.has(normalize(directory)) &&
      !(await directoryRecord(directory)))
  )
    return fileAddress(directory, path, planSessionID)
  if (mode === "cached") {
    const known = resolved.get(keyOf(lexicalAddress(directory, path)))
    if (!known) throw recoveryFailure(directory)
    return known
  }
  return resolveFile(directory, path, false)
}

export const sameFileDirectory = (a: string, b: string) => normalize(gitDirectory(a)) === normalize(gitDirectory(b))

function normalize(path: string) {
  const value = path.replace(/\\/g, "/")
  const prefix = value.startsWith("//") ? "//" : value.startsWith("/") ? "/" : ""
  const parts: string[] = []
  for (const part of value.split("/")) {
    if (!part || part === ".") continue
    if (part === ".." && parts.length && parts.at(-1) !== ".." && !parts.at(-1)!.endsWith(":")) parts.pop()
    else if (part !== ".." || !prefix) parts.push(part)
  }
  return prefix + parts.join("/")
}

/** Recover persisted directory aliases through the SDK, including roots without a Git checkout. */
export async function fileDirectories(prefix: string, directory: string, mode: RecoveryMode = "resolve") {
  const actual = gitDirectory(directory)
  const candidates = (await persistent.buckets())
    .filter((bucket) => bucket.startsWith(prefix))
    .flatMap((bucket) => {
      const value = decodeDir(bucket.slice(prefix.length))
      return value ? [value] : []
    })
  const related: string[] = []
  for (const candidate of candidates) {
    if (!(await persistent.entries(`${prefix}${encodeDir(candidate)}`)).length) continue
    try {
      if (await sameRecoveryDirectory(candidate, actual, mode)) related.push(candidate)
    } catch (error) {
      const choice = directoryRecovery(error)
      if (
        !(error instanceof MerakCodeError) ||
        error.code !== "MRK-5023" ||
        normalize(candidate) === normalize(directory) ||
        normalize(candidate) === normalize(actual) ||
        (choice && normalize(choice.actual) === normalize(actual))
      )
        throw error
      // Unconfirmed offline records keep their original owner and bytes until that directory reconnects.
    }
  }
  return [...new Set([directory, actual, ...related])]
}

function lexicalAddress(directory: string, path: string, planSessionID?: string) {
  const actual = gitDirectory(directory)
  if (planSessionID)
    return { directory: actual, path: `merakcode-plan://${encodeURIComponent(planSessionID)}/Plan-${planSessionID}.md` }
  if (path.startsWith("merakcode-plan://")) return { directory: actual, path }
  const root = normalize(actual)
  if (!root) return { directory: actual, path: normalize(path) }
  const absolute = /^(?:[a-z]:[\\/]|[\\/])/i.test(path) ? normalize(path) : normalize(`${normalize(directory)}/${path}`)
  const canonical = absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute
  return { directory: actual, path: canonical }
}

export function fileAddress(directory: string, path: string, planSessionID?: string): Address {
  const address = lexicalAddress(directory, path, planSessionID)
  return resolved.get(keyOf(address)) ?? address
}
