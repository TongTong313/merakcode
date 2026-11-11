import { EngineEventSchema, type ProtocolRemoteConnection, type ProtocolRemoteMember } from "@merakcode/sdk"
import { createResource, createSignal, For, Show } from "solid-js"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { localHuman } from "../../state/groups"
import { toast } from "../../ui/toast"

export function RemoteMembers(props: { group: string; onAdded: () => void }) {
  const [projectRemote] = createResource(
    () => props.group,
    async (group) => {
      const facts = await (await client()).events.find({ scope: { group }, types: ["group.created"] })
      const fact = facts?.[0] && EngineEventSchema.parse(facts[0])
      return fact?.type === "group.created" ? fact.payload.group.project.remote : undefined
    },
  )
  const [endpoint, setEndpoint] = createSignal("")
  const [token, setToken] = createSignal("")
  const [remote, setRemote] = createSignal<ProtocolRemoteConnection>()
  const [busy, setBusy] = createSignal(false)
  const [added, setAdded] = createSignal<string[]>([])
  const fail = (error: unknown) => toast({ kind: "error", title: t("error.request", { message: "MRK-1001" }), error })
  const connect = async () => {
    setBusy(true)
    try {
      setRemote(await (await client()).remote.connect({ endpoint: endpoint().trim(), token: token() }))
      setToken("")
      setAdded([])
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const add = async (source: ProtocolRemoteMember) => {
    const selected = remote()
    if (!selected) return
    setBusy(true)
    try {
      const connection = await client()
      const profile = await connection.agent.save({
        agent: {
          id: "",
          name: source.member.name,
          summary: source.member.summary ?? "",
          duties: "",
          role: "worker",
          shared: true,
          model: { provider: "", model: "" },
          toolPool: "worker.default",
          product: {
            kind: "remote",
            binary: "",
            remote: {
              connection: selected.id,
              group: source.member.group,
              member: source.member.id,
              caps: source.caps,
            },
          },
        },
      })
      await connection.group.addMember({
        group: props.group,
        member: {
          id: "",
          group: props.group,
          kind: "agent",
          name: profile.name,
          agentRole: "worker",
          owner: localHuman,
          agent: profile.id,
          status: source.member.status,
        },
      })
      setAdded((ids) => [...ids, source.member.id])
      props.onAdded()
      toast({ kind: "success", title: t("group.joined", { names: source.member.name }) })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="card form">
      <h3>{t("remote.title")}</h3>
      <label class="field">
        <span>{t("remote.endpoint")}</span>
        <input
          class="input"
          aria-label={t("remote.endpoint")}
          value={endpoint()}
          disabled={busy()}
          placeholder="ws://192.168.1.10:8788/rpc"
          onInput={(event) => setEndpoint(event.currentTarget.value)}
        />
      </label>
      <label class="field">
        <span>{t("remote.token")}</span>
        <input
          class="input"
          type="password"
          autocomplete="off"
          aria-label={t("remote.token")}
          value={token()}
          disabled={busy()}
          onInput={(event) => setToken(event.currentTarget.value)}
        />
      </label>
      <button
        class="button secondary"
        disabled={busy() || !endpoint().trim() || !token()}
        onClick={() => void connect()}
      >
        {t("remote.connect")}
      </button>
      <Show when={remote()}>
        {(connection) => (
          <>
            <p class="subtle">{connection().endpoint}</p>
            <For each={connection().members ?? []}>
              {(source) => (
                <div class="remote-member">
                  <div>
                    <strong>{source.member.name}</strong>
                    <p class="subtle">{source.member.summary}</p>
                    <Show when={!projectRemote() || !source.member.checkouts?.[projectRemote()!]}>
                      <span class="subtle">{t("remote.researchOnly")}</span>
                    </Show>
                  </div>
                  <button
                    class="button secondary sm"
                    aria-label={t("remote.add", { name: source.member.name })}
                    disabled={busy() || added().includes(source.member.id)}
                    onClick={() => void add(source)}
                  >
                    {added().includes(source.member.id) ? t("remote.added") : t("common.add")}
                  </button>
                </div>
              )}
            </For>
            <Show when={!connection().members?.length}>
              <p role="status">{t("remote.empty")}</p>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
