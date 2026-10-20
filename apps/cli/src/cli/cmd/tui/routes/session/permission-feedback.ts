export function isFeedbackSubmit(event: { name: string; shift?: boolean }) {
  return (event.name === "return" || event.name === "enter") && !event.shift
}
