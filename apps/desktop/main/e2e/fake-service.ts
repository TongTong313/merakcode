import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

/**
 * A stand-in for the engine's `service` command: it appends its arguments to <program>.log and, while <program>.fail
 * exists, prints a failure code and exits with 1. Tests give it to the desktop so no real login item is ever written.
 */
const source = `package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	program, _ := os.Executable()
	log, err := os.OpenFile(program+".log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		fmt.Fprintln(log, strings.Join(os.Args[1:], " "))
		log.Close()
	}
	if _, err := os.Stat(program + ".fail"); err == nil {
		fmt.Println("MRK-5014")
		os.Exit(1)
	}
}
`

/** Builds the fake program as <directory>/<name> and returns its path */
export async function buildFakeService(directory: string, name = "merak") {
  const work = await mkdtemp(path.join(os.tmpdir(), "merak-fake-service-"))
  try {
    await writeFile(path.join(work, "main.go"), source)
    await mkdir(directory, { recursive: true })
    const program = path.join(directory, process.platform === "win32" ? `${name}.exe` : name)
    await promisify(execFile)("go", ["build", "-o", program, "main.go"], { cwd: work, windowsHide: true })
    return program
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** The arguments of every run of the fake program, one entry per run */
export async function runsOf(program: string) {
  const text = await readFile(`${program}.log`, "utf8").catch(() => "")
  return text.split(/\r?\n/).filter(Boolean)
}

/** Makes the next runs of the fake program fail */
export const failing = (program: string) => writeFile(`${program}.fail`, "")
