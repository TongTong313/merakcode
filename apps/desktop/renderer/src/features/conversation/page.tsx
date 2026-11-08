import ArrowLeft from "lucide-solid/icons/arrow-left"
import { createEffect, on, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { t } from "../../i18n"
import { sessionPath } from "../../lib/route"
import { busy, ensureSession, pending, session, state } from "../../state/store"
import { toast } from "../../ui/toast"
import { Frame } from "../shell/frame"
import { openReview } from "../review/state"
import { Composer } from "./composer"
import { Approval, Question } from "./dock"
import { Messages } from "./messages"
import { send, stop } from "./send"

export function Conversation(props: { id: string; directory: string }) {
  const navigate = useNavigate()
  const info = () => session(props.id)
  const requests = () => pending(props.id)
  createEffect(
    on(
      () => props.id,
      (id) => {
        void ensureSession(id).catch((error) => toast({ kind: "error", title: t("conversation.notFound"), error }))
      },
    ),
  )
  return (
    <Frame
      sessionID={props.id}
      directory={info()?.directory ?? props.directory}
      folder={props.directory}
      title={
        <>
          <Show when={info()?.parentID}>
            {(parent) => (
              <button class="button ghost sm no-drag" onClick={() => navigate(sessionPath(props.directory, parent()))}>
                <ArrowLeft class="icon icon-xs" />
                {t("conversation.backToParent")}
              </button>
            )}
          </Show>
          <span class="title ellipsis">{info()?.title || t("sidebar.untitled")}</span>
        </>
      }
    >
      <div class="chat-area">
        <div class="chat-main">
          <Messages
            sessionID={props.id}
            directory={info()?.directory ?? props.directory}
            onReviewFile={(file) => openReview({ file })}
            onReview={() => openReview()}
          />
          <div class="dock">
            <div class="dock-inner">
              <Show when={requests().permissions[0]} keyed>
                {(request) => <Approval request={request} more={requests().permissions.length - 1} />}
              </Show>
              <Show when={!requests().permissions.length && requests().questions[0]} keyed>
                {(request) => <Question request={request} />}
              </Show>
              <Composer
                sessionID={props.id}
                directory={props.directory}
                busy={busy(props.id)}
                disabled={!state.connected || !!info()?.parentID}
                compact
                autofocus
                onSubmit={(submission) => send(props.id, props.directory, submission)}
                onStop={() =>
                  void stop(props.id).catch((error) =>
                    toast({ kind: "error", title: t("error.request", { message: error.message }), error }),
                  )
                }
              />
            </div>
          </div>
        </div>
      </div>
    </Frame>
  )
}
