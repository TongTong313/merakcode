export class StoreError extends Error {
  constructor(readonly kind: "sequence" | "conflict" | "not-found") {
    super(`store: ${kind}`)
  }
}
