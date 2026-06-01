"use client"

import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

// ─── Types ────────────────────────────────────────────────────────────────────

type ModelOption = { id: string; label: string; description?: string }

type ResponseBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; open: boolean }
  | { kind: "tool"; name: string; status: string }
  | { kind: "status"; status: string; message?: string }

type RunStats = {
  status: string
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
}

// ─── SSE parsing ──────────────────────────────────────────────────────────────

async function* parseSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let currentEvent = ""

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim()
        } else if (line.startsWith("data: ") && currentEvent) {
          try {
            const data = JSON.parse(line.slice(6)) as unknown
            yield { event: currentEvent, data }
          } catch {
            // skip malformed data lines
          }
          currentEvent = ""
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PromptDesignApp() {
  const [keyStatus, setKeyStatus] = React.useState<"loading" | "not-set" | "set">("loading")
  const [keyInput, setKeyInput] = React.useState("")
  const [keyError, setKeyError] = React.useState("")
  const [keyLoading, setKeyLoading] = React.useState(false)

  const [models, setModels] = React.useState<ModelOption[]>([])
  const [model, setModel] = React.useState("")
  const [instructions, setInstructions] = React.useState("")
  const [prompt, setPrompt] = React.useState("")
  const [cwd, setCwd] = React.useState("/")

  const [isRunning, setIsRunning] = React.useState(false)
  const [blocks, setBlocks] = React.useState<ResponseBlock[]>([])
  const [stats, setStats] = React.useState<RunStats | null>(null)
  const [runError, setRunError] = React.useState("")

  const abortRef = React.useRef<AbortController | null>(null)
  const responseEndRef = React.useRef<HTMLDivElement>(null)

  // ── Init ───────────────────────────────────────────────────────────────────

  React.useEffect(() => {
    void checkApiKey()
  }, [])

  React.useEffect(() => {
    if (keyStatus === "set") {
      void loadModels()
    }
  }, [keyStatus])

  React.useEffect(() => {
    if (isRunning) {
      responseEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
    }
  }, [blocks, isRunning])

  // ── API key ────────────────────────────────────────────────────────────────

  async function checkApiKey() {
    const res = await fetch("/api/settings/api-key")
    const json = (await res.json()) as { isSet: boolean }
    setKeyStatus(json.isSet ? "set" : "not-set")
  }

  async function handleSaveKey(e: React.FormEvent) {
    e.preventDefault()
    if (!keyInput.trim()) return

    setKeyLoading(true)
    setKeyError("")

    try {
      const res = await fetch("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: keyInput.trim() }),
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }

      if (!res.ok || json.error) {
        setKeyError(json.error ?? "Failed to save key.")
        return
      }

      setKeyInput("")
      setKeyStatus("set")
    } finally {
      setKeyLoading(false)
    }
  }

  async function handleClearKey() {
    await fetch("/api/settings/api-key", { method: "DELETE" })
    setKeyStatus("not-set")
    setModels([])
    setModel("")
  }

  // ── Models ─────────────────────────────────────────────────────────────────

  async function loadModels() {
    const res = await fetch("/api/models")
    const json = (await res.json()) as { models: ModelOption[] }
    setModels(json.models)
    if (json.models.length > 0 && !model) {
      setModel(json.models[0].id)
    }
  }

  // ── Run ────────────────────────────────────────────────────────────────────

  async function handleRun() {
    if (!prompt.trim() || isRunning) return

    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort

    setBlocks([])
    setStats(null)
    setRunError("")
    setIsRunning(true)

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions, prompt, cwd, model: model || undefined }),
        signal: abort.signal,
      })

      if (!res.ok || !res.body) {
        const json = (await res.json()) as { error?: string }
        setRunError(json.error ?? "Request failed.")
        return
      }

      for await (const { event, data } of parseSse(res.body)) {
        if (abort.signal.aborted) break
        handleSseEvent(event, data)
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        setRunError(error.message)
      }
    } finally {
      setIsRunning(false)
    }
  }

  function handleStop() {
    abortRef.current?.abort()
    setIsRunning(false)
  }

  function handleSseEvent(event: string, data: unknown) {
    const payload = data as Record<string, unknown>

    switch (event) {
      case "assistant_delta":
        appendText(String(payload.text ?? ""))
        break

      case "thinking":
        setBlocks((prev) => [
          ...prev,
          { kind: "thinking", text: String(payload.text ?? ""), open: false },
        ])
        break

      case "tool_call":
        setBlocks((prev) => {
          const last = prev[prev.length - 1]
          // update existing tool block for the same call when status changes
          if (
            last?.kind === "tool" &&
            last.name === String(payload.name ?? "") &&
            last.status === "requested"
          ) {
            return [
              ...prev.slice(0, -1),
              { kind: "tool", name: last.name, status: String(payload.status ?? "") },
            ]
          }
          return [
            ...prev,
            {
              kind: "tool",
              name: String(payload.name ?? ""),
              status: String(payload.status ?? ""),
            },
          ]
        })
        break

      case "status":
        setBlocks((prev) => [
          ...prev,
          {
            kind: "status",
            status: String(payload.status ?? ""),
            message: payload.message ? String(payload.message) : undefined,
          },
        ])
        break

      case "done":
        setStats({
          status: String(payload.status ?? ""),
          durationMs:
            typeof payload.durationMs === "number" ? payload.durationMs : undefined,
          inputTokens:
            typeof payload.inputTokens === "number" ? payload.inputTokens : undefined,
          outputTokens:
            typeof payload.outputTokens === "number" ? payload.outputTokens : undefined,
        })
        break

      case "error":
        setRunError(String(payload.message ?? "An error occurred."))
        break
    }
  }

  function appendText(text: string) {
    setBlocks((prev) => {
      const last = prev[prev.length - 1]
      if (last?.kind === "text") {
        return [...prev.slice(0, -1), { kind: "text", text: last.text + text }]
      }
      return [...prev, { kind: "text", text }]
    })
  }

  function toggleThinking(index: number) {
    setBlocks((prev) =>
      prev.map((block, i) =>
        i === index && block.kind === "thinking"
          ? { ...block, open: !block.open }
          : block
      )
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-semibold tracking-tight">Prompt Design</span>
        <ApiKeyIndicator
          status={keyStatus}
          onClear={handleClearKey}
        />
      </header>

      {/* Main */}
      <main className="flex min-h-0 flex-1 gap-0 overflow-hidden">
        {/* Left panel — inputs */}
        <section className="flex w-[420px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border p-4">
          {keyStatus === "not-set" && (
            <ApiKeyForm
              value={keyInput}
              error={keyError}
              loading={keyLoading}
              onChange={setKeyInput}
              onSubmit={handleSaveKey}
            />
          )}

          <FieldGroup label="Agent instructions">
            <Textarea
              className="min-h-[120px] resize-y font-mono text-xs"
              placeholder="You are a helpful coding agent. Work carefully and explain your changes."
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              disabled={isRunning}
            />
          </FieldGroup>

          <FieldGroup label="User prompt">
            <Textarea
              className="min-h-[140px] resize-y font-mono text-xs"
              placeholder="Describe the task for the agent…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isRunning}
            />
          </FieldGroup>

          <FieldGroup label="Working directory">
            <Input
              placeholder="/path/to/project"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              disabled={isRunning}
              spellCheck={false}
            />
          </FieldGroup>

          {models.length > 0 && (
            <FieldGroup label="Model">
              <Select value={model} onValueChange={(v) => { if (v) setModel(v) }}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldGroup>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              className="flex-1"
              onClick={handleRun}
              disabled={!prompt.trim() || isRunning || keyStatus !== "set"}
            >
              {isRunning ? "Running…" : "Run"}
            </Button>
            {isRunning && (
              <Button variant="outline" onClick={handleStop}>
                Stop
              </Button>
            )}
          </div>
        </section>

        {/* Right panel — response */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4">
            <span className="text-xs font-medium text-muted-foreground">Response</span>
            {stats && (
              <RunStatsBar stats={stats} />
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {blocks.length === 0 && !runError && (
              <EmptyState isRunning={isRunning} />
            )}

            {blocks.map((block, i) => (
              <ResponseBlockView
                key={i}
                block={block}
                onToggleThinking={() => toggleThinking(i)}
              />
            ))}

            {runError && (
              <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {runError}
              </div>
            )}

            <div ref={responseEndRef} />
          </div>
        </section>
      </main>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function ApiKeyIndicator({
  status,
  onClear,
}: {
  status: "loading" | "not-set" | "set"
  onClear: () => void
}) {
  if (status === "loading") {
    return <span className="text-xs text-muted-foreground">Loading…</span>
  }

  if (status === "not-set") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        No API key
      </Badge>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Badge variant="secondary">Connected</Badge>
      <Button variant="ghost" size="xs" onClick={onClear}>
        Change key
      </Button>
    </div>
  )
}

function ApiKeyForm({
  value,
  error,
  loading,
  onChange,
  onSubmit,
}: {
  value: string
  error: string
  loading: boolean
  onChange: (value: string) => void
  onSubmit: (e: React.FormEvent) => void
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3"
    >
      <span className="text-xs font-medium">Cursor API key</span>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder="cursor_…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono"
          autoFocus
        />
        <Button type="submit" disabled={!value.trim() || loading}>
          {loading ? "Saving…" : "Save"}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        Get your key at{" "}
        <span className="font-mono">cursor.com/dashboard/integrations</span>
      </p>
    </form>
  )
}

function RunStatsBar({ stats }: { stats: RunStats }) {
  const parts: string[] = []

  if (stats.durationMs !== undefined) {
    parts.push(
      stats.durationMs < 1000
        ? `${stats.durationMs}ms`
        : `${(stats.durationMs / 1000).toFixed(1)}s`
    )
  }

  if (stats.inputTokens !== undefined) {
    parts.push(`${stats.inputTokens} in`)
  }

  if (stats.outputTokens !== undefined) {
    parts.push(`${stats.outputTokens} out`)
  }

  return (
    <span className="text-xs text-muted-foreground">
      {stats.status} · {parts.join(" · ")}
    </span>
  )
}

function EmptyState({ isRunning }: { isRunning: boolean }) {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center">
      <p className="text-sm text-muted-foreground">
        {isRunning ? "Waiting for agent…" : "Run a prompt to see the response here."}
      </p>
    </div>
  )
}

function ResponseBlockView({
  block,
  onToggleThinking,
}: {
  block: ResponseBlock
  onToggleThinking: () => void
}) {
  if (block.kind === "text") {
    return (
      <pre className="mb-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
        {block.text}
      </pre>
    )
  }

  if (block.kind === "thinking") {
    return (
      <details
        open={block.open}
        onToggle={onToggleThinking}
        className="mb-2 rounded-lg border border-border bg-muted/50"
      >
        <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-muted-foreground">
          Thinking…
        </summary>
        <pre className="px-3 pb-2 pt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
          {block.text}
        </pre>
      </details>
    )
  }

  if (block.kind === "tool") {
    return (
      <div className="mb-1 flex items-center gap-1.5">
        <ToolStatusDot status={block.status} />
        <span className="font-mono text-xs text-muted-foreground">{block.name}</span>
        <span className={cn("text-xs", toolStatusColor(block.status))}>{block.status}</span>
      </div>
    )
  }

  if (block.kind === "status") {
    const text = block.message
      ? `${block.status}: ${block.message}`
      : block.status
    return (
      <div className="mb-1 text-xs text-muted-foreground/60 italic">[{text}]</div>
    )
  }

  return null
}

function ToolStatusDot({ status }: { status: string }) {
  const color =
    status === "done" || status === "success"
      ? "bg-green-500"
      : status === "error" || status === "failed"
        ? "bg-destructive"
        : status === "requested"
          ? "bg-muted-foreground/40"
          : "bg-yellow-500"

  return <span className={cn("size-1.5 rounded-full", color)} />
}

function toolStatusColor(status: string): string {
  if (status === "done" || status === "success") return "text-green-500"
  if (status === "error" || status === "failed") return "text-destructive"
  return "text-muted-foreground"
}
