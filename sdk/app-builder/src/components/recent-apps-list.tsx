import {
  StarIcon as Star,
  TrashIcon as Trash2,
} from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { RecentApp } from "@/lib/app-builder/recent-apps-model"

export function RecentAppsList({
  activeRecentAppId,
  recentApps,
  onDeleteRecentApp,
  onOpenRecentApp,
  onToggleRecentAppFavorite,
}: {
  activeRecentAppId?: string
  recentApps: RecentApp[]
  onDeleteRecentApp: (recentAppId: string) => void
  onOpenRecentApp: (recentApp: RecentApp) => void
  onToggleRecentAppFavorite: (recentAppId: string) => void
}) {
  return (
    <div className="flex flex-col gap-1 pb-2">
      <p className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
        Recent Apps
      </p>
      {recentApps.length ? (
        recentApps.map((recentApp) => {
          const isActive = recentApp.id === activeRecentAppId

          return (
            <div
              key={recentApp.id}
              className={cn(
                "group flex items-center gap-1 rounded-md pr-1 text-muted-foreground",
                isActive && "bg-muted text-foreground"
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-current={isActive ? "page" : undefined}
                onClick={() => onOpenRecentApp(recentApp)}
              >
                <span className="block truncate text-sm font-medium text-foreground">
                  {recentApp.title}
                </span>
                <span className="block truncate text-xs font-normal text-muted-foreground/80">
                  {formatRecentAppUpdatedAt(recentApp.updatedAt)}
                </span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "size-7 rounded-md text-muted-foreground",
                  recentApp.favorite && "text-foreground"
                )}
                aria-label={
                  recentApp.favorite
                    ? "Remove from favorites"
                    : "Add to favorites"
                }
                title={
                  recentApp.favorite
                    ? "Remove from favorites"
                    : "Add to favorites"
                }
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleRecentAppFavorite(recentApp.id)
                }}
              >
                <Star
                  aria-hidden="true"
                  className="size-3.5"
                  weight={recentApp.favorite ? "fill" : "regular"}
                />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7 rounded-md text-muted-foreground hover:text-destructive"
                aria-label="Remove recent app"
                title="Remove recent app"
                onClick={(event) => {
                  event.stopPropagation()
                  onDeleteRecentApp(recentApp.id)
                }}
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
              </Button>
            </div>
          )
        })
      ) : (
        <p className="px-2 pb-1 text-xs text-muted-foreground/70">
          Created apps will appear here.
        </p>
      )}
    </div>
  )
}

function formatRecentAppUpdatedAt(updatedAt: number) {
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) {
    return "Updated recently"
  }

  return `Updated ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`
}
