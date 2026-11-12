import { t } from "../../i18n"
import { state, updateConfig } from "../../state/store"
import { Segmented } from "../../ui/segmented"
import { toast } from "../../ui/toast"
import { Row, Section } from "./layout"

const choices = [1, 3, 7, 14, 0]

/** How long a finished task stays on the board; the background engine archives it after that. */
export function BoardSettings() {
  const days = () => state.config?.board.autoArchiveDays ?? 3
  return (
    <Section title={t("settings.board")} lead={t("settings.board.desc")}>
      <div class="card">
        <Row label={t("settings.board.autoArchive")} desc={t("settings.board.autoArchive.desc")}>
          <Segmented
            label={t("settings.board.autoArchive")}
            value={String(days())}
            onChange={(value) =>
              void updateConfig({ board: { autoArchiveDays: Number(value) } }).catch((error) =>
                toast({ kind: "error", title: t("error.request", { message: "MRK-3001" }), error }),
              )
            }
            options={choices.map((value) => ({
              value: String(value),
              label: value ? t("settings.board.days", { days: value }) : t("settings.board.off"),
            }))}
          />
        </Row>
      </div>
    </Section>
  )
}
