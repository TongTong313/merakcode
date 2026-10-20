import { render } from "solid-js/web"
import "./styles/tokens.css"
import "./styles/base.css"
import "./styles/app.css"
import "./styles/panels.css"
import { App } from "./app"
import { log } from "./lib/bridge"
import { setLocale, locale } from "./i18n"

setLocale(locale())
window.addEventListener("error", (event) => log("error", "window error", { message: event.message }))
window.addEventListener("unhandledrejection", (event) =>
  log("error", "unhandled rejection", { reason: String(event.reason) }),
)

render(() => <App />, document.getElementById("root")!)
