import { isDeepEqual } from "remeda"

export interface DialogSelectValueOption<T> {
  value: T
}

export function findDialogSelectValueIndex<T>(options: DialogSelectValueOption<T>[], value: T | undefined) {
  if (value === undefined) return -1
  return options.findIndex((option) => isDeepEqual(option.value, value))
}

export function findDialogSelectOptionIndex<T>(
  options: DialogSelectValueOption<T>[],
  target: DialogSelectValueOption<T>,
) {
  return options.indexOf(target)
}
