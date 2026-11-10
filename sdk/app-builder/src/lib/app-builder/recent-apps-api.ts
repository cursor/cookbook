import type {
  RecentAppPatch,
  UpsertRecentAppInput,
} from "./recent-apps-model"

type ParsedRequest<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

type RecentAppsRequest = {
  id?: unknown
  title?: unknown
  touch?: unknown
}

type RecentAppPatchRequest = {
  favorite?: unknown
  title?: unknown
}

export function parseRecentAppsRequest(
  body: unknown
): ParsedRequest<UpsertRecentAppInput> {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "A recent app id is required." }
  }

  const request = body as RecentAppsRequest
  const id = typeof request.id === "string" ? request.id.trim() : ""

  if (!id) {
    return { ok: false, error: "A recent app id is required." }
  }

  return {
    ok: true,
    value: {
      id,
      title: typeof request.title === "string" ? request.title : undefined,
      touch: request.touch === false ? false : undefined,
    },
  }
}

export function parseRecentAppPatchRequest(
  recentAppId: string,
  body: unknown
): ParsedRequest<{ id: string; patch: RecentAppPatch }> {
  const id = recentAppId.trim()
  if (!body || typeof body !== "object") {
    return { ok: false, error: "A favorite or title update is required." }
  }

  const request = body as RecentAppPatchRequest
  const patch = {
    favorite:
      typeof request.favorite === "boolean" ? request.favorite : undefined,
    title: typeof request.title === "string" ? request.title : undefined,
  }

  if (!id || (patch.favorite === undefined && patch.title === undefined)) {
    return { ok: false, error: "A favorite or title update is required." }
  }

  return { ok: true, value: { id, patch } }
}
