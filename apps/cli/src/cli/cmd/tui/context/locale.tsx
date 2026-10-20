import { createStore } from "solid-js/store"
import { createContext, createEffect, useContext, type ParentComponent } from "solid-js"
import { useSync } from "./sync"
import { useSDK } from "./sdk"
import { Log } from "@merakcode/log/logger"
import { failure } from "@merakcode/log"

import { I18n } from "../../../i18n"

type LocaleKey = I18n.Locale

type LocaleContextType = {
  current: LocaleKey
  t: (key: string, params?: Record<string, any>) => string
  switchLocale: (locale: LocaleKey) => Promise<void>
  all: () => LocaleKey[]
}

const LocaleContext = createContext<LocaleContextType>()
const log = Log.create({ source: "product", service: "tui.locale" })

export const LocaleProvider: ParentComponent = (props) => {
  const sync = useSync()
  const sdk = useSDK()

  // From config; otherwise the same as subcommands (MERAKCODE_LOCALE → global config → Chinese).
  const initialLocale = (sync.data.config.locale as LocaleKey | undefined) ?? I18n.current()

  const [store, setStore] = createStore({
    current: initialLocale as LocaleKey,
  })
  let saved = initialLocale
  let desired: LocaleKey | undefined
  let revision = 0
  let pending = Promise.resolve()

  createEffect(() => {
    const current = sync.data.config.locale
    if (current !== "zh-CN" && current !== "en-US") return
    if (desired) return
    saved = current
    setStore("current", current)
  })

  const t = (key: string, params?: Record<string, any>): string => I18n.format(store.current, key, params)

  // Modules outside the UI use I18n.t, so keep it on the UI's current language.
  createEffect(() => I18n.use(store.current))

  const switchLocale = (locale: LocaleKey) => {
    const current = ++revision
    const started = Date.now()
    desired = locale
    setStore("current", locale)
    log.info("language update started", { locale })
    const task = pending.then(async () => {
      try {
        await sdk.client.global.config.update({ config: { locale }, skipDispose: "true" }, { throwOnError: true })
        saved = locale
        if (current === revision) {
          desired = undefined
          setStore("current", locale)
        }
        log.info("language update completed", { locale, duration: Date.now() - started })
      } catch (error) {
        if (current === revision) {
          desired = undefined
          setStore("current", saved)
        }
        log.warn("language update failed", { locale, duration: Date.now() - started, ...failure(error) })
        throw error
      }
    })
    pending = task.then(
      () => {},
      () => {},
    )
    return task
  }

  const all = (): LocaleKey[] => I18n.LOCALES

  return (
    <LocaleContext.Provider
      value={{
        get current() {
          return store.current
        },
        t,
        switchLocale,
        all,
      }}
    >
      {props.children}
    </LocaleContext.Provider>
  )
}

export function useLocale() {
  const context = useContext(LocaleContext)
  if (!context) {
    throw new Error("useLocale must be used within LocaleProvider")
  }
  return context
}
