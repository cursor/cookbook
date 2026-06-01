import {
  readPersistedCursorApiKey,
  runPrompt,
  type AgentStreamEvent,
  type RunStats,
} from "@/lib/prompt-design/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RunRequest = {
  instructions?: string
  prompt?: string
  cwd?: string
  model?: string
}

export async function POST(request: Request) {
  const body = (await request.json()) as RunRequest

  if (!body.prompt?.trim()) {
    return Response.json({ error: "prompt is required." }, { status: 400 })
  }

  const apiKey = await readPersistedCursorApiKey()
  if (!apiKey) {
    return Response.json({ error: "Cursor API key is not configured." }, { status: 401 })
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()

      const send = (eventType: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
        )
      }

      try {
        const stats = await runPrompt(
          apiKey,
          body.instructions ?? "",
          body.prompt!,
          body.cwd ?? process.cwd(),
          body.model,
          (event: AgentStreamEvent) => send(event.type, event)
        )
        send("done", { ok: true, ...stats } satisfies { ok: boolean } & RunStats)
      } catch (error) {
        const message = error instanceof Error ? error.message : "The agent run failed."
        send("error", { message })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  })
}
