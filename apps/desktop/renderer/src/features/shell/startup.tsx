import { Show, type JSX, type Resource } from "solid-js"
import { t } from "../../i18n"

/**
 * Covers the app until startup has loaded the config and the projects; if that fails, says so and offers a retry.
 * Conditions read the resource's state: reading a failed resource throws, which left only the logo on screen.
 */
export function Startup(props: { ready: Resource<boolean>; onRetry: () => void; children: JSX.Element }) {
  return (
    <Show
      when={props.ready.state === "ready"}
      fallback={
        <div class="splash">
          <Show when={props.ready.state === "errored"} fallback={<img src="/logo.svg" alt="" class="splash-logo" />}>
            <div class="error-card" role="alert">
              <span>{t("error.offline")}</span>
              <button class="button secondary sm" onClick={() => props.onRetry()}>
                {t("error.retry")}
              </button>
            </div>
          </Show>
        </div>
      }
    >
      {props.children}
    </Show>
  )
}
