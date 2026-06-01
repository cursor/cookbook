import {
  clearPersistedCursorApiKey,
  InvalidCursorApiKeyError,
  readPersistedCursorApiKey,
  savePersistedCursorApiKey,
  validateCursorApiKey,
} from "@/lib/prompt-design/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const apiKey = await readPersistedCursorApiKey()
  return Response.json({ isSet: apiKey !== null })
}

export async function POST(request: Request) {
  const body = (await request.json()) as { apiKey?: string }
  const apiKey = body.apiKey?.trim()

  if (!apiKey) {
    return Response.json({ error: "apiKey is required." }, { status: 400 })
  }

  try {
    await validateCursorApiKey(apiKey)
  } catch (error) {
    if (error instanceof InvalidCursorApiKeyError) {
      return Response.json({ error: error.message }, { status: 422 })
    }
    throw error
  }

  await savePersistedCursorApiKey(apiKey)
  return Response.json({ ok: true })
}

export async function DELETE() {
  await clearPersistedCursorApiKey()
  return Response.json({ ok: true })
}
