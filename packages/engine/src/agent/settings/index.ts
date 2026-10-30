import { ConfigUpdated } from "../../infra/config/event"
import { CoreConfig } from "./schema"
import { InvalidError as InvalidConfigError } from "../../infra/config/error"
import * as PluginSpecifier from "../plugin/specifier"

export namespace Config {
  export type Info = CoreConfig.Info
  export const Mcp = CoreConfig.Mcp
  export type Mcp = CoreConfig.Mcp
  export const AgentConnectionProduct = CoreConfig.AgentConnectionProduct
  export type AgentConnectionProduct = CoreConfig.AgentConnectionProduct
  export const Permission = CoreConfig.Permission
  export type Permission = CoreConfig.Permission
  export const PermissionAction = CoreConfig.PermissionAction
  export type PermissionAction = CoreConfig.PermissionAction
  export const InvalidError = InvalidConfigError
  export const UpdatedEvent = ConfigUpdated
  export const getPluginName = PluginSpecifier.getPluginName
  export const pluginSpecifier = PluginSpecifier.pluginSpecifier
  export const deduplicatePlugins = PluginSpecifier.deduplicatePlugins
  type Runtime = {
    get(): Promise<Info>
    getGlobal(): Promise<Info>
    global(): Promise<Info>
    directories(): Promise<string[]>
    waitForDependencies(): Promise<void>
    loadGlobalMerakCodeFile(): Promise<Info>
    loadProjectMerakCodeFile(): Promise<Info>
    updateGlobal(config: Info, options?: { skipDispose?: boolean }): Promise<Info>
    updateProjectMerakCode(config: Info, options?: { skipDispose?: boolean }): Promise<Info>
    deleteMcpServer(name: string, scope: "project" | "global"): Promise<void>
    edit(scope: "project" | "global", edit: (text: string) => string): Promise<void>
  }
  let runtime: Runtime | undefined
  /** Binds the application loader; schemas and caches stay in the application implementation. */
  export function use(adapter: Runtime) {
    runtime = adapter
  }
  function current() {
    if (!runtime) throw new Error("Engine configuration is not initialized")
    return runtime
  }
  export const get = async (...args: Parameters<Runtime["get"]>) => current().get(...args)
  export const getGlobal = async (...args: Parameters<Runtime["getGlobal"]>) => current().getGlobal(...args)
  export const global = async (...args: Parameters<Runtime["global"]>) => current().global(...args)
  export const directories = async (...args: Parameters<Runtime["directories"]>) => current().directories(...args)
  export const waitForDependencies = async (...args: Parameters<Runtime["waitForDependencies"]>) =>
    current().waitForDependencies(...args)
  export const loadGlobalMerakCodeFile = async (...args: Parameters<Runtime["loadGlobalMerakCodeFile"]>) =>
    current().loadGlobalMerakCodeFile(...args)
  export const loadProjectMerakCodeFile = async (...args: Parameters<Runtime["loadProjectMerakCodeFile"]>) =>
    current().loadProjectMerakCodeFile(...args)
  export const updateGlobal = async (...args: Parameters<Runtime["updateGlobal"]>) => current().updateGlobal(...args)
  export const updateProjectMerakCode = async (...args: Parameters<Runtime["updateProjectMerakCode"]>) =>
    current().updateProjectMerakCode(...args)
  export const deleteMcpServer = async (...args: Parameters<Runtime["deleteMcpServer"]>) =>
    current().deleteMcpServer(...args)
  export const edit = async (...args: Parameters<Runtime["edit"]>) => current().edit(...args)
}
