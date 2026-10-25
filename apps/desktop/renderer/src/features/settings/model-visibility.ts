export type PickerDelta = { include?: string[]; exclude?: string[] }

function without(list: string[] | undefined, id: string) {
  return (list ?? []).filter((item) => item !== id)
}

/** Turning on records include. Turning off records exclude. Either way the other list loses the id. */
export function nextPicker(
  picker: PickerDelta | undefined,
  modelID: string,
  on: boolean,
): { include: string[]; exclude: string[] } {
  const include = without(picker?.include, modelID)
  const exclude = without(picker?.exclude, modelID)
  if (on) include.push(modelID)
  else exclude.push(modelID)
  return { include, exclude }
}
