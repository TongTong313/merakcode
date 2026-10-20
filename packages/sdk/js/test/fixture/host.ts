/**
 * Child process acting as an SDK host: starts an engine, prints the engine PID to stdout, then stays alive until the
 * test kills it.
 * Usage: node host.ts <project directory> <environment JSON>
 */
import { createMerakCode } from "@merakcode/sdk"
import { engine } from "./engine"

const [cwd, env] = process.argv.slice(2)
const merak = await createMerakCode({ cwd, executablePath: engine, env: JSON.parse(env!) })
console.log(`ENGINE_PID=${merak.pid}`)
setInterval(() => {}, 1000)
