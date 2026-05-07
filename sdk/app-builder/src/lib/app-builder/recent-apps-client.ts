import {
  sanitizeRecentApp,
  sortRecentApps,
  type RecentApp,
  type RecentAppPatch,
  type UpsertRecentAppInput,
} from "./recent-apps-model"

export async function refreshRecentApps() {
  const response = await fetch("/api/recent-apps")
  const data = (await response.json().catch(() => ({}))) as { apps?: unknown }

  if (!response.ok || !Array.isArray(data.apps)) {
    throw new Error("Failed to load recent apps.")
  }

  return sortRecentApps(data.apps.map(sanitizeRecentApp).filter(isRecentApp))
}

export async function saveRecentApp(input: UpsertRecentAppInput) {
  const response = await fetch("/api/recent-apps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const data = (await response.json().catch(() => ({}))) as { app?: unknown }

  if (!response.ok) {
    throw new Error("Failed to save recent app.")
  }

  return readRecentAppResponse(data.app)
}

export async function updateRecentApp(
  recentAppId: string,
  patch: RecentAppPatch
) {
  const response = await fetch(
    `/api/recent-apps/${encodeURIComponent(recentAppId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  )
  const data = (await response.json().catch(() => ({}))) as { app?: unknown }

  if (!response.ok) {
    throw new Error("Failed to update recent app.")
  }

  return readRecentAppResponse(data.app)
}

export async function removeRecentApp(recentAppId: string) {
  const response = await fetch(
    `/api/recent-apps/${encodeURIComponent(recentAppId)}`,
    { method: "DELETE" }
  )

  if (!response.ok && response.status !== 404) {
    throw new Error("Failed to remove recent app.")
  }
}

function readRecentAppResponse(value: unknown) {
  const app = sanitizeRecentApp(value)
  if (!app) {
    throw new Error("The recent app response was invalid.")
  }

  return app
}

function isRecentApp(value: RecentApp | null): value is RecentApp {
  return value !== null
}
