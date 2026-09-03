import {
  deleteRecentApp,
  updateRecentApp,
} from "@/lib/app-builder/recent-apps"
import { parseRecentAppPatchRequest } from "@/lib/app-builder/recent-apps-api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RecentAppRouteContext = {
  params: Promise<{ id: string }>
}

export async function PATCH(
  request: Request,
  { params }: RecentAppRouteContext
) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const parsed = parseRecentAppPatchRequest(id, body)

  if (!parsed.ok) {
    return Response.json(
      { error: parsed.error },
      { status: 400 }
    )
  }

  const app = await updateRecentApp(parsed.value.id, parsed.value.patch)
  if (!app) {
    return Response.json({ error: "Recent app not found." }, { status: 404 })
  }

  return Response.json({ app })
}

export async function DELETE(
  _request: Request,
  { params }: RecentAppRouteContext
) {
  const { id } = await params
  const deleted = await deleteRecentApp(id.trim())

  return Response.json({ ok: true, deleted })
}
