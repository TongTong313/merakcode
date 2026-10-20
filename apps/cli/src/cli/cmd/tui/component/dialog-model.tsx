import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { useKeybind } from "../context/keybind"
import { useLocale } from "../context/locale"
import fuzzysort from "fuzzysort"
import { modelSections } from "./dialog-model-state"

export function useConnected() {
  const sync = useSync()
  return createMemo(() => sync.data.provider.some((x) => Object.keys(x.models).length > 0))
}

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const locale = useLocale()
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((x) => x.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            onSelect: () => {
              dialog.clear()
              local.model.set({ providerID: provider.id, modelID: model.id }, { recent: true, persist: true })
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, locale.t("model.favorites"))
    const recentOptions = toOptions(
      recents.filter((item) => modelSections(showSections, favorites, recents, item).recent),
      locale.t("model.recents"),
    )

    const providerOptions = pipe(
      sync.data.provider,
      sortBy((provider) => provider.name),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
              ? locale.t("model.favoriteTag")
              : undefined,
            category: connected() ? provider.name : undefined,
            onSelect() {
              dialog.clear()
              local.model.set({ providerID: provider.id, modelID: model }, { recent: true, persist: true })
            },
          })),
          filter((x) => modelSections(showSections, favorites, recents, x.value).provider),
          sortBy((x) => x.title),
        ),
      ),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: locale.t("model.popularProviders"),
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...fuzzysort
          .go(needle, providerOptions, { keys: ["title", "category"], limit: 0, threshold: 0 })
          .map((x) => x.obj),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"], limit: 0, threshold: 0 }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((x) => x.id === props.providerID) : null,
  )

  const title = createMemo(() => provider()?.name ?? locale.t("model.select"))

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      keybind={[
        {
          keybind: keybind.all.model_provider_list?.[0],
          title: connected() ? locale.t("model.connectProvider") : locale.t("model.viewAllProviders"),
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          keybind: keybind.all.model_favorite_toggle?.[0],
          title: locale.t("model.favorites"),
          disabled: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}
