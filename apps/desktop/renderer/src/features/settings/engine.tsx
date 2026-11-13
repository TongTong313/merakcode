import { createResource, createSignal } from "solid-js"
import { t } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { Switch } from "../../ui/switch"
import { toast } from "../../ui/toast"
import { Row, Section } from "./layout"

/** The engine keeps running after the window closes; here the person decides whether it also starts at login */
export function EngineSettings() {
  const [saved, { mutate }] = createResource(async () => (await bridge?.getLoginItem().catch(() => false)) ?? false)
  const [busy, setBusy] = createSignal(false)
  const change = async (enabled: boolean) => {
    if (!bridge || busy()) return
    setBusy(true)
    try {
      mutate(await bridge.setLoginItem(enabled))
    } catch (error) {
      toast({ kind: "error", title: t("settings.engine.login.failed"), error })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title={t("settings.engine")} lead={t("settings.engine.lead")}>
      <div class="card">
        <Row label={t("settings.engine.login")} desc={t("settings.engine.login.desc")}>
          <Switch
            label={t("settings.engine.login")}
            hideLabel
            checked={saved() ?? false}
            disabled={!bridge || saved.loading || busy()}
            onChange={(enabled) => void change(enabled)}
          />
        </Row>
      </div>
    </Section>
  )
}
