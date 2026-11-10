import {
  listRecentAppsSorted,
  upsertRecentApp,
} from "@/lib/app-builder/recent-apps"
import { parseRecentAppsRequest } from "@/lib/app-builder/recent-apps-api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const apps = await listRecentAppsSorted()
  return Response.json({ apps })
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  const parsed = parseRecentAppsRequest(body)

  if (!parsed.ok) {
    return Response.json(
      { error: parsed.error },
      { status: 400 }
    )
  }

  const app = await upsertRecentApp(parsed.value)

  return Response.json({ app })
}
