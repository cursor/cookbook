export function compactText(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

export function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`
  }

  return `${(ms / 1000).toFixed(1)}s`
}
