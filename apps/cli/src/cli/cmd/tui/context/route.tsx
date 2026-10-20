import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"

type HomeRoute = {
  type: "home"
  initialPrompt?: PromptInfo
}

type SessionRoute = {
  type: "session"
  sessionID: string
  initialPrompt?: PromptInfo
}

type DiffRoute = {
  type: "diff"
  mode?: "git" | "branch" | "last-turn"
  sessionID?: string
  messageID?: string
  returnRoute?: Route
}

export type Route = HomeRoute | SessionRoute | DiffRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: () => {
    const [store, setStore] = createStore<Route>(
      process.env["MERAKCODE_ROUTE"]
        ? JSON.parse(process.env["MERAKCODE_ROUTE"])
        : {
            type: "home",
          },
    )

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setStore(reconcile(route))
      },
    }
  },
})

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
