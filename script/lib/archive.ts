import { execFileSync } from "node:child_process"
import { createReadStream, createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import zlib from "node:zlib"

/**
 * Packing and unpacking release archives: .tar.gz on Linux / macOS and .zip on Windows (the native format for each).
 *
 * Packing is done here instead of with the system tar: when building Linux / macOS packages on Windows, the file
 * system has no executable bit and the system tar would produce a node binary and launcher scripts that cannot run.
 * Permissions are decided the same way on every system, so a checkout that lost an executable bit still packs
 * correctly: 755 for files that are already executable, files under bin/, scripts with a shebang and ELF / Mach-O
 * binaries, and 644 for everything else.
 */
export namespace Archive {
  /** Packs dir into file (format chosen by extension); the top-level directory in the archive is named after dir */
  export async function create(dir: string, file: string) {
    const entries = await walk(dir)
    const base = path.basename(dir)
    if (file.endsWith(".zip")) return zip(entries, base, file)
    await pipeline(Readable.from(tar(entries, base)), zlib.createGzip({ level: 9 }), createWriteStream(file))
  }

  /**
   * Extracts into dest, creating it if needed. Uses the system bsdtar (bundled since Windows 10 and on macOS); zip
   * files on Linux use unzip.
   */
  export async function extract(file: string, dest: string) {
    await fs.mkdir(dest, { recursive: true })
    // Under the C locale (common in CI and containers) GNU tar and unzip mangle UTF-8 file names
    const env = process.platform === "linux" ? { ...process.env, LC_ALL: "C.UTF-8" } : process.env
    if (file.endsWith(".zip") && process.platform === "linux")
      return void execFileSync("unzip", ["-q", file, "-d", dest], { env })
    // On Windows the tar on PATH may be Git's GNU tar, which cannot read zip, so use the system one
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot!, "System32", "tar.exe") : "tar"
    execFileSync(tar, ["-xf", file, "-C", dest], { env })
  }

  type Entry = { file: string; name: string; size: number; mode: number; mtime: Date }

  async function walk(dir: string, prefix = ""): Promise<Entry[]> {
    const items = await fs.readdir(dir, { withFileTypes: true })
    const nested = await Promise.all(
      items
        .toSorted((a, b) => (a.name < b.name ? -1 : 1))
        .map(async (item): Promise<Entry[]> => {
          const file = path.join(dir, item.name)
          const name = prefix + item.name
          if (item.isDirectory()) return walk(file, name + "/")
          const stat = await fs.stat(file)
          return [{ file, name, size: stat.size, mode: await mode(file, name, stat.mode), mtime: stat.mtime }]
        }),
    )
    return nested.flat()
  }

  async function mode(file: string, name: string, actual: number) {
    if (process.platform !== "win32" && actual & 0o111) return 0o755
    if (name.startsWith("bin/") || name.startsWith("node/bin/")) return 0o755
    const handle = await fs.open(file)
    const head = Buffer.alloc(4)
    await handle.read(head, 0, 4, 0).finally(() => handle.close())
    const magic = head.readUInt32BE(0)
    const executable =
      head.subarray(0, 2).toString() === "#!" ||
      magic === 0x7f454c46 || // ELF
      [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic) // Mach-O and universal binaries
    return executable ? 0o755 : 0o644
  }

  // tar (ustar), with a pax extended header for paths over 100 bytes or with non-ASCII characters

  function octal(value: number, length: number) {
    return value.toString(8).padStart(length - 1, "0") + "\0"
  }

  function header(name: string, size: number, mode: number, mtime: Date, type: "0" | "x") {
    const block = Buffer.alloc(512)
    block.write(name.slice(0, 99), 0, "utf8")
    block.write(octal(mode, 8), 100)
    block.write(octal(0, 8), 108)
    block.write(octal(0, 8), 116)
    block.write(octal(size, 12), 124)
    block.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136)
    block.write(" ".repeat(8), 148)
    block.write(type, 156)
    block.write("ustar\0" + "00", 257)
    const sum = block.reduce((total, byte) => total + byte, 0)
    block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148)
    return block
  }

  function pax(name: string, mtime: Date) {
    const body = `path=${name}\n`
    // The record length in bytes includes its own digits, so recompute when the digit count changes
    let length = Buffer.byteLength(body) + 3
    while (Buffer.byteLength(`${length} ${body}`) !== length) length = Buffer.byteLength(`${length} ${body}`)
    const record = Buffer.from(`${length} ${body}`)
    return [
      header("PaxHeader", record.length, 0o644, mtime, "x"),
      record,
      Buffer.alloc((512 - (record.length % 512)) % 512),
    ]
  }

  async function* tar(entries: Entry[], base: string) {
    for (const entry of entries) {
      const name = `${base}/${entry.name}`
      if (Buffer.byteLength(name) > 99 || /[^\x20-\x7e]/.test(name)) yield* pax(name, entry.mtime)
      yield header(name, entry.size, entry.mode, entry.mtime, "0")
      yield* createReadStream(entry.file)
      yield Buffer.alloc((512 - (entry.size % 512)) % 512)
    }
    yield Buffer.alloc(1024)
  }

  // zip (deflate); entry count and size stay far below the zip64 limits

  function dos(date: Date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    return { time, day }
  }

  async function zip(entries: Entry[], base: string, file: string) {
    const out = createWriteStream(file)
    const write = (chunk: Buffer) =>
      new Promise<void>((resolve, reject) => out.write(chunk, (error) => (error ? reject(error) : resolve())))
    const central: Buffer[] = []
    let offset = 0
    for (const entry of entries) {
      const data = await fs.readFile(entry.file)
      const packed = zlib.deflateRawSync(data, { level: 9 })
      const name = Buffer.from(`${base}/${entry.name}`)
      const crc = zlib.crc32(data)
      const { time, day } = dos(entry.mtime)
      // flag bit 11: file names are UTF-8
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x0800, 6)
      local.writeUInt16LE(8, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(day, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(packed.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(name.length, 26)
      await write(Buffer.concat([local, name, packed]))
      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50, 0)
      record.writeUInt16LE(20, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt16LE(0x0800, 8)
      record.writeUInt16LE(8, 10)
      record.writeUInt16LE(time, 12)
      record.writeUInt16LE(day, 14)
      record.writeUInt32LE(crc, 16)
      record.writeUInt32LE(packed.length, 20)
      record.writeUInt32LE(data.length, 24)
      record.writeUInt16LE(name.length, 28)
      record.writeUInt32LE(offset, 42)
      central.push(record, name)
      offset += local.length + name.length + packed.length
    }
    const directory = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(offset, 16)
    await write(Buffer.concat([directory, end]))
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())))
  }
}
