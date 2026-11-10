import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  DEFAULT_RECENT_APP_TITLE,
  normalizeRecentAppTitle,
  sanitizeRecentApp,
  sortRecentApps,
  type PersistedRecentApps,
  type RecentApp,
  type RecentAppPatch,
  type UpsertRecentAppInput,
} from "./recent-apps-model"

const appBuilderRoot = path.join(os.homedir(), ".app-builder")
const recentAppsPath = path.join(appBuilderRoot, "recent-apps.json")

export async function listRecentAppsSorted(): Promise<RecentApp[]> {
  const apps = await readPersistedRecentApps()
  return sortRecentApps(apps)
}

export async function upsertRecentApp(
  input: UpsertRecentAppInput
): Promise<RecentApp> {
  const apps = await readPersistedRecentApps()
  const now = Date.now()
  const existing = apps.find((app) => app.id === input.id)

  if (existing) {
    if (input.title !== undefined) {
      existing.title =
        normalizeRecentAppTitle(input.title) ?? DEFAULT_RECENT_APP_TITLE
    }

    if (input.touch !== false) {
      existing.updatedAt = now
    }

    await writePersistedRecentApps({ apps: sortRecentApps(apps) })
    return existing
  }

  const app: RecentApp = {
    id: input.id,
    title: input.title
      ? normalizeRecentAppTitle(input.title) ?? DEFAULT_RECENT_APP_TITLE
      : DEFAULT_RECENT_APP_TITLE,
    favorite: false,
    createdAt: now,
    updatedAt: now,
  }

  apps.push(app)
  await writePersistedRecentApps({ apps: sortRecentApps(apps) })
  return app
}

export async function updateRecentApp(
  id: string,
  patch: RecentAppPatch
): Promise<RecentApp | null> {
  const apps = await readPersistedRecentApps()
  const app = apps.find((item) => item.id === id)

  if (!app) {
    return null
  }

  if (patch.favorite !== undefined) {
    app.favorite = patch.favorite
  }

  if (patch.title !== undefined) {
    app.title = normalizeRecentAppTitle(patch.title) ?? app.title
  }

  app.updatedAt = Date.now()
  await writePersistedRecentApps({ apps: sortRecentApps(apps) })
  return app
}

export async function deleteRecentApp(id: string): Promise<boolean> {
  const apps = await readPersistedRecentApps()
  const nextApps = apps.filter((app) => app.id !== id)

  if (nextApps.length === apps.length) {
    return false
  }

  await writePersistedRecentApps({ apps: sortRecentApps(nextApps) })
  return true
}

async function readPersistedRecentApps(): Promise<RecentApp[]> {
  try {
    const raw = await fs.readFile(recentAppsPath, "utf8")
    const parsed = JSON.parse(raw) as Partial<PersistedRecentApps>

    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.apps)) {
      return []
    }

    return parsed.apps.flatMap((app) => {
      const sanitized = sanitizeRecentApp(app)
      return sanitized ? [sanitized] : []
    })
  } catch (error) {
    if (isNodeFileError(error) && error.code === "ENOENT") {
      return []
    }

    return []
  }
}

async function writePersistedRecentApps(recentApps: PersistedRecentApps) {
  await fs.mkdir(appBuilderRoot, { recursive: true })
  await fs.writeFile(
    recentAppsPath,
    `${JSON.stringify(recentApps, null, 2)}\n`,
    {
      mode: 0o600,
    }
  )
  await fs.chmod(recentAppsPath, 0o600).catch(() => {})
}

function isNodeFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
