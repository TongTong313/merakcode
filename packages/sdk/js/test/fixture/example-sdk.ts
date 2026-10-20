/**
 * What `@merakcode/sdk` resolves to inside the examples during tests: the real SDK, except that createMerakCode
 * defaults to the engine from source, because there is no platform package in the repo.
 */
import { createMerakCode as start, type MerakCodeOptions } from "../../src/index"
import { engine } from "./engine"

export * from "../../src/index"

export const createMerakCode = (options: MerakCodeOptions = {}) => start({ executablePath: engine, ...options })
