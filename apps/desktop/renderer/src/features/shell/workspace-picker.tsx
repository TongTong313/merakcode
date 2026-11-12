import FolderOpen from "lucide-solid/icons/folder-open"
import { t } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { baseName, sameDir } from "../../lib/route"
import { openFolder, state } from "../../state/store"
import { Select } from "../../ui/select"
import { toast } from "../../ui/toast"

/** The workspace of a new group or task: one of the open folders, or another folder picked from the disk. */
export function WorkspacePicker(props: {
  value: string
  onChange: (directory: string) => void
  /** The workspace is fixed, as for a group started from a task */
  disabled?: boolean
}) {
  const options = () => {
    const folders = state.folders.map((folder) => folder.directory)
    const all =
      props.value && !folders.some((folder) => sameDir(folder, props.value)) ? [props.value, ...folders] : folders
    return all.map((directory) => ({ value: directory, label: baseName(directory), description: directory }))
  }
  const pick = async () => {
    const picked = await bridge?.openDirectoryPicker({ title: t("sidebar.openProject") })
    const directory = Array.isArray(picked) ? picked[0] : picked
    if (!directory) return
    await openFolder(directory)
    props.onChange(directory)
  }
  return (
    <div class="field">
      <span>{t("workspace.label")}</span>
      <div class="row">
        <Select
          class="chip outlined"
          label={t("workspace.label")}
          value={options().find((option) => sameDir(option.value, props.value))?.value}
          options={options()}
          disabled={props.disabled}
          placeholder={t("workspace.choose")}
          onChange={props.onChange}
        />
        <button
          type="button"
          class="button ghost sm"
          disabled={props.disabled}
          onClick={() =>
            void pick().catch((error) =>
              toast({ kind: "error", title: t("error.request", { message: "MRK-5001" }), error }),
            )
          }
        >
          <FolderOpen class="icon icon-sm" />
          {t("workspace.other")}
        </button>
      </div>
    </div>
  )
}
