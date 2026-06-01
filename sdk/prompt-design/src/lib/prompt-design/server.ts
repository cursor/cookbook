import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  Agent,
  Cursor,
  type ModelSelection,
  type SDKMessage,
  type SDKModel,
} from "@cursor/sdk"

export type AgentStreamEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; status: string; args?: unknown }
  | { type: "status"; status: string; message?: string }
  | { type: "task"; status?: string; text?: string }

export type RunStats = {
  status: string
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
}

export type ModelOption = {
  id: string
  label: string
  description?: string
}

type PersistedSettings = {
  cursorApiKey?: string
}

const promptDesignRoot = path.join(os.homedir(), ".prompt-design")
const settingsPath = path.join(promptDesignRoot, "settings.json")

const fallbackModels: ModelOption[] = [
  { id: "auto", label: "Auto" },
  { id: "composer-2", label: "Composer 2" },
]

export class InvalidCursorApiKeyError extends Error {
  readonly code = "invalid_api_key"

  constructor(message = "The Cursor API key could not be validated.") {
    super(message)
    this.name = "InvalidCursorApiKeyError"
  }
}

export async function readPersistedCursorApiKey(): Promise<string | null> {
  const settings = await readPersistedSettings()
  const apiKey = settings.cursorApiKey?.trim()
  return apiKey || null
}

export async function savePersistedCursorApiKey(apiKey: string): Promise<void> {
  const settings = await readPersistedSettings()
  settings.cursorApiKey = apiKey
  await writePersistedSettings(settings)
}

export async function validateCursorApiKey(apiKey: string): Promise<void> {
  try {
    await Cursor.me({ apiKey })
  } catch {
    throw new InvalidCursorApiKeyError(
      "The Cursor API key could not be validated. Please check the key and try again."
    )
  }
}

export async function clearPersistedCursorApiKey(): Promise<void> {
  const settings = await readPersistedSettings()
  delete settings.cursorApiKey

  if (Object.keys(settings).length === 0) {
    await fs.unlink(settingsPath).catch((error: unknown) => {
      if (!isNodeFileError(error) || error.code !== "ENOENT") {
        throw error
      }
    })
    return
  }

  await writePersistedSettings(settings)
}

export async function listModels(apiKey: string): Promise<ModelOption[]> {
  try {
    const models = await Cursor.models.list({ apiKey })
    const options = dedupeModels(models.map(modelToOption))
    return options.length > 0 ? options : fallbackModels
  } catch {
    return fallbackModels
  }
}

export async function runPrompt(
  apiKey: string,
  instructions: string,
  prompt: string,
  cwd: string,
  model: string | undefined,
  emit: (event: AgentStreamEvent) => void
): Promise<RunStats> {
  const modelSelection: ModelSelection = { id: model ?? (process.env.CURSOR_MODEL ?? "composer-2") }
  const agent = await Agent.create({
    apiKey,
    model: modelSelection,
    local: { cwd },
  })

  try {
    const run = await agent.send(buildPrompt(instructions, prompt))

    for await (const event of run.stream()) {
      emitSdkMessage(event, emit)
    }

    const result = await run.wait()
    const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number } }).usage

    return {
      status: result.status,
      durationMs: result.durationMs,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    }
  } finally {
    await agent[Symbol.asyncDispose]()
  }
}

function buildPrompt(instructions: string, prompt: string): string {
  const parts: string[] = []
  if (instructions.trim()) {
    parts.push(instructions.trim(), "")
  }
  parts.push("User task:", prompt)
  return parts.join("\n")
}

function modelToOption(model: SDKModel): ModelOption {
  return {
    id: model.id,
    label: model.displayName || model.id,
    description: model.description,
  }
}

function dedupeModels(models: ModelOption[]): ModelOption[] {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

async function readPersistedSettings(): Promise<PersistedSettings> {
  try {
    const raw = await fs.readFile(settingsPath, "utf8")
    const parsed = JSON.parse(raw) as PersistedSettings

    if (!parsed || typeof parsed !== "object") {
      return {}
    }

    return {
      cursorApiKey:
        typeof parsed.cursorApiKey === "string" ? parsed.cursorApiKey : undefined,
    }
  } catch (error) {
    if (isNodeFileError(error) && error.code === "ENOENT") {
      return {}
    }
    return {}
  }
}

async function writePersistedSettings(settings: PersistedSettings): Promise<void> {
  await fs.mkdir(promptDesignRoot, { recursive: true })
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  })
  await fs.chmod(settingsPath, 0o600).catch(() => {})
}

function isNodeFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function emitSdkMessage(event: SDKMessage, emit: (event: AgentStreamEvent) => void) {
  switch (event.type) {
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text") {
          emit({ type: "assistant_delta", text: block.text })
        } else {
          emit({ type: "tool_call", name: block.name, status: "requested", args: block.input })
        }
      }
      break
    case "thinking":
      emit({ type: "thinking", text: event.text })
      break
    case "tool_call":
      emit({ type: "tool_call", name: event.name, status: event.status, args: event.args })
      break
    case "status":
      emit({ type: "status", status: event.status, message: event.message })
      break
    case "task":
      emit({ type: "task", status: event.status, text: event.text })
      break
    default:
      break
  }
}
