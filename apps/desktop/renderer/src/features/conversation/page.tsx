import ArrowLeft from "lucide-solid/icons/arrow-left"
import { createEffect, createSignal, on, onMount, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { t } from "../../i18n"
import { sessionPath } from "../../lib/route"
import { agents, agentsLoaded, loadAgents } from "../../state/agents"
import { choice } from "../../state/models"
import {
  decline,
  driverOf,
  forgetDecline,
  hasDeclined,
  loadDriver,
  takeOver,
  unusable,
  wasTakenOver,
} from "../../state/external"
import { busy, ensureSession, pending, session, state } from "../../state/store"
import { toast } from "../../ui/toast"
import { Frame } from "../shell/frame"
import { openReview } from "../review/state"
import { Composer } from "./composer"
import { Approval, Question } from "./dock"
import { Messages } from "./messages"
import { RevertBar } from "./revert-bar"
import { send, stop } from "./send"
import { ContextBudget } from "./context-budget"
import { TakeoverDialog } from "./takeover-dialog"

export function Conversation(props: { id: string; directory: string }) {
  const navigate = useNavigate()
  const info = () => session(props.id)
  const requests = () => pending(props.id)
  const exhausted = () => state.views[props.id]?.error === "MRK-4005"
  const [extendBudget, setExtendBudget] = createSignal(false)
  const [takeoverOpen, setTakeoverOpen] = createSignal(false)
  const driver = () => driverOf(props.id)
  const external = () => !!driver()
  const product = () => agents().find((agent) => agent.id === driver())
  /** The product of this conversation is turned off or gone: the input stays locked until it is usable again */
  const blocked = () => external() && agentsLoaded() && unusable(product())
  onMount(() => void loadAgents().catch(() => undefined))
  createEffect(
    on(
      () => props.id,
      (id) => void loadDriver(id).catch(() => undefined),
    ),
  )
  createEffect(() => {
    const agent = driver()
    if (!agent || !agentsLoaded()) return
    if (!blocked()) void forgetDecline(props.id)
    setTakeoverOpen(blocked() && !hasDeclined(props.id, agent))
  })
  const decide = async (decision: "accept" | "decline") => {
    const agent = driver()
    if (!agent) return
    if (decision === "decline") {
      await decline(props.id, agent)
      setTakeoverOpen(false)
      return
    }
    const picked = choice(props.id, props.directory)
    await takeOver(
      props.id,
      picked.model && { provider: picked.model.providerID, model: picked.model.modelID, thinking: picked.variant },
    )
    setTakeoverOpen(false)
  }
  createEffect(
    on(
      () => [props.id, exhausted()],
      () => setExtendBudget(false),
    ),
  )
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
              <RevertBar sessionID={props.id} />
              <Show when={state.views[props.id]?.budget}>{(report) => <ContextBudget report={report()} />}</Show>
              <Show when={exhausted()}>
                <label class="row">
                  <input
                    type="checkbox"
                    aria-label={t("conversation.extendBudget")}
                    checked={extendBudget()}
                    onChange={(event) => setExtendBudget(event.currentTarget.checked)}
                  />
                  {t("conversation.extendBudget")}
                </label>
              </Show>
              <Show when={requests().permissions[0]} keyed>
                {(request) => <Approval request={request} more={requests().permissions.length - 1} />}
              </Show>
              <Show when={!requests().permissions.length && requests().questions[0]} keyed>
                {(request) => <Question request={request} />}
              </Show>
              <Show when={external() || wasTakenOver(props.id)}>
                <div class="conversation-target-status subtle" role="status">
                  <span>
                    {external()
                      ? [product()?.name ?? driver(), info()?.config.model].filter(Boolean).join(" · ")
                      : "MerakCode"}
                  </span>
                  <Show when={blocked()}>
                    <span>{t("conversation.takeover.blocked")}</span>
                    <button class="button ghost sm" onClick={() => setTakeoverOpen(true)}>
                      {t("conversation.takeover.accept")}
                    </button>
                  </Show>
                  <Show when={wasTakenOver(props.id) && !external()}>
                    <span>{t("conversation.takeover.completed")}</span>
                  </Show>
                </div>
              </Show>
              <Composer
                sessionID={props.id}
                directory={props.directory}
                busy={busy(props.id)}
                external={external()}
                disabled={!state.connected || !!info()?.parentID || blocked() || (exhausted() && !extendBudget())}
                compact
                autofocus
                onSubmit={(submission) => send(props.id, props.directory, submission, extendBudget())}
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
      <Show when={blocked() && takeoverOpen()}>
        <TakeoverDialog open={takeoverOpen()} productTitle={product()?.name ?? driver() ?? ""} onDecision={decide} />
      </Show>
    </Frame>
  )
}
