import type { AgentConnectionProduct, CollaborationRoleTemplate, CollaborationSeat, Part } from "@merakcode/sdk/client"
import Plus from "lucide-solid/icons/plus"
import X from "lucide-solid/icons/x"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { t } from "../../i18n"
import { setUi } from "../../state/ui"
import { Select } from "../../ui/select"

export type Seat = CollaborationSeat
export type Product = AgentConnectionProduct
export type SeatDraft = { name: string; role: string; duty: string; product: string }

/** A member's avatar, tinted by its id, so a renamed member keeps its color */
export function Avatar(props: { id: string; name: string }) {
  return (
    <span class="avatar" style={{ "--hue": String(tint(props.id)) }} aria-hidden="true">
      {initials(props.name)}
    </span>
  )
}

/** Chinese names show their last two characters (two names that share a first character stay apart), others their first letter */
function initials(name: string) {
  const chars = [...name]
  if (/\p{Script=Han}/u.test(name)) return chars.slice(-2).join("")
  return (chars[0] ?? "").toUpperCase()
}

/** Hue from an id; the golden angle keeps members added one after another far apart */
function tint(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return Math.round((hash * 137.508) % 360)
}

function productTitle(product: string, products: readonly Product[]) {
  // The leader is always MerakCode, known before the product list arrives
  if (product === "merak") return "MerakCode"
  return products.find((item) => item.id === product)?.title ?? product
}

/** Second line under a member's name: product and, when set, role */
export function seatMeta(seat: { product: string; role?: string }, products: readonly Product[]) {
  return [productTitle(seat.product, products), seat.role].filter(Boolean).join(" · ")
}

export function seatOffline(
  seat: Pick<Seat, "product"> & Partial<Pick<Seat, "leader" | "availability">>,
  products: readonly Product[],
) {
  if (seat.leader || seat.product === "merak") return false
  if (seat.availability) return seat.availability.state === "offline"
  if (!products.length) return false
  const product = products.find((item) => item.id === seat.product)
  return !product || !product.enabled || !product.connected
}

/**
 * Who a permission request or question comes from, when it comes from a member at work: its name, product and role,
 * found from the delegate call that carries it. The leader's own requests carry their own calls and name no one.
 */
export function askedBy(
  callID: string | undefined,
  parts: readonly Part[],
  seats: readonly Seat[],
  products: readonly Product[],
) {
  if (!callID) return undefined
  const call = parts.find((part) => part.type === "tool" && part.tool === "delegate" && part.callID === callID)
  if (call?.type !== "tool") return undefined
  const state = call.state as { input?: { seat?: string }; metadata?: { seatID?: string } }
  const seat =
    seats.find((item) => item.id === state.metadata?.seatID) ?? seats.find((item) => item.name === state.input?.seat)
  const name = state.input?.seat ?? seat?.name
  if (!name) return undefined
  return [name, seat ? seatMeta(seat, products) : undefined].filter(Boolean).join(" · ")
}

/** @ suggestions in a group: members by name. Adding a member stays on the plus button beside the member list. */
export function mentionChoices(
  query: string,
  seats: readonly { name: string; product: string; role?: string }[],
  products: readonly Product[],
): { name: string; detail: string }[] {
  const needle = query.trim().toLowerCase()
  return seats
    .filter((seat) => !seatOffline(seat, products))
    .filter((seat) => !needle || seat.name.toLowerCase().includes(needle))
    .map((seat) => ({ name: seat.name, detail: seatMeta(seat, products) }))
}

/** Why a name cannot be used, or undefined when it can */
function nameProblem(name: string, taken: readonly string[]) {
  const value = name.trim()
  if (!value) return t("group.nameEmpty")
  if (/[\s@]/u.test(value)) return t("group.nameInvalid")
  if (taken.includes(value)) return t("group.nameTaken")
}

/** The version found, and whether it is older than the adapter recommends; an older CLI is still offered */
function versionNote(product: Product) {
  return [product.version, product.outdated ? t("group.outdated") : undefined].filter(Boolean).join(" · ") || undefined
}

/** Name, role and duty of a member; a new member also picks its product */
function MemberForm(props: {
  seat?: Seat
  products: readonly Product[]
  roleTemplates?: readonly CollaborationRoleTemplate[]
  taken: readonly string[]
  onSubmit: (draft: SeatDraft) => void
  onRemove?: () => void
  onCancel?: () => void
}) {
  // A product turned off in settings is not offered; one that does not run is, so its absence is not a mystery
  const offered = () => props.products.filter((item) => item.enabled)
  const firstConnected = () =>
    offered().find((item) => item.connected && item.id !== "merak")?.id ?? offered().find((item) => item.connected)?.id
  const [product, setProduct] = createSignal(props.seat?.product ?? firstConnected() ?? "")
  const [name, setName] = createSignal(props.seat?.name ?? "")
  const [role, setRole] = createSignal(props.seat?.role ?? "")
  const [duty, setDuty] = createSignal(props.seat?.duty ?? "")
  createEffect(on(firstConnected, (first) => !product() && first && setProduct(first)))
  const problem = () => nameProblem(name(), props.taken)
  const chosen = () => props.products.find((item) => item.id === product())
  const usable = () => !!props.seat || !!chosen()?.connected
  const submit = () => {
    if (problem() || !usable()) return
    props.onSubmit({ name: name().trim(), role: role().trim(), duty: duty().trim(), product: product() })
  }
  return (
    <form
      class="member-form"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <Show when={props.onCancel}>
        <div class="member-form-head">
          <span class="member-label">{t("group.addMember")}</span>
          <button
            type="button"
            class="icon-button sm"
            aria-label={t("group.cancelAdd")}
            title={t("group.cancelAdd")}
            onClick={() => props.onCancel?.()}
          >
            <X class="icon icon-xs" />
          </button>
        </div>
      </Show>
      <Show
        when={!props.seat}
        fallback={
          <div class="member-field">
            <span class="member-label">{t("group.product")}</span>
            <span class="muted">{productTitle(product(), props.products)}</span>
          </div>
        }
      >
        <Show when={props.roleTemplates?.length}>
          <Select
            label={t("group.roleTemplate")}
            value={undefined}
            placeholder={t("group.roleTemplatePlaceholder")}
            options={props.roleTemplates!.map((template) => ({
              value: template.id,
              label: template.name,
              description: template.description,
            }))}
            onChange={(id) => {
              const template = props.roleTemplates?.find((item) => item.id === id)
              if (!template) return
              setName(template.name)
              setRole(template.role)
              setDuty(template.duty)
            }}
          />
        </Show>
        {/* Shown once the products are in: options arriving while the list is open are not picked up */}
        <Show when={props.products.length} fallback={<p class="member-checking subtle pulse">{t("group.checking")}</p>}>
          <Select
            label={t("group.product")}
            value={product()}
            onChange={setProduct}
            options={offered().map((item) => ({
              value: item.id,
              label: item.title,
              disabled: !item.connected,
              description: item.connected ? versionNote(item) : t("group.unavailable"),
            }))}
          />
          <Show when={chosen()?.outdated && chosen()}>
            {(item) => (
              <p class="member-upgrade" role="status">
                {t("group.upgrade", {
                  version: item().version ?? "",
                  recommended: item().recommended ?? "",
                  command: item().upgrade ?? "",
                })}
              </p>
            )}
          </Show>
          <Show when={offered().some((item) => !item.connected)}>
            <button
              type="button"
              class="member-hint"
              onClick={() => setUi({ settings: "agentConnections", newTeam: false })}
            >
              {t("group.someUnavailable")}
            </button>
          </Show>
        </Show>
      </Show>
      <label class="member-field">
        <span class="member-label">{t("group.seatName")}</span>
        <input class="input" value={name()} onInput={(event) => setName(event.currentTarget.value)} />
      </label>
      <label class="member-field">
        <span class="member-label">{t("group.role")}</span>
        <input
          class="input"
          placeholder={t("group.rolePlaceholder")}
          value={role()}
          onInput={(event) => setRole(event.currentTarget.value)}
        />
      </label>
      <label class="member-field">
        <span class="member-label">{t("group.duty")}</span>
        <textarea
          class="input member-duty"
          rows={4}
          placeholder={t("group.dutyPlaceholder")}
          value={duty()}
          onInput={(event) => setDuty(event.currentTarget.value)}
        />
      </label>
      <Show when={name() && problem()}>
        <p class="member-problem" role="status">
          {problem()}
        </p>
      </Show>
      <div class="member-actions">
        <Show when={props.onRemove}>
          <button type="button" class="button ghost sm danger" onClick={() => props.onRemove?.()}>
            {t("group.remove")}
          </button>
        </Show>
        <span class="spacer" />
        <button type="submit" class="button primary sm" disabled={!!problem() || !usable()}>
          {props.seat ? t("group.save") : t("group.join")}
        </button>
      </div>
    </form>
  )
}

/**
 * Members of a group: a row per member opens its name, role and duty in place; the last row adds a member. Used by
 * the create dialog (with a local list) and by the member column (with the group record).
 */
export function MemberList(props: {
  seats: readonly Seat[]
  products: readonly Product[]
  roleTemplates?: readonly CollaborationRoleTemplate[]
  busy?: (seatID: string) => boolean
  /** Opens this member, or the add form when "new"; at lets the same request open again */
  open?: { target: string; at: number }
  onSave: (seat: Seat, draft: SeatDraft) => unknown
  onAdd: (draft: SeatDraft) => unknown
  onRemove: (seat: Seat) => void
}) {
  const [open, setOpen] = createSignal<string>()
  createEffect(
    on(
      () => props.open,
      (request) => request && setOpen(request.target),
    ),
  )
  const taken = (except?: string) => props.seats.filter((seat) => seat.id !== except).map((seat) => seat.name)
  // The caller reports a failure; the form stays open so nothing typed is lost
  const done = (action: unknown) =>
    Promise.resolve(action).then(
      () => setOpen(undefined),
      () => undefined,
    )
  return (
    <div class="member-list">
      <For each={props.seats}>
        {(seat) => (
          <div class="member" classList={{ open: open() === seat.id }}>
            <button
              class="member-row"
              aria-expanded={open() === seat.id}
              onClick={() => setOpen(open() === seat.id ? undefined : seat.id)}
            >
              <Avatar id={seat.id} name={seat.name} />
              <span class="member-text">
                <span class="member-name">
                  <span class="ellipsis">{seat.name}</span>
                  <Show when={seatOffline(seat, props.products)}>
                    <span class="badge neutral">{t("group.offline")}</span>
                  </Show>
                  <Show when={seat.leader}>
                    <span class="badge accent">{t("group.leader")}</span>
                  </Show>
                </span>
                <span class="member-meta subtle ellipsis">{seatMeta(seat, props.products)}</span>
              </span>
              <Show when={props.busy?.(seat.id)}>
                <span class="member-busy" aria-label={t("group.running")} />
              </Show>
            </button>
            <Show when={open() === seat.id}>
              <MemberForm
                seat={seat}
                products={props.products}
                taken={taken(seat.id)}
                onSubmit={(draft) => void done(props.onSave(seat, draft))}
                onRemove={seat.leader ? undefined : () => props.onRemove(seat)}
              />
            </Show>
          </div>
        )}
      </For>
      <Show
        when={open() === "new"}
        fallback={
          <button class="member-add" onClick={() => setOpen("new")}>
            <Plus class="icon icon-sm" />
            {t("group.addMember")}
          </button>
        }
      >
        <div class="member open">
          <MemberForm
            products={props.products}
            roleTemplates={props.roleTemplates}
            taken={taken()}
            onSubmit={(draft) => void done(props.onAdd(draft))}
            onCancel={() => setOpen(undefined)}
          />
        </div>
      </Show>
    </div>
  )
}
