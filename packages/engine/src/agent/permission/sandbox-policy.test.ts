import { afterEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SandboxPolicy } from "./sandbox-policy"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const workspace = [path.resolve("/work/demo")]
const home = path.resolve("/home/dev")
const tmp = path.resolve("/tmp/merakcode")

describe("SandboxPolicy.build", () => {
  test("machine setup receives the same credential denials and cache grants as command policy", () => {
    const base = SandboxPolicy.base(home)
    expect(base.readDeny).toContain(path.join(home, ".ssh"))
    expect(base.readDeny).toContain(path.join(home, ".config", "gh"))
    expect(base.writeAllow).toContain(path.join(home, ".npm"))
    expect(base.writeAllow).toContain(path.join(home, "AppData", "Local", "pnpm"))
    expect(base.writeAllow).not.toContain(home)
    const policy = SandboxPolicy.build({ workspace, home, tmp })
    expect(policy.read.deny).toEqual(base.readDeny)
    expect(policy.write.allow).toEqual([...workspace, tmp, ...base.writeAllow])
  })

  test("writes: workspace, temp dir, package caches and extra directories; never the home itself", () => {
    const policy = SandboxPolicy.build({ workspace, home, tmp, writable: [path.join(home, "out")] })
    expect(policy.write.allow).toEqual(
      expect.arrayContaining([
        ...workspace,
        tmp,
        path.join(home, ".npm"),
        path.join(home, ".cache"),
        path.join(home, "out"),
      ]),
    )
    expect(policy.write.allow).not.toContain(home)
  })

  test("protects .git/hooks, .git/config and MerakCode's config files of every workspace root", () => {
    const roots = [path.resolve("/work/a"), path.resolve("/work/b")]
    const policy = SandboxPolicy.build({ workspace: roots, home, tmp })
    expect(policy.write.protect).toEqual(
      roots.flatMap((root) => [
        path.join(root, ".git", "hooks"),
        path.join(root, ".git", "config"),
        path.join(root, "merakcode.json"),
        path.join(root, "merakcode.jsonc"),
        path.join(root, ".merakcode", "merakcode.json"),
        path.join(root, ".merakcode", "merakcode.jsonc"),
      ]),
    )
  })

  test("reads: credential directories are denied, plus the extra ones; ~ means the home", () => {
    const policy = SandboxPolicy.build({ workspace, home, tmp, readDeny: ["~/secrets", path.resolve("/opt/keys")] })
    for (const dir of [".ssh", ".aws", ".azure", ".kube", ".gnupg", ".docker", ".config/gcloud", ".config/gh"])
      expect(policy.read.deny, dir).toContain(path.join(home, dir))
    expect(policy.read.deny).toContain(path.join(home, "secrets"))
    expect(policy.read.deny).toContain(path.resolve("/opt/keys"))
  })

  test("network: keeps valid host patterns only and removes duplicates", () => {
    const policy = SandboxPolicy.build({
      workspace,
      home,
      tmp,
      network: { allow: ["github.com", "github.com", "exa*mple.org"], deny: ["*.example.com", "bad pattern"] },
    })
    expect(policy.network.allow).toEqual(["github.com"])
    expect(policy.network.deny).toEqual(["*.example.com"])
    expect(policy.network.blockPorts).toEqual([])
    expect(policy.network.localPorts).toEqual([])
  })

  test("paths are resolved to their real location; missing paths are kept as given", () => {
    // The temp folder itself may be an alias (/var on macOS, 8.3 short names on Windows), so start from its real path
    const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "policy-")))
    roots.push(base)
    const real = path.join(base, "real")
    mkdirSync(real)
    const link = path.join(base, "link")
    symlinkSync(real, link, "junction")
    const missing = path.join(base, "missing")
    const policy = SandboxPolicy.build({ workspace: [link], home, tmp, writable: [missing] })
    expect(policy.write.allow).toContain(real)
    expect(policy.write.allow).not.toContain(link)
    expect(policy.write.allow).toContain(missing)
  })
})
