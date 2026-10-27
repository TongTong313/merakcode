import type { CollaborationGroupSummary } from "@merakcode/sdk/client"
import { locale } from "../../i18n"
import type { Product, Seat } from "./members"

/**
 * A new group's name and members taken from an existing group: who they are and what they do, nothing of what they
 * did. A member whose product is turned off, does not run or is not defined here is left out and named in skipped.
 */
export function copyGroup(group: CollaborationGroupSummary, products: readonly Product[]) {
  const found = (id: string) => products.find((item) => item.id === id)
  const seated = (seat: CollaborationGroupSummary["seats"][number]) => {
    const product = found(seat.product)
    return seat.leader || (!!product?.enabled && product.connected)
  }
  const seats: Seat[] = group.seats
    .filter(seated)
    .map((seat, index) => ({ ...seat, id: `copy-${index}`, availability: { state: "online" } }))
  const skipped = group.seats
    .filter((seat) => !seated(seat))
    .map((seat) => {
      const title = found(seat.product)?.title ?? seat.product
      return locale() === "zh" ? `${seat.name}（${title}）` : `${seat.name} (${title})`
    })
  return { title: group.title, seats, skipped }
}
