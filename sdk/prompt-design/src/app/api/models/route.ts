import {
  listModels,
  readPersistedCursorApiKey,
} from "@/lib/prompt-design/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const apiKey = await readPersistedCursorApiKey()
  if (!apiKey) {
    return Response.json({ models: [] })
  }

  const models = await listModels(apiKey)
  return Response.json({ models })
}
