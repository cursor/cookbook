import spawn from "cross-spawn"
import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import {
  Agent,
  Cursor,
  type ModelSelection,
  type Run,
  type SDKAgent,
  type SDKMessage,
  type SDKModel,
} from "@cursor/sdk"

import { generatedAppFiles } from "./template"

type BuilderSession = {
  id: string
  apiKey: string
  models: ModelCatalogItem[]
  user: PublicUser | null
  projectPath: string
  previewUrl: string
  port: number
  logs: string[]
  ready: Promise<void>
  devProcess?: ChildProcess
  agent?: SDKAgent
  setupError?: string
}

type PersistedSettings = {
  cursorApiKey?: string
}

export type PublicSession = {
  id: string
  previewUrl: string
  projectPath: string
  models: ModelCatalogItem[]
  user: PublicUser | null
}

export type PublicUser = {
  name: string
  email?: string
}

export type ModelCatalogItem = {
  id: string
  label: string
  description?: string
  parameters: ModelParameterConfig[]
  defaultParams: ModelParamConfig[]
}

export type ModelParameterConfig = {
  id: string
  label: string
  values: ModelParameterValueConfig[]
}

export type ModelParameterValueConfig = {
  id: string
  label: string
}

export type ModelParamConfig = {
  id: string
  value: string
}

export class InvalidCursorApiKeyError extends Error {
  readonly code = "invalid_api_key"

  constructor(message = "The Cursor API key could not be validated.") {
    super(message)
    this.name = "InvalidCursorApiKeyError"
  }
}

export class UnknownAppBuilderSessionError extends Error {
  readonly code = "unknown_session"

  constructor(
    message = "Unknown app builder session. Create a new session first."
  ) {
    super(message)
    this.name = "UnknownAppBuilderSessionError"
  }
}

export class ProjectNameGenerationTimeoutError extends Error {
  readonly code = "project_name_timeout"

  constructor(message = "Project name generation timed out. Try again.") {
    super(message)
    this.name = "ProjectNameGenerationTimeoutError"
  }
}

export type AgentStreamEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "thinking"; id?: string; text: string }
  | {
      type: "tool_call"
      callId?: string
      name: string
      status: string
      args?: unknown
      truncatedArgs?: boolean
    }
  | { type: "status"; status: string; message?: string }
  | { type: "task"; status?: string; text?: string }

export type ProjectNameMessage = {
  role: "assistant" | "user"
  content: string
}

type ProjectNameContext = {
  prompt?: string
  messages?: ProjectNameMessage[]
}

const appBuilderRoot = path.join(os.homedir(), ".app-builder")
const workspaceRoot = path.join(appBuilderRoot, "sessions")
const settingsPath = path.join(appBuilderRoot, "settings.json")
const DEFAULT_PROJECT_NAME_TIMEOUT_MS = 15_000
const APP_BUILDER_INSTRUCTIONS = [
  "You are building a local Vite React TypeScript application for a live preview product.",
  "Edit files directly in the current workspace. The dev server is already running and hot reloads when files change.",
  "Keep changes focused on the user's requested app. Prefer small, working iterations over broad rewrites.",
  "Do not start another long-running dev server unless the existing preview server is broken.",
]

const fallbackModels: ModelCatalogItem[] = [
  {
    id: "auto",
    label: "Auto",
    parameters: [],
    defaultParams: [],
  },
  {
    id: "composer-2",
    label: "Composer 2",
    parameters: [],
    defaultParams: [],
  },
]

const globalForSessions = globalThis as typeof globalThis & {
  __appBuilderSessions?: Map<string, BuilderSession>
}

const sessions = globalForSessions.__appBuilderSessions ?? new Map()
globalForSessions.__appBuilderSessions = sessions

export async function readPersistedCursorApiKey(): Promise<string | null> {
  const settings = await readPersistedSettings()
  const apiKey = settings.cursorApiKey?.trim()
  return apiKey || null
}

export async function savePersistedCursorApiKey(apiKey: string) {
  const settings = await readPersistedSettings()
  settings.cursorApiKey = apiKey
  await writePersistedSettings(settings)
}

export async function validateCursorApiKey(apiKey: string) {
  try {
    await Cursor.me({ apiKey })
  } catch {
    throw new InvalidCursorApiKeyError(
      "The Cursor API key could not be validated. Please check the key and try again."
    )
  }
}

export async function clearPersistedCursorApiKey() {
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

export async function createSession(apiKey: string): Promise<PublicSession> {
  const id = randomUUID()
  const projectPath = path.join(workspaceRoot, id, "app")
  const port = await getAvailablePort()
  const modelsPromise = listModels(apiKey)
  const userPromise = getCurrentUser(apiKey)
  const session: BuilderSession = {
    id,
    apiKey,
    models: fallbackModels,
    user: null,
    projectPath,
    port,
    previewUrl: `http://127.0.0.1:${port}`,
    logs: [],
    ready: Promise.resolve(),
  }

  sessions.set(id, session)
  const readyPromise = prepareSession(session).catch((error: unknown) => {
    const message = getErrorMessage(error)
    session.setupError = message
    session.logs.push(`[setup] ${message}`)
    throw error
  })
  session.ready = readyPromise
  const [models, user] = await Promise.all([
    modelsPromise,
    userPromise,
    readyPromise,
  ])
  session.models = models
  session.user = user

  return toPublicSession(session)
}

export async function restoreSession(
  sessionId: string,
  apiKey: string
): Promise<PublicSession> {
  const session = sessions.get(sessionId)

  if (!session) {
    throw new UnknownAppBuilderSessionError()
  }

  if (apiKey !== session.apiKey) {
    await updateSessionApiKey(session, apiKey)
  } else if (!session.user) {
    session.user = await getCurrentUser(apiKey)
  }

  await session.ready
  assertSessionReady(session)
  return toPublicSession(session)
}

export async function getPublicSession(id: string): Promise<PublicSession> {
  const session = getSession(id)
  await session.ready
  assertSessionReady(session)
  return toPublicSession(session)
}

export async function streamAgentResponse(
  sessionId: string,
  userMessage: string,
  model: string | undefined,
  emit: (event: AgentStreamEvent) => void
) {
  const session = getSession(sessionId)
  await session.ready
  assertSessionReady(session)

  const agent = await getOrCreateAgent(session)
  const modelSelection = model
    ? encodeLocalSdkModelSelection(parseModelSelection(model), session.models)
    : undefined
  const run = await agent.send(
    buildPrompt(userMessage, session),
    modelSelection ? { model: modelSelection } : undefined
  )

  for await (const event of run.stream()) {
    emitSdkMessage(event, emit)
  }

  await run.wait()
}

export async function generateProjectName(
  sessionId: string,
  context: string | ProjectNameContext
): Promise<string> {
  const session = getSession(sessionId)
  return generateProjectNameForApiKey(session.apiKey, context)
}

async function generateProjectNameForApiKey(
  apiKey: string,
  context: string | ProjectNameContext
): Promise<string> {
  const nameContext = normalizeProjectNameContext(context)
  if (!nameContext.prompt && !nameContext.messages.length) {
    throw new Error("Conversation context is required to generate a project name.")
  }

  try {
    const title = await promptProjectNameWithXml(apiKey, nameContext)

    if (title) {
      return title
    }
  } catch {
    // Naming is a convenience feature; use a local fallback when the model path fails.
  }

  const fallbackTitle = generateFallbackProjectName(nameContext)
  if (!fallbackTitle) {
    throw new Error("Could not generate a project name from this conversation.")
  }

  return fallbackTitle
}

async function promptProjectNameWithXml(
  apiKey: string,
  context: Required<ProjectNameContext>
) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new ProjectNameGenerationTimeoutError())
    }, getProjectNameTimeoutMs())
  })

  const agent = Agent.create({
    apiKey,
    model: { id: process.env.CURSOR_PROJECT_NAME_MODEL ?? "composer-2" },
  })

  try {
    const run = await agent.send(buildProjectNamePrompt(context))

    return await Promise.race([
      collectProjectNameRun(run, context),
      timeoutPromise,
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
    agent.close()
  }
}

async function collectProjectNameRun(
  run: Run,
  context: Required<ProjectNameContext>
) {
  let assistantText = ""

  for await (const event of run.stream()) {
    if (event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "text") {
          assistantText += block.text
        }
      }
    }
  }

  const result = await run.wait()
  const rawName = extractProjectNameXml(
    assistantText || result.result || generateFallbackProjectName(context)
  )
  const sanitized = sanitizeProjectName(rawName)
  return sanitized
}

function extractProjectNameXml(value: string) {
  return (
    value.match(/<projectName>\s*([\s\S]*?)\s*<\/projectName>/i)?.[1]?.trim() ??
    ""
  )
}

function getProjectNameTimeoutMs() {
  const value = Number(process.env.CURSOR_PROJECT_NAME_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_PROJECT_NAME_TIMEOUT_MS
}

function normalizeProjectNameContext(
  context: string | ProjectNameContext
): Required<ProjectNameContext> {
  if (typeof context === "string") {
    return {
      prompt: compactProjectNameContent(context),
      messages: [],
    }
  }

  const messages = (context.messages ?? [])
    .filter((message) => message.role === "assistant" || message.role === "user")
    .map((message) => ({
      role: message.role,
      content: compactProjectNameContent(message.content).slice(0, 600),
    }))
    .filter((message) => message.content)

  return {
    prompt: compactProjectNameContent(context.prompt ?? ""),
    messages: messages.slice(-16),
  }
}

function compactProjectNameContent(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function getSession(id: string) {
  const session = sessions.get(id)
  if (!session) {
    throw new UnknownAppBuilderSessionError()
  }
  return session
}

function buildProjectNamePrompt(context: Required<ProjectNameContext>) {
  const lines = [
    "You name app-builder projects.",
    "Create a concise sidebar project name for this app-building conversation.",
    "Rules:",
    "- Return exactly one XML tag: <projectName>Concise Name</projectName>.",
    "- The project name inside the tag must use 2 to 5 words.",
    "- No quotes, markdown, emoji, trailing punctuation, or generic words like Project inside the tag.",
    "- Do not include names, usernames, or email addresses.",
    "- Prefer nouns that describe the app being built.",
    "",
  ]

  if (context.messages.length > 0) {
    lines.push(
      "Conversation:",
      ...context.messages.map(
        (message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`
      )
    )
  } else {
    lines.push("Initial user request:", context.prompt.slice(0, 1200))
  }

  return lines.join("\n")
}

function sanitizeProjectName(value: string) {
  const firstLine = value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)

  if (!firstLine) {
    return ""
  }

  const cleaned = firstLine
    .replace(/^project\s*name\s*:\s*/i, "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "")
    .replace(/[`*_#>]+/g, "")
    .replace(/^[-\s"']+|[-\s"'.:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()

  if (!cleaned) {
    return ""
  }

  const words = cleaned.split(" ").slice(0, 5).join(" ")
  return words.length > 42 ? `${words.slice(0, 39).trim()}...` : words
}

function generateFallbackProjectName(context: Required<ProjectNameContext>) {
  const source =
    context.messages.find((message) => message.role === "user")?.content ??
    context.prompt
  const cleaned = sanitizeProjectName(
    source
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/[`*_#>]+/g, "")
      .replace(/[^a-z0-9\s-]/gi, " ")
      .replace(/\b(?:a|an|and|app|application|build|create|for|i|me|my|of|please|project|the|to|want|with)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
  )

  return cleaned || "Untitled App"
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
        typeof parsed.cursorApiKey === "string"
          ? parsed.cursorApiKey
          : undefined,
    }
  } catch (error) {
    if (isNodeFileError(error) && error.code === "ENOENT") {
      return {}
    }

    return {}
  }
}

async function writePersistedSettings(settings: PersistedSettings) {
  await fs.mkdir(appBuilderRoot, { recursive: true })
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  })
  await fs.chmod(settingsPath, 0o600).catch(() => {})
}

function isNodeFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function toPublicSession(session: BuilderSession): PublicSession {
  return {
    id: session.id,
    previewUrl: session.previewUrl,
    projectPath: session.projectPath,
    models: session.models,
    user: session.user,
  }
}

async function updateSessionApiKey(session: BuilderSession, apiKey: string) {
  session.apiKey = apiKey
  session.agent = undefined

  const [models, user] = await Promise.all([
    listModels(apiKey),
    getCurrentUser(apiKey),
  ])
  session.models = models
  session.user = user
}

async function getCurrentUser(apiKey: string): Promise<PublicUser | null> {
  try {
    const user = asRecord(await Cursor.me({ apiKey }))
    const name =
      firstString(user, ["name", "displayName", "username"]) ??
      firstString(user, ["apiKeyName", "userEmail"]) ??
      "Cursor user"
    const email = firstString(user, ["email", "userEmail"])

    return {
      name,
      email,
    }
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

function firstString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }

  return undefined
}

async function listModels(apiKey: string): Promise<ModelCatalogItem[]> {
  try {
    const models = await Cursor.models.list({ apiKey })
    const catalog = sanitizeModelCatalog(models.map(modelToCatalogItem))
    return catalog.length > 0 ? catalog : fallbackModels
  } catch {
    return fallbackModels
  }
}

function modelToCatalogItem(model: SDKModel): ModelCatalogItem {
  return {
    id: model.id,
    label: model.displayName || model.id,
    description: model.description,
    parameters: buildModelParameters(model),
    defaultParams: getDefaultModelParams(model),
  }
}

function buildModelParameters(model: SDKModel): ModelParameterConfig[] {
  const parameters = new Map<string, ModelParameterConfig>()

  for (const parameter of model.parameters ?? []) {
    parameters.set(parameter.id, {
      id: parameter.id,
      label: parameter.displayName || labelFromId(parameter.id),
      values: parameter.values.map((value) => ({
        id: value.value,
        label: value.displayName || labelFromId(value.value),
      })),
    })
  }

  for (const variant of model.variants ?? []) {
    for (const param of variant.params) {
      const parameter = parameters.get(param.id) ?? {
        id: param.id,
        label: labelFromId(param.id),
        values: [],
      }

      if (!parameter.values.some((value) => value.id === param.value)) {
        parameter.values.push({
          id: param.value,
          label: labelFromId(param.value),
        })
      }

      parameters.set(param.id, parameter)
    }
  }

  return Array.from(parameters.values()).filter(
    (parameter) => parameter.values.length > 0
  )
}

function getDefaultModelParams(model: SDKModel): ModelParamConfig[] {
  const defaultVariant =
    model.variants?.find((variant) => variant.isDefault) ?? model.variants?.[0]

  return (defaultVariant?.params ?? []).map((param) => ({
    id: param.id,
    value: param.value,
  }))
}

function sanitizeModelCatalog(models: ModelCatalogItem[]) {
  const byId = new Map<string, ModelCatalogItem>()
  for (const model of models) {
    if (!byId.has(model.id)) {
      byId.set(model.id, model)
    }
  }

  return Array.from(byId.values())
}

function labelFromId(id: string) {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function parseModelSelection(value: string): ModelSelection {
  try {
    const parsed = JSON.parse(value) as Partial<ModelSelection>
    if (typeof parsed.id === "string") {
      return {
        id: parsed.id,
        params: Array.isArray(parsed.params) ? parsed.params : undefined,
      }
    }
  } catch {}

  return { id: fallbackModels[0].id }
}

function encodeLocalSdkModelSelection(
  selection: ModelSelection,
  models: ModelCatalogItem[]
): ModelSelection {
  if (!selection.params?.length && isEncodedLocalModelId(selection.id)) {
    return { id: selection.id }
  }

  const model = models.find((item) => item.id === selection.id)
  const config = getSelectedModelConfig(selection, model)
  const modelKey = normalizeModelToken(
    `${selection.id} ${model?.label ?? ""}`
  )
  const encodedId =
    encodeKnownLocalModelId(modelKey, selection.id, config) ?? selection.id

  // Local runtime expects variant configuration encoded into the model id.
  return { id: encodedId }
}

function isEncodedLocalModelId(id: string) {
  return (
    /^gpt-5\.4-(none|low|medium|high|xhigh)(-fast)?$/.test(id) ||
    /^gpt-5\.3-codex(-(low|high|xhigh))?(-fast)?$/.test(id) ||
    /^claude-4\.6-sonnet-(medium|high)(-thinking)?$/.test(id) ||
    /^claude-4\.6-opus-(high|max)(-thinking)?(-fast)?$/.test(id)
  )
}

function encodeKnownLocalModelId(
  modelKey: string,
  fallbackId: string,
  config: SelectedModelConfig
) {
  if (modelKey.includes("gpt54") || modelKey.includes("gpt5.4")) {
    const effort = config.effort ?? "medium"
    const supportsFast = ["medium", "high", "xhigh"].includes(effort)
    return `gpt-5.4-${effort}${config.fast && supportsFast ? "-fast" : ""}`
  }

  if (modelKey.includes("gpt53codex") || modelKey.includes("gpt5.3codex")) {
    const effort = config.effort ?? "medium"
    const effortSuffix = effort === "medium" ? "" : `-${effort}`
    const supportsFast = ["medium", "high", "xhigh"].includes(effort)
    return `gpt-5.3-codex${effortSuffix}${
      config.fast && supportsFast ? "-fast" : ""
    }`
  }

  if (modelKey.includes("claude46sonnet") || modelKey.includes("claude4.6sonnet")) {
    const effort = config.effort === "high" ? "high" : "medium"
    return `claude-4.6-sonnet-${effort}${config.thinking ? "-thinking" : ""}`
  }

  if (modelKey.includes("claude46opus") || modelKey.includes("claude4.6opus")) {
    const effort = config.effort === "max" ? "max" : "high"
    const supportsVariants = effort === "high"
    return `claude-4.6-opus-${effort}${
      config.thinking && supportsVariants ? "-thinking" : ""
    }${config.fast && supportsVariants ? "-fast" : ""}`
  }

  return fallbackId
}

type SelectedModelConfig = {
  effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max"
  fast: boolean
  thinking: boolean
}

function getSelectedModelConfig(
  selection: ModelSelection,
  model: ModelCatalogItem | undefined
): SelectedModelConfig {
  const config: SelectedModelConfig = { fast: false, thinking: false }

  for (const param of selection.params ?? []) {
    const parameter = model?.parameters.find((item) => item.id === param.id)
    const value = parameter?.values.find((item) => item.id === param.value)
    const parameterKey = normalizeModelToken(
      `${param.id} ${parameter?.label ?? ""}`
    )
    const valueKey = normalizeModelToken(`${param.value} ${value?.label ?? ""}`)
    const effort = getEffortValue(valueKey)

    if (effort) {
      config.effort = effort
    }

    if (isEnabledVariant(parameterKey, valueKey, "fast")) {
      config.fast = true
    }

    if (isEnabledVariant(parameterKey, valueKey, "thinking")) {
      config.thinking = true
    }
  }

  return config
}

function getEffortValue(valueKey: string): SelectedModelConfig["effort"] {
  if (valueKey.includes("none")) {
    return "none"
  }

  if (valueKey.includes("xhigh") || valueKey.includes("extrahigh")) {
    return "xhigh"
  }

  if (valueKey.includes("max")) {
    return "max"
  }

  if (valueKey.includes("high")) {
    return "high"
  }

  if (valueKey.includes("medium")) {
    return "medium"
  }

  if (valueKey.includes("low")) {
    return "low"
  }

  return undefined
}

function isEnabledVariant(
  parameterKey: string,
  valueKey: string,
  variant: "fast" | "thinking"
) {
  if (!parameterKey.includes(variant) && !valueKey.includes(variant)) {
    return false
  }

  return !isFalseValue(valueKey)
}

function isFalseValue(valueKey: string) {
  return (
    valueKey.includes("false") ||
    valueKey.includes("off") ||
    valueKey.includes("disabled") ||
    valueKey.includes("disable") ||
    valueKey.includes("no")
  )
}

function normalizeModelToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, "")
}

async function prepareSession(session: BuilderSession) {
  await fs.mkdir(session.projectPath, { recursive: true })
  await writeGeneratedApp(session.projectPath)
  await runCommand("pnpm", ["install"], session)
  await startDevServer(session)
}

async function writeGeneratedApp(projectPath: string) {
  await Promise.all(
    generatedAppFiles.map(async (file) => {
      const filePath = path.join(projectPath, file.path)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, file.content)
    })
  )
}

async function startDevServer(session: BuilderSession) {
  if (session.devProcess && !session.devProcess.killed) {
    return
  }

  const child = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(session.port),
      "--strictPort",
    ],
    {
      cwd: session.projectPath,
      env: { ...process.env, BROWSER: "none" },
      shell: false,
    }
  )

  session.devProcess = child
  pipeProcessLogs(child, session, "vite")

  child.once("exit", (code) => {
    session.logs.push(`vite exited with code ${code ?? "unknown"}`)
    session.devProcess = undefined
  })

  await waitForPort(session.port)
}

function runCommand(
  command: string,
  args: string[],
  session: BuilderSession
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: session.projectPath,
      env: { ...process.env, CI: "1" },
      shell: false,
    })

    pipeProcessLogs(child, session, command)

    child.once("error", reject)
    child.once("exit", (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${
            code ?? "unknown"
          }`
        )
      )
    })
  })
}

function pipeProcessLogs(
  child: ChildProcess,
  session: BuilderSession,
  label: string
) {
  const append = (chunk: Buffer) => {
    session.logs.push(`[${label}] ${chunk.toString()}`)
    session.logs.splice(0, Math.max(0, session.logs.length - 200))
  }

  child.stdout?.on("data", append)
  child.stderr?.on("data", append)
}

function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1")
      socket.once("connect", () => {
        socket.end()
        resolve()
      })
      socket.once("error", () => {
        socket.destroy()
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for preview server on ${port}.`))
          return
        }
        setTimeout(attempt, 250)
      })
    }

    attempt()
  })
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Could not allocate a preview port."))
          return
        }

        resolve(address.port)
      })
    })
  })
}

async function getOrCreateAgent(session: BuilderSession) {
  assertSessionReady(session)

  if (session.agent) {
    return session.agent
  }

  session.agent = await Agent.create({
    apiKey: session.apiKey,
    model: { id: process.env.CURSOR_MODEL ?? "composer-2" },
    local: {
      cwd: session.projectPath,
      envVars: {
        BROWSER: "none",
      },
    },
  })

  return session.agent
}

function assertSessionReady(session: BuilderSession) {
  if (session.setupError) {
    throw new Error(`Preview setup failed: ${session.setupError}`)
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function buildPrompt(userMessage: string, session: BuilderSession) {
  return [
    ...APP_BUILDER_INSTRUCTIONS,
    "",
    `Preview URL: ${session.previewUrl}`,
    `Workspace: ${session.projectPath}`,
    "",
    "User request:",
    userMessage,
  ].join("\n")
}

function emitSdkMessage(
  event: SDKMessage,
  emit: (event: AgentStreamEvent) => void
) {
  switch (event.type) {
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text") {
          emit({ type: "assistant_delta", text: block.text })
        } else {
          emit({
            type: "tool_call",
            callId: block.id,
            name: block.name,
            status: "requested",
            args: block.input,
          })
        }
      }
      break
    case "thinking": {
      const thinkingId =
        "id" in event && typeof event.id === "string" ? event.id : undefined
      emit({ type: "thinking", id: thinkingId, text: event.text })
      break
    }
    case "tool_call":
      emit({
        type: "tool_call",
        callId: event.call_id,
        name: event.name,
        status: event.status,
        args: event.args,
        truncatedArgs: event.truncated?.args,
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
