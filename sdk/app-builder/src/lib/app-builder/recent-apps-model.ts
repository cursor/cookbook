export type RecentApp = {
  id: string
  title: string
  favorite: boolean
  createdAt: number
  updatedAt: number
}

export type PersistedRecentApps = {
  apps: RecentApp[]
}

export type UpsertRecentAppInput = {
  id: string
  title?: string
  touch?: boolean
}

export type RecentAppPatch = {
  favorite?: boolean
  title?: string
}

export const DEFAULT_RECENT_APP_TITLE = "Untitled App"

export function sanitizeRecentApp(value: unknown): RecentApp | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const app = value as Record<string, unknown>
  if (
    typeof app.id !== "string" ||
    typeof app.title !== "string" ||
    !isTimestampLike(app.createdAt) ||
    !isTimestampLike(app.updatedAt)
  ) {
    return null
  }

  const id = app.id.trim()
  const title = normalizeRecentAppTitle(app.title)

  if (!id || !title) {
    return null
  }

  return {
    id,
    title,
    favorite: app.favorite === true,
    createdAt: normalizeTimestamp(app.createdAt),
    updatedAt: normalizeTimestamp(app.updatedAt),
  }
}

export function sortRecentApps(apps: RecentApp[]) {
  return [...apps].sort((a, b) => {
    if (a.favorite !== b.favorite) {
      return a.favorite ? -1 : 1
    }

    return getTime(b.updatedAt) - getTime(a.updatedAt)
  })
}

export function normalizeRecentAppTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim()
  return normalized || null
}

function isTimestampLike(value: unknown): value is number | string {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && Number.isFinite(new Date(value).getTime()))
  )
}

function normalizeTimestamp(value: number | string) {
  if (typeof value === "number") {
    return value
  }

  return new Date(value).getTime()
}

function getTime(value: number) {
  return Number.isFinite(value) ? value : 0
}
