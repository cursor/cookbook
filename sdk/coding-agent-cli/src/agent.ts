import { execFileSync } from "node:child_process"
import {
  Agent,
  Cursor,
  type ModelSelection,
  type Run,
  type SDKAgent,
  type SDKMessage,
  type SDKModel,
} from "@cursor/sdk"

export type AgentEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool"
      callId?: string
      name: string
      params?: string
      status: string
    }
  | { type: "status"; status: string; message?: string }
  | { type: "task"; status?: string; text?: string }
  | { type: "result"; status: string; durationMs?: number; usage?: TokenUsage }

export type ModelChoice = {
  label: string
  value: ModelSelection
  description?: string
}

export type TokenUsage = {
  inputTokens?: number
  outputTokens?: number
}

export type ExecutionMode = "cloud" | "local"

type CloudRepository = {
  url: string
  startingRef?: string
}

type CodingAgentSessionOptions = {
  apiKey: string
  cwd: string
  model: ModelSelection
  force: boolean
  executionMode?: ExecutionMode
}

type SendPromptOptions = {
  prompt: string
  onEvent: (event: AgentEvent) => void
}

export type CancelRunResult =
  | { cancelled: true }
  | { cancelled: false; reason: string }

const AGENT_INSTRUCTIONS = [
  "You are a lightweight coding agent running from a terminal.",
  "Work in the configured workspace.",
  "Help the user inspect, edit, and validate code with small focused changes.",
  "Before changing files, understand the surrounding code and preserve unrelated user work.",
  "Keep progress updates concise and summarize the result clearly.",
].join("\n")

export class CodingAgentSession {
  private agent: SDKAgent | Promise<SDKAgent>
  private agentKey: string
  private cloudRepository: CloudRepository | null = null
  private currentRun: Run | null = null
  private readonly apiKey: string
  private readonly cwd: string
  private readonly force: boolean
  private mode: ExecutionMode
  private modelSelection: ModelSelection

  constructor(options: CodingAgentSessionOptions) {
    this.apiKey = options.apiKey
    this.cwd = options.cwd
    this.force = options.force
    this.mode = options.executionMode ?? "local"
    this.modelSelection = options.model
    this.agent = this.createAgent()
    this.agentKey = this.currentAgentKey()
  }

  get model() {
    return this.modelSelection
  }

  get executionMode() {
    return this.mode
  }

  get executionTarget() {
    return this.mode === "local"
      ? this.cwd
      : formatCloudRepository(this.cloudRepository ?? detectCloudRepository(this.cwd))
  }

  setModel(model: ModelSelection) {
    this.modelSelection = model
  }

  async listModels(): Promise<ModelChoice[]> {
    const models = await Cursor.models.list({ apiKey: this.apiKey })
    const choices = disambiguateGlobalDuplicateLabels(
      dedupeModelChoices(models.flatMap(modelToChoices))
    )

    return choices.length > 0
      ? choices
      : [{ label: this.modelSelection.id, value: this.modelSelection }]
  }

  async reset() {
    await this.replaceAgent()
  }

  async setExecutionMode(mode: ExecutionMode) {
    if (this.currentRun) {
      throw new Error("Wait for the current run to finish before switching execution mode.")
    }

    if (this.mode === mode) {
      return
    }

    const previousMode = this.mode
    this.mode = mode

    try {
      await this.replaceAgent()
    } catch (error) {
      this.mode = previousMode
      throw error
    }
  }

  async dispose() {
    await (await this.agent)[Symbol.asyncDispose]()
  }

  async cancelCurrentRun(): Promise<CancelRunResult> {
    const run = this.currentRun

    if (!run) {
      return { cancelled: false, reason: "No active run to cancel." }
    }

    if (!run.supports("cancel")) {
      return {
        cancelled: false,
        reason: run.unsupportedReason("cancel") ?? "This run cannot be cancelled.",
      }
    }

    await run.cancel()
    return { cancelled: true }
  }

  async sendPrompt({ prompt, onEvent }: SendPromptOptions) {
    await this.ensureAgentFresh()

    const run = await (await this.agent).send(buildPrompt(prompt), {
      ...(this.mode === "local" ? { model: this.modelSelection } : {}),
      ...(this.mode === "local" && this.force ? { local: { force: true } } : {}),
    })

    this.currentRun = run

    try {
      for await (const event of run.stream()) {
        emitSdkMessage(event, onEvent)
      }

      const result = await run.wait()
      const usage = (result as { usage?: TokenUsage }).usage
      onEvent({
        type: "result",
        status: result.status,
        durationMs: result.durationMs,
        usage,
      })
    } finally {
      if (this.currentRun === run) {
        this.currentRun = null
      }
    }
  }

  private createAgent() {
    const options = {
      apiKey: this.apiKey,
      name: "Lightweight coding agent",
      model: this.modelSelection,
    }

    if (this.mode === "cloud") {
      const repository = detectCloudRepository(this.cwd)
      this.cloudRepository = repository

      return Agent.create({
        ...options,
        cloud: {
          repos: [repository],
        },
      })
    }

    this.cloudRepository = null

    return Agent.create({
      ...options,
      local: {
        cwd: this.cwd,
      },
    })
  }

  private async ensureAgentFresh() {
    if (this.agentKey !== this.currentAgentKey()) {
      await this.replaceAgent()
    }
  }

  private async replaceAgent() {
    const previousAgent = this.agent
    this.agent = this.createAgent()
    this.agentKey = this.currentAgentKey()
    await (await previousAgent)[Symbol.asyncDispose]()
  }

  private currentAgentKey() {
    const modelKey =
      this.mode === "cloud" ? modelSelectionKey(this.modelSelection) : undefined
    return JSON.stringify({ mode: this.mode, model: modelKey })
  }
}

export function buildPrompt(prompt: string) {
  return [AGENT_INSTRUCTIONS, "", "User task:", prompt].join("\n")
}

export function formatModelLabel(model: ModelSelection) {
  const params = model.params?.map((param) => param.value).filter(Boolean)
  return params?.length ? `${model.id} (${params.join(", ")})` : model.id
}

export function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`
  }

  return `${(ms / 1000).toFixed(1)}s`
}

function modelToChoices(model: SDKModel): ModelChoice[] {
  const baseLabel = model.displayName || model.id
  const variants = model.variants ?? []

  if (variants.length === 0) {
    return [
      {
        label: baseLabel,
        value: { id: model.id },
        description: model.description,
      },
    ]
  }

  const choices = variants.map((variant) => ({
    label: buildVariantLabel(model, variant.displayName),
    value: { id: model.id, params: variant.params },
    description: variant.description ?? model.description,
  }))

  return disambiguateDuplicateLabels(dedupeModelChoices(choices), model)
}

function buildVariantLabel(model: SDKModel, variantDisplayName: string) {
  const baseLabel = model.displayName || model.id
  const variantLabel = variantDisplayName.trim()

  if (!variantLabel || labelsMatch(baseLabel, variantLabel)) {
    return baseLabel
  }

  return `${baseLabel} - ${variantLabel}`
}

function disambiguateDuplicateLabels(
  choices: ModelChoice[],
  model: SDKModel
): ModelChoice[] {
  const labelCounts = choices.reduce((counts, choice) => {
    counts.set(choice.label, (counts.get(choice.label) ?? 0) + 1)
    return counts
  }, new Map<string, number>())

  return choices.map((choice) => {
    if ((labelCounts.get(choice.label) ?? 0) <= 1) {
      return choice
    }

    const paramsLabel = formatParamsLabel(choice.value.params ?? [], model)
    return paramsLabel
      ? { ...choice, label: `${choice.label} - ${paramsLabel}` }
      : choice
  })
}

function dedupeModelChoices(choices: ModelChoice[]) {
  const bySelection = new Map<string, ModelChoice>()

  for (const choice of choices) {
    const key = modelSelectionKey(choice.value)
    const existing = bySelection.get(key)

    if (!existing) {
      bySelection.set(key, choice)
      continue
    }

    bySelection.set(key, {
      ...existing,
      description: existing.description ?? choice.description,
    })
  }

  return Array.from(bySelection.values())
}

function disambiguateGlobalDuplicateLabels(choices: ModelChoice[]) {
  const labelCounts = choices.reduce((counts, choice) => {
    counts.set(choice.label, (counts.get(choice.label) ?? 0) + 1)
    return counts
  }, new Map<string, number>())
  const readableKeys = new Set<string>()
  const result: ModelChoice[] = []

  for (const choice of choices) {
    const label = (labelCounts.get(choice.label) ?? 0) > 1
      ? addSelectionDetail(choice)
      : choice.label
    const readableKey = normalizeLabel(label)

    if (readableKeys.has(readableKey)) {
      continue
    }

    readableKeys.add(readableKey)
    result.push({ ...choice, label })
  }

  return result
}

function addSelectionDetail(choice: ModelChoice) {
  const detail = selectionDetail(choice.value)

  if (!detail || labelsMatch(choice.label, detail)) {
    return choice.label
  }

  return `${choice.label} - ${detail}`
}

function selectionDetail(selection: ModelSelection) {
  if (selection.params?.length) {
    return selection.params
      .map((param) => labelFromId(param.value))
      .filter(Boolean)
      .join(", ")
  }

  return selection.id
}

function modelSelectionKey(selection: ModelSelection) {
  const params = [...(selection.params ?? [])]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((param) => `${param.id}=${param.value}`)
    .join("&")

  return params ? `${selection.id}?${params}` : selection.id
}

function detectCloudRepository(cwd: string): CloudRepository {
  const remote = runGit(cwd, ["config", "--get", "remote.origin.url"])

  if (!remote) {
    throw new Error("Cloud mode requires a git repository with remote.origin.url set.")
  }

  const url = normalizeGitHubRemote(remote)

  if (!url) {
    throw new Error("Cloud mode currently expects remote.origin.url to point at GitHub.")
  }

  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  const startingRef = branch && branch !== "HEAD" ? branch : undefined

  return startingRef ? { url, startingRef } : { url }
}

function runGit(cwd: string, args: string[]) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return undefined
  }
}

function normalizeGitHubRemote(remote: string) {
  const trimmed = remote.trim().replace(/\.git$/, "")
  const sshMatch = trimmed.match(/^git@github\.com:(.+\/.+)$/)
  const sshUrlMatch = trimmed.match(/^ssh:\/\/git@github\.com\/(.+\/.+)$/)
  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/(.+\/.+)$/)
  const repoPath = sshMatch?.[1] ?? sshUrlMatch?.[1] ?? httpsMatch?.[1]

  return repoPath ? `https://github.com/${repoPath}` : undefined
}

function formatCloudRepository(repository: CloudRepository) {
  return repository.startingRef
    ? `${repository.url}#${repository.startingRef}`
    : repository.url
}

function formatParamsLabel(
  params: NonNullable<ModelSelection["params"]>,
  model: SDKModel
) {
  return params
    .map((param) => {
      const parameter = model.parameters?.find((item) => item.id === param.id)
      const value = parameter?.values.find((item) => item.value === param.value)
      const parameterLabel = parameter?.displayName || labelFromId(param.id)
      const valueLabel = value?.displayName || labelFromId(param.value)

      if (labelsMatch(parameterLabel, valueLabel)) {
        return valueLabel
      }

      return `${parameterLabel}: ${valueLabel}`
    })
    .filter(Boolean)
    .join(", ")
}

function labelsMatch(left: string, right: string) {
  return normalizeLabel(left) === normalizeLabel(right)
}

function normalizeLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function labelFromId(id: string) {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function emitSdkMessage(event: SDKMessage, emit: (event: AgentEvent) => void) {
  switch (event.type) {
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text") {
          emit({ type: "assistant_delta", text: block.text })
        } else {
          emit({
            type: "tool",
            callId: block.id,
            name: block.name,
            params: summarizeToolArgs(block.name, block.input),
            status: "requested",
          })
        }
      }
      break
    case "thinking":
      emit({ type: "thinking", text: event.text })
      break
    case "tool_call":
      emit({
        type: "tool",
        callId: event.call_id,
        name: event.name,
        params: summarizeToolArgs(event.name, event.args),
        status: event.status,
      })
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

function summarizeToolArgs(toolName: string, args: unknown) {
  if (!args || typeof args !== "object") {
    return undefined
  }

  const record = args as Record<string, unknown>
  const keyGroups = getToolSummaryKeys(toolName)
  const parts: string[] = []

  for (const keys of keyGroups) {
    const part = summarizeFirstValue(record, keys)
    if (part) {
      parts.push(part)
    }
  }

  return parts.length > 0 ? parts.join(" ") : undefined
}

function getToolSummaryKeys(toolName: string) {
  const name = toolName.toLowerCase()

  if (name.includes("read")) {
    return [["path", "filePath", "target_file", "absolutePath"], ["offset"], ["limit"]]
  }

  if (name.includes("glob")) {
    return [["pattern", "glob", "glob_pattern"], ["path", "cwd", "target_directory"]]
  }

  if (name.includes("grep") || name.includes("search")) {
    return [["pattern", "query"], ["path"], ["glob"], ["type"]]
  }

  if (name.includes("shell") || name.includes("terminal") || name.includes("command")) {
    return [["command", "cmd"], ["cwd", "working_directory"]]
  }

  if (name.includes("edit") || name.includes("write") || name.includes("patch")) {
    return [["path", "target_file", "file"], ["instruction"]]
  }

  return [
    ["path", "file", "target_file"],
    ["pattern", "query", "command"],
  ]
}

function summarizeFirstValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    const formatted = formatArgValue(value)

    if (formatted) {
      return `${key}=${formatted}`
    }
  }

  return undefined
}

function formatArgValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return shortenValue(value.replace(/\s+/g, " ").trim())
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  if (Array.isArray(value)) {
    const items: string[] = value
      .slice(0, 3)
      .map(formatArgValue)
      .filter((item): item is string => Boolean(item))
    return items.length > 0 ? `[${items.join(",")}]` : undefined
  }

  return undefined
}

function shortenValue(value: string, maxLength = 80) {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength - 3)}...`
}
