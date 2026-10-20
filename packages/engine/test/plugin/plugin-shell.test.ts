import { describe, expect, test } from "vitest"
import { createPluginShell } from "../../src/plugin/shell"
import { tmpdir } from "../fixture/fixture"

const $ = createPluginShell()

describe("plugin $", () => {
  test("an interpolated value is passed as one argument without splitting or expansion", async () => {
    const value = `a b; echo injected $HOME 'q'`
    expect(await $`printf '%s' ${value}`.text()).toBe(value)
  })

  test("an interpolated array becomes multiple arguments and { raw } is inserted verbatim", async () => {
    expect(await $`printf '[%s]' ${["one", "two words"]}`.text()).toBe("[one][two words]")
    expect(await $`${{ raw: "echo raw && echo ok" }}`.text()).toBe("raw\nok\n")
  })

  test("a non-zero exit throws with the exit code and output, and nothrow returns the result", async () => {
    const error = await $`echo out; echo err >&2; exit 4`.catch((caught) => caught)
    expect(error.exitCode).toBe(4)
    expect(error.stderr.toString().trim()).toBe("err")
    const result = await $`exit 5`.nothrow()
    expect(result.exitCode).toBe(5)
  })

  test("cwd and env can be set per command or as defaults on $", async () => {
    await using dir = await tmpdir()
    const scoped = $.cwd(dir.path).env({ ...process.env, PROBE: "default" })
    expect((await scoped`echo $PROBE`.text()).trim()).toBe("default")
    expect((await scoped`echo $PROBE`.env({ ...process.env, PROBE: "once" }).text()).trim()).toBe("once")
  })

  test("json, lines and arrayBuffer read the output", async () => {
    expect(await $`echo '{"a":1}'`.json()).toEqual({ a: 1 })
    const lines: string[] = []
    for await (const line of $`printf 'x\ny\n'`.lines()) lines.push(line)
    expect(lines).toEqual(["x", "y"])
    expect(new TextDecoder().decode(await $`printf ab`.arrayBuffer())).toBe("ab")
  })

  test("escape follows shell quoting rules", async () => {
    expect(await $`printf '%s' ${{ raw: $.escape("it's") }}`.text()).toBe("it's")
  })
})
