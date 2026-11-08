import { builtinEnvironments, type Environment } from "vitest/runtime"

/** DOM rendering with Node's real WebSocket, so protocol tests reach the Go engine. */
const environment: Environment = {
  name: "merak-dom",
  viteEnvironment: "client",
  async setup(global, options) {
    const socket = global.WebSocket
    const NativeEvent = global.Event
    const dom = await builtinEnvironments["happy-dom"].setup(global, options)
    // Undici dispatches through Node's EventTarget but reads the DOM's global Event.
    global.WebSocket = class extends socket {
      dispatchEvent(event: Event) {
        if (event instanceof NativeEvent) return super.dispatchEvent(event)
        const native = new NativeEvent(event.type)
        for (const key of ["data", "error", "message", "code", "reason", "wasClean"])
          if (key in event) Object.defineProperty(native, key, { value: Reflect.get(event, key) })
        return super.dispatchEvent(native)
      }
    }
    return dom
  },
}
export default environment
