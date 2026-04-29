import {
  Agent,
  Cursor,
  type ModelSelection,
  type Run,
  type SDKAgent,
  type SDKMessage,
  type SDKModel,
} from "@cursor/sdk"
import type { ProjectInfo } from "./detector.js"
import type { CommandSpec } from "./detector.js"
import { buildGeneratePrompt, buildRepairPrompt } from "./prompts.js"
import type { TestResult } from "./runner.js"

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
  | { type: "test_run_started"; command: CommandSpec }
  | { type: "test_run_finished"; result: TestResult }

export type ModelChoice = {
  description?: string
  label: string
  value: ModelSelection
}

export type TokenUsage = {
  inputTokens?: number
  outputTokens?: number
}

export type TestGenSessionOptions = {
  apiKey: string
  cwd: string
  model: ModelSelection
}

export type PromptFileOptions = {
  allowSourceEdits: boolean
  sourceContent: string
  sourcePath: string
  testPath: string
}

export type RepairFileOptions = PromptFileOptions & {
  failureSummary: string
  testContent: string
}

export type CancelRunResult =
  | { cancelled: true }
  | { cancelled: false; reason: string }

type SendPromptOptions = {
  onEvent: (event: AgentEvent) => void
  prompt: string
}

export class TestGenSession {
  private agent: Promise<SDKAgent>
  private currentRun: Run | null = null
  private readonly apiKey: string
  private readonly cwd: string
  private modelSelection: ModelSelection

  constructor(options: TestGenSessionOptions) {
    this.apiKey = options.apiKey
    this.cwd = options.cwd
    this.modelSelection = options.model
    this.agent = this.createAgent()
  }

  get model() {
    return this.modelSelection
  }

  setModel(model: ModelSelection) {
    this.modelSelection = model
  }

  async listModels(): Promise<ModelChoice[]> {
    const models = await Cursor.models.list({ apiKey: this.apiKey })
    const choices = models.flatMap(modelToChoices)

    return choices.length > 0
      ? choices
      : [{ label: this.modelSelection.id, value: this.modelSelection }]
  }

  async generateForFile(
    project: ProjectInfo,
    options: PromptFileOptions,
    onEvent: (event: AgentEvent) => void
  ) {
    await this.sendPrompt({
      prompt: buildGeneratePrompt(project, options),
      onEvent,
    })
  }

  async iterateRepair(
    project: ProjectInfo,
    options: RepairFileOptions,
    onEvent: (event: AgentEvent) => void
  ) {
    await this.sendPrompt({
      prompt: buildRepairPrompt(project, options),
      onEvent,
    })
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

  async dispose() {
    const agent = await this.agent
    await agent[Symbol.asyncDispose]()
  }

  private createAgent() {
    return Agent.create({
      apiKey: this.apiKey,
      name: "Test generator",
      model: this.modelSelection,
      local: {
        cwd: this.cwd,
      },
    })
  }

  private async sendPrompt({ prompt, onEvent }: SendPromptOptions) {
    const agent = await this.agent
    const run = await agent.send(prompt, { model: this.modelSelection })
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
}

export function formatModelLabel(model: ModelSelection) {
  const params = model.params?.map((param) => param.value).filter(Boolean)
  return params?.length ? `${model.id} (${params.join(", ")})` : model.id
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

  return variants.map((variant) => ({
    label: variant.displayName ? `${baseLabel} - ${variant.displayName}` : baseLabel,
    value: { id: model.id, params: variant.params },
    description: variant.description ?? model.description,
  }))
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
            params: summarizeToolArgs(block.input),
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
        params: summarizeToolArgs(event.args),
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

function summarizeToolArgs(args: unknown) {
  if (!args || typeof args !== "object") {
    return undefined
  }

  const record = args as Record<string, unknown>
  const value = record.path ?? record.file ?? record.target_file ?? record.command

  if (typeof value === "string") {
    return value.length > 80 ? `${value.slice(0, 77)}...` : value
  }

  return undefined
}
