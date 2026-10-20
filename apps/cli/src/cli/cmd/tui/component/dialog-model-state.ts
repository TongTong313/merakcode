export interface ModelRef {
  providerID: string
  modelID: string
}

export function modelSections(showSections: boolean, favorites: ModelRef[], recents: ModelRef[], model: ModelRef) {
  const favorite = favorites.some((item) => item.providerID === model.providerID && item.modelID === model.modelID)
  const recent = recents.some((item) => item.providerID === model.providerID && item.modelID === model.modelID)
  return {
    recent: showSections && recent && !favorite,
    provider: !showSections || !favorite,
  }
}
