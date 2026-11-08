import Paperclip from "lucide-solid/icons/paperclip"
import { createResource, createSignal, Show } from "solid-js"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { Dialog } from "../../ui/dialog"
import { filePath } from "./suggest"

type AttachmentPart = { mime: string; filename?: string; url: string }

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico"])

function filename(part: AttachmentPart) {
  if (part.filename) return part.filename
  const path = filePath(part.url)
  return path ? (path.split(/[\\/]/).pop() ?? "") : ""
}

function extension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? ""
}

function isImage(part: AttachmentPart) {
  return (
    part.mime.startsWith("image/") ||
    part.url.startsWith("data:image/") ||
    IMAGE_EXTENSIONS.has(extension(filename(part)))
  )
}

function directSource(url: string) {
  if (url.startsWith("data:") || url.startsWith("blob:")) return url
}

/** An image attachment's preview and filename, or the paperclip every other file keeps */
export function AttachmentPreview(props: { part: AttachmentPart; directory: string }) {
  const [open, setOpen] = createSignal(false)
  const [broken, setBroken] = createSignal(false)
  const name = () => filename(props.part) || t("prompt.image")
  const [local] = createResource(
    () =>
      isImage(props.part) && filePath(props.part.url)
        ? { path: filePath(props.part.url)!, directory: props.directory }
        : undefined,
    async (params) => {
      try {
        const file = await (await client()).file.read(params)
        if (file.type === "binary" && file.mime?.startsWith("image/")) return `data:${file.mime};base64,${file.content}`
      } catch {
        return undefined
      }
    },
  )
  const source = () => (isImage(props.part) ? (directSource(props.part.url) ?? local()) : undefined)
  return (
    <>
      <Show
        when={!broken() ? source() : undefined}
        fallback={
          <>
            <Paperclip class="icon icon-xs" />
            <span class="ellipsis">{name()}</span>
          </>
        }
      >
        {(url) => (
          <button
            type="button"
            class="attachment-open"
            aria-label={t("prompt.viewImage", { name: name() })}
            onClick={() => setOpen(true)}
          >
            <img class="attachment-thumb" src={url()} alt="" draggable={false} onError={() => setBroken(true)} />
            <span class="ellipsis">{name()}</span>
          </button>
        )}
      </Show>
      <Show when={open()}>
        <Dialog
          open
          onOpenChange={(next) => !next && setOpen(false)}
          title={name()}
          hideTitle
          class="image-viewer"
          footer={
            <button class="button secondary" onClick={() => setOpen(false)}>
              {t("common.close")}
            </button>
          }
        >
          <div class="dialog-body image-viewer-body">
            <img src={source() ?? ""} alt={name()} />
          </div>
        </Dialog>
      </Show>
    </>
  )
}
