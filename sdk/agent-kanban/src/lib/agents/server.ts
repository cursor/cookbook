import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { Agent, Cursor } from "@cursor/sdk"

import type {
  AgentCard,
  AgentListResponse,
  ArtifactPreview,
  CreateAgentInput,
  CreateAgentResponse,
  ModelOption,
  PublicSession,
  PublicUser,
  RepositoryOption,
} from "./types"

type Settings = {
  cursorApiKey?: string
}

type Session = {
  id: string
  apiKey: string
  user: PublicUser | null
}

type UnknownRecord = Record<string, unknown>

type SdkAgentLike = UnknownRecord & {
  id?: string
  send?: (prompt: string) => Promise<unknown>
  listArtifacts?: () => Promise<unknown>
  downloadArtifact?: (artifactPath: string) => Promise<unknown>
  [Symbol.asyncDispose]?: () => Promise<void>
}

type AgentNamespace = {
  list?: (options: UnknownRecord) => Promise<unknown>
  listRuns?: (agentId: string, options?: UnknownRecord) => Promise<unknown>
  create: (options: UnknownRecord) => Promise<SdkAgentLike>
  get?: (id: string, options?: UnknownRecord) => Promise<unknown>
  resume?: (id: string, options?: UnknownRecord) => Promise<SdkAgentLike>
}

type CursorNamespace = typeof Cursor & {
  repositories?: {
    list: (options: UnknownRecord) => Promise<unknown>
  }
}

type RepositoryCacheEntry = {
  loadedAt: number
  repositories: RepositoryOption[]
  rawById: Map<string, unknown>
}

type RunSummary = {
  id?: string
  status?: string
  createdAt?: string
  durationMs?: number
  result?: string
  branch?: string
  prUrl?: string
  repoUrl?: string
}

const settingsDir = path.join(os.homedir(), ".agent-kanban")
const settingsPath = path.join(settingsDir, "settings.json")
const repositoryCacheTtlMs = 55_000

const globalForAgentKanban = globalThis as typeof globalThis & {
  __agentKanbanSessions?: Map<string, Session>
  __agentKanbanRepositoryCache?: Map<string, RepositoryCacheEntry>
}

const sessions =
  globalForAgentKanban.__agentKanbanSessions ?? new Map<string, Session>()
globalForAgentKanban.__agentKanbanSessions = sessions

const repositoryCache =
  globalForAgentKanban.__agentKanbanRepositoryCache ??
  new Map<string, RepositoryCacheEntry>()
globalForAgentKanban.__agentKanbanRepositoryCache = repositoryCache

const agentSdk = Agent as unknown as AgentNamespace
const cursorSdk = Cursor as CursorNamespace

export class MissingCursorApiKeyError extends Error {
  readonly code = "missing_api_key"

  constructor(message = "Enter a Cursor API key to continue.") {
    super(message)
    this.name = "MissingCursorApiKeyError"
  }
}

export class InvalidCursorApiKeyError extends Error {
  readonly code = "invalid_api_key"

  constructor(message = "The Cursor API key could not be validated.") {
    super(message)
    this.name = "InvalidCursorApiKeyError"
  }
}

export class UnknownSessionError extends Error {
  readonly code = "unknown_session"

  constructor(message = "This Agent Kanban session has expired.") {
    super(message)
    this.name = "UnknownSessionError"
  }
}

export function publicSession(session: Session): PublicSession {
  return {
    id: session.id,
    user: session.user,
    hasPersistedKey: false,
  }
}

export async function createSession(
  apiKey: string,
  remember: boolean
): Promise<PublicSession> {
  const trimmedKey = apiKey.trim()
  await validateCursorApiKey(trimmedKey)

  if (remember) {
    await writeSettings({ cursorApiKey: trimmedKey })
  }

  const session: Session = {
    id: randomUUID(),
    apiKey: trimmedKey,
    user: await getCurrentUser(trimmedKey),
  }
  sessions.set(session.id, session)

  return {
    ...publicSession(session),
    hasPersistedKey: remember,
  }
}

export async function restoreSession(sessionId?: string): Promise<PublicSession> {
  if (sessionId) {
    const existing = sessions.get(sessionId)
    if (existing) {
      return publicSession(existing)
    }
  }

  const persistedApiKey = (await readSettings()).cursorApiKey?.trim()
  if (!persistedApiKey) {
    throw new MissingCursorApiKeyError()
  }

  await validateCursorApiKey(persistedApiKey)

  const session: Session = {
    id: randomUUID(),
    apiKey: persistedApiKey,
    user: await getCurrentUser(persistedApiKey),
  }
  sessions.set(session.id, session)

  return {
    ...publicSession(session),
    hasPersistedKey: true,
  }
}

export async function clearPersistedKey() {
  await writeSettings({})
}

export async function requireSession(request: Request): Promise<Session> {
  const sessionId =
    request.headers.get("x-agent-kanban-session")?.trim() ??
    getCookie(request, "agent-kanban-session")?.trim()
  if (!sessionId) {
    throw new MissingCursorApiKeyError()
  }

  const session = sessions.get(sessionId)
  if (session) {
    return session
  }

  const restored = await restoreSession(sessionId)
  const restoredSession = sessions.get(restored.id)
  if (!restoredSession) {
    throw new UnknownSessionError()
  }

  return restoredSession
}

function getCookie(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? ""
  const prefix = `${name}=`
  const match = cookies
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(prefix))

  return match ? decodeURIComponent(match.slice(prefix.length)) : undefined
}

export async function listCloudAgents(
  apiKey: string,
  options: {
    cursor?: string
    includeArchived?: boolean
    limit?: number
    prUrl?: string
  } = {}
): Promise<AgentListResponse> {
  if (!agentSdk.list) {
    throw new Error("This version of @cursor/sdk does not support Agent.list.")
  }

  const response = await agentSdk.list({
    apiKey,
    runtime: "cloud",
    limit: options.limit ?? 50,
    cursor: options.cursor,
    prUrl: options.prUrl,
    includeArchived: options.includeArchived ?? false,
  })
  const rawAgents = extractArray(response, ["agents", "items", "data", "results"])

  const agents = await Promise.all(
    rawAgents.map(async (rawAgent) => {
      const card = normalizeAgent(rawAgent)
      const [runs, artifacts] = await Promise.all([
        listRunsForAgent(apiKey, card.id).catch(() => []),
        listArtifactsForAgent(apiKey, card.id).catch(() => []),
      ])
      enrichAgentCardFromRuns(card, runs)
      card.artifacts = artifacts
      return card
    })
  )

  return {
    agents,
    nextCursor: firstString(asRecord(response), [
      "nextCursor",
      "next_cursor",
      "cursor",
    ]),
  }
}

export async function createCloudAgent(
  apiKey: string,
  input: CreateAgentInput
): Promise<CreateAgentResponse> {
  const prompt = input.prompt.trim()
  if (!prompt) {
    throw new Error("A prompt is required to create a cloud agent.")
  }

  const repository = await resolveRepository(apiKey, input.repositoryId)
  const cloudRepository = {
    url: repository.url,
    ...(input.branch?.trim() ? { startingRef: input.branch.trim() } : {}),
  }

  const createdAgent = await agentSdk.create({
    apiKey,
    name: input.name?.trim() || prompt.slice(0, 80),
    ...(input.modelId && input.modelId !== "auto"
      ? { model: { id: input.modelId } }
      : {}),
    cloud: {
      repos: [cloudRepository],
      autoCreatePR: input.autoCreatePR ?? true,
    },
  })

  if (createdAgent.send) {
    await createdAgent.send(prompt)
  }

  const card = normalizeAgent(createdAgent)
  card.repository = repository.label
  card.repositoryUrl = repository.url
  card.branch = input.branch?.trim() || repository.defaultBranch
  card.latestMessage = prompt
  card.artifacts = await listArtifactsForAgent(apiKey, card.id).catch(() => [])

  return { agent: card }
}

export async function listModels(apiKey: string): Promise<ModelOption[]> {
  try {
    const models = await Cursor.models.list({ apiKey })
    return extractArray(models, ["models", "items", "data"]).flatMap((model) => {
      const normalized = normalizeModel(model)
      return normalized ? [normalized] : []
    })
  } catch {
    return []
  }
}

export async function listRepositories(
  apiKey: string
): Promise<RepositoryOption[]> {
  const cache = repositoryCache.get(apiKey)
  if (cache && Date.now() - cache.loadedAt < repositoryCacheTtlMs) {
    return cache.repositories
  }

  if (!cursorSdk.repositories?.list) {
    return []
  }

  const response = await cursorSdk.repositories.list({ apiKey })
  const rawRepositories = extractArray(response, [
    "repositories",
    "repos",
    "items",
    "data",
  ])
  const rawById = new Map<string, unknown>()
  const repositories = rawRepositories
    .map((rawRepository) => normalizeRepository(rawRepository))
    .filter((repository): repository is RepositoryOption => Boolean(repository))

  for (const repository of repositories) {
    rawById.set(repository.id, repository)
    rawById.set(repository.url, repository)
  }

  repositoryCache.set(apiKey, {
    loadedAt: Date.now(),
    repositories,
    rawById,
  })

  return repositories
}

export async function listArtifactsForAgent(
  apiKey: string,
  agentId: string
): Promise<ArtifactPreview[]> {
  const agent = await attachAgent(apiKey, agentId)
  if (!agent.listArtifacts) {
    return []
  }

  const response = await agent.listArtifacts()
  const rawArtifacts = extractArray(response, [
    "artifacts",
    "items",
    "files",
    "data",
  ])

  const previews = rawArtifacts
    .map((rawArtifact) => withArtifactMediaUrl(agentId, normalizeArtifact(rawArtifact)))
    .sort(compareArtifactPreviews)
    .slice(0, 4)

  await disposeAgent(agent)
  return previews
}

export async function listRunsForAgent(
  apiKey: string,
  agentId: string
): Promise<RunSummary[]> {
  if (!agentSdk.listRuns) {
    return []
  }

  const response = await agentSdk.listRuns(agentId, {
    runtime: "cloud",
    apiKey,
    limit: 10,
  })
  const rawRuns = extractArray(response, ["items", "runs", "data", "results"])

  return rawRuns.map(normalizeRun)
}

export async function downloadArtifact(
  apiKey: string,
  agentId: string,
  artifactPath: string
): Promise<{ downloadUrl?: string }> {
  const agent = await attachAgent(apiKey, agentId)
  if (!agent.downloadArtifact) {
    return {}
  }

  const response = await agent.downloadArtifact(artifactPath)
  await disposeAgent(agent)

  if (typeof response === "string") {
    return { downloadUrl: response }
  }

  const record = asRecord(response)
  return {
    downloadUrl: firstString(record, [
      "downloadUrl",
      "url",
      "href",
      "presignedUrl",
    ]),
  }
}

export async function readArtifactContent(
  apiKey: string,
  agentId: string,
  artifactPath: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const agent = await attachAgent(apiKey, agentId)
  if (!agent.downloadArtifact) {
    throw new Error("This agent does not support artifact downloads.")
  }

  try {
    const response = await agent.downloadArtifact(artifactPath)

    if (typeof response === "string") {
      const artifactResponse = await fetch(response)
      if (!artifactResponse.ok) {
        throw new Error("Artifact download URL returned an error.")
      }

      return {
        bytes: new Uint8Array(await artifactResponse.arrayBuffer()),
        contentType: sanitizeArtifactContentType(
          artifactResponse.headers.get("content-type"),
          artifactPath
        ),
      }
    }

    if (response instanceof ArrayBuffer) {
      return {
        bytes: new Uint8Array(response),
        contentType: contentTypeForArtifactPath(artifactPath),
      }
    }

    if (response instanceof Uint8Array) {
      return {
        bytes: response,
        contentType: contentTypeForArtifactPath(artifactPath),
      }
    }

    if (response instanceof Blob) {
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: sanitizeArtifactContentType(response.type, artifactPath),
      }
    }
  } finally {
    await disposeAgent(agent)
  }

  throw new Error("Unsupported artifact download response.")
}

async function validateCursorApiKey(apiKey: string) {
  if (!apiKey || !apiKey.startsWith("crsr_")) {
    throw new InvalidCursorApiKeyError(
      "Cursor API keys start with crsr_. Please check the key and try again."
    )
  }

  try {
    await Cursor.me({ apiKey })
  } catch {
    throw new InvalidCursorApiKeyError(
      "The Cursor API key could not be validated. Please check the key and try again."
    )
  }
}

async function getCurrentUser(apiKey: string): Promise<PublicUser | null> {
  try {
    const user = asRecord(await Cursor.me({ apiKey }))
    const name =
      firstString(user, ["name", "displayName", "username"]) ??
      firstString(user, ["email"]) ??
      "Cursor user"
    return {
      name,
      email: firstString(user, ["email"]),
    }
  } catch {
    return null
  }
}

async function resolveRepository(
  apiKey: string,
  repositoryId: string
): Promise<RepositoryOption> {
  const repositories = await listRepositories(apiKey)
  const selected =
    repositories.find((repository) => repository.id === repositoryId) ??
    repositories.find((repository) => repository.url === repositoryId)

  if (selected) {
    return selected
  }

  const fallbackUrl = normalizeRepositoryUrl(repositoryId)
  if (fallbackUrl) {
    return {
      id: fallbackUrl,
      label: labelFromRepositoryUrl(fallbackUrl),
      url: fallbackUrl,
    }
  }

  throw new Error("Select a repository before creating an agent.")
}

async function attachAgent(apiKey: string, agentId: string): Promise<SdkAgentLike> {
  if (agentSdk.resume) {
    return agentSdk.resume(agentId, { apiKey })
  }

  if (agentSdk.get) {
    return asRecord(await agentSdk.get(agentId, { apiKey })) as SdkAgentLike
  }

  throw new Error("This version of @cursor/sdk cannot attach to cloud agents.")
}

async function disposeAgent(agent: SdkAgentLike) {
  await agent[Symbol.asyncDispose]?.().catch(() => undefined)
}

async function readSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(settingsPath, "utf8")
    return JSON.parse(raw) as Settings
  } catch (error) {
    if (isNodeFileError(error) && error.code === "ENOENT") {
      return {}
    }
    throw error
  }
}

async function writeSettings(settings: Settings) {
  await fs.mkdir(settingsDir, { recursive: true })
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
}

function normalizeAgent(rawAgent: unknown): AgentCard {
  const record = asRecord(rawAgent)
  const id =
    firstString(record, ["id", "agentId", "uuid"]) ?? `agent-${randomUUID()}`
  const status =
    normalizeAgentStatus(record) ?? normalizeAgentStatus(asRecord(record.latestRun))
  const repositoryRecord = firstRecord(record, ["repository", "repo", "cloud"])
  const repoString = firstStringFromArray(record.repos)
  const repositoryUrl =
    firstString(record, ["repositoryUrl", "repoUrl"]) ??
    firstString(repositoryRecord, ["url", "htmlUrl", "remoteUrl"]) ??
    normalizeRepositoryListUrl(repoString)
  const repository =
    firstString(record, ["repository", "repo", "repoName"]) ??
    firstString(repositoryRecord, ["fullName", "name", "slug"]) ??
    (repoString ? labelFromRepositoryString(repoString) : undefined) ??
    (repositoryUrl ? labelFromRepositoryUrl(repositoryUrl) : "No repository")
  const userRecord = firstRecord(record, ["createdBy", "user", "owner"])
  const createdAt = firstTimestamp(record, ["createdAt", "created_at"])
  const updatedAt =
    firstTimestamp(record, ["lastModified", "updatedAt", "updated_at", "lastActivityAt"]) ??
    firstTimestamp(asRecord(record.latestRun), ["updatedAt", "completedAt"])

  return {
    id,
    title:
      firstString(record, ["name", "title", "summary"]) ?? `Agent ${id.slice(0, 8)}`,
    status: status ?? (record.archived === true ? "archived" : "no_status"),
    latestRunId: undefined,
    durationMs: undefined,
    repository,
    repositoryUrl,
    branch:
      firstString(record, ["branch", "startingRef", "ref"]) ??
      firstString(repositoryRecord, ["branch", "startingRef", "defaultBranch"]),
    createdBy:
      firstString(userRecord, ["name", "email", "username"]) ??
      firstString(record, ["createdBy"]),
    createdAt,
    updatedAt,
    prUrl:
      firstString(record, ["prUrl", "pullRequestUrl"]) ??
      firstString(asRecord(record.pullRequest), ["url", "htmlUrl"]),
    latestMessage:
      firstString(record, ["latestMessage", "lastMessage", "prompt", "description"]) ??
      firstString(asRecord(record.latestRun), ["summary", "statusText"]),
    artifacts: [],
  }
}

function enrichAgentCardFromRuns(card: AgentCard, runs: RunSummary[]) {
  const latestRun = runs[0]
  if (!latestRun) {
    return
  }

  if (card.status !== "archived" && latestRun.status) {
    card.status = latestRun.status
  }

  card.latestRunId = latestRun.id
  card.durationMs = latestRun.durationMs
  card.updatedAt = card.updatedAt ?? latestRun.createdAt
  card.latestMessage = card.latestMessage ?? latestRun.result

  if (latestRun.branch) {
    card.branch = latestRun.branch
  }

  if (latestRun.prUrl) {
    card.prUrl = latestRun.prUrl
  }

  if (latestRun.repoUrl) {
    card.repositoryUrl = normalizeRepositoryListUrl(latestRun.repoUrl)
    card.repository = labelFromRepositoryString(latestRun.repoUrl)
  }
}

function normalizeRun(rawRun: unknown): RunSummary {
  const record = asRecord(rawRun)
  const gitRecord = asRecord(record.git ?? record._git)
  const branchRecord = firstRecordFromArray(gitRecord.branches)

  return {
    id: firstString(record, ["id", "runId"]),
    status: normalizeAgentStatus(record),
    createdAt: firstTimestamp(record, ["createdAt", "created_at"]),
    durationMs: firstNumber(record, ["durationMs", "_durationMs"]),
    result: firstString(record, ["result", "_result"]),
    branch: firstString(branchRecord, ["branch", "name"]),
    prUrl: firstString(branchRecord, ["prUrl", "pullRequestUrl"]),
    repoUrl: firstString(branchRecord, ["repoUrl", "repositoryUrl"]),
  }
}

function normalizeAgentStatus(record: UnknownRecord) {
  const rawStatus = firstString(record, [
    "status",
    "_status",
    "state",
    "lifecycleStatus",
    "runStatus",
    "agentStatus",
  ])

  if (!rawStatus) {
    return undefined
  }

  const normalized = rawStatus.toLowerCase()
  if (["unknown", "undefined", "null"].includes(normalized)) {
    return undefined
  }

  return rawStatus
}

function normalizeArtifact(rawArtifact: unknown): ArtifactPreview {
  const record = asRecord(rawArtifact)
  const artifactPath =
    firstString(record, ["path", "name", "filename", "filePath"]) ?? "artifact"
  const name = artifactPath.split("/").filter(Boolean).at(-1) ?? artifactPath
  const contentType = firstString(record, [
    "contentType",
    "mimeType",
    "type",
  ])
  const previewKind = getArtifactPreviewKind(artifactPath, contentType)

  return {
    path: artifactPath,
    name,
    size: firstNumber(record, ["size", "bytes", "contentLength"]),
    contentType,
    previewKind,
  }
}

function withArtifactMediaUrl(
  agentId: string,
  artifact: ArtifactPreview
): ArtifactPreview {
  if (artifact.previewKind === "file") {
    return artifact
  }

  return {
    ...artifact,
    mediaUrl: `/api/agents/${encodeURIComponent(
      agentId
    )}/artifacts/media?path=${encodeURIComponent(artifact.path)}`,
  }
}

function compareArtifactPreviews(a: ArtifactPreview, b: ArtifactPreview) {
  return artifactRank(a) - artifactRank(b)
}

function artifactRank(artifact: ArtifactPreview) {
  if (artifact.previewKind === "video") {
    return 0
  }
  if (artifact.previewKind === "image") {
    return 1
  }
  return 2
}

function normalizeModel(rawModel: unknown): ModelOption | null {
  const record = asRecord(rawModel)
  const id = firstString(record, ["id", "name"])
  if (!id) {
    return null
  }

  return {
    id,
    label: firstString(record, ["displayName", "label", "name"]) ?? id,
    description: firstString(record, ["description"]),
  }
}

function normalizeRepository(rawRepository: unknown): RepositoryOption | null {
  const record = asRecord(rawRepository)
  const url =
    normalizeRepositoryUrl(firstString(record, ["url", "htmlUrl", "remoteUrl"])) ??
    normalizeRepositoryUrl(firstString(record, ["cloneUrl", "sshUrl"]))
  if (!url) {
    return null
  }

  const label =
    firstString(record, ["fullName", "slug", "label", "name"]) ??
    labelFromRepositoryUrl(url)
  const [owner, name] = label.includes("/")
    ? label.split("/", 2)
    : labelFromRepositoryUrl(url).split("/", 2)

  return {
    id: firstString(record, ["id"]) ?? url,
    label,
    url,
    owner,
    name,
    defaultBranch: firstString(record, [
      "defaultBranch",
      "default_branch",
      "branch",
    ]),
  }
}

function extractArray(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) {
    return value
  }

  const record = asRecord(value)
  for (const key of keys) {
    const candidate = record[key]
    if (Array.isArray(candidate)) {
      return candidate
    }
  }

  return []
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {}
}

function firstRecord(record: UnknownRecord, keys: string[]): UnknownRecord {
  for (const key of keys) {
    const value = record[key]
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as UnknownRecord
    }
  }
  return {}
}

function firstRecordFromArray(value: unknown): UnknownRecord {
  if (!Array.isArray(value)) {
    return {}
  }

  const record = value.find(
    (item): item is UnknownRecord =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
  )

  return record ?? {}
}

function firstString(
  record: UnknownRecord,
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

function firstNumber(
  record: UnknownRecord,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

function firstTimestamp(
  record: UnknownRecord,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value).toISOString()
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function firstStringFromArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  return value.find(
    (item): item is string => typeof item === "string" && Boolean(item.trim())
  )
}

function normalizeRepositoryUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  const trimmed = value.trim().replace(/\.git$/, "")
  const sshMatch = trimmed.match(/^git@github\.com:(.+\/.+)$/)
  const sshUrlMatch = trimmed.match(/^ssh:\/\/git@github\.com\/(.+\/.+)$/)
  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/(.+\/.+)$/)
  const repoPath = sshMatch?.[1] ?? sshUrlMatch?.[1] ?? httpsMatch?.[1]
  return repoPath ? `https://github.com/${repoPath}` : undefined
}

function normalizeRepositoryListUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  const trimmed = value.trim().replace(/\.git$/, "")
  if (/^https:\/\/github\.com\/.+\/.+/.test(trimmed)) {
    return trimmed
  }
  if (/^github\.com\/.+\/.+/.test(trimmed)) {
    return `https://${trimmed}`
  }
  if (/^[^/]+\/[^/]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}`
  }

  return normalizeRepositoryUrl(trimmed)
}

function labelFromRepositoryUrl(url: string) {
  return url.replace(/^https:\/\/github\.com\//, "")
}

function labelFromRepositoryString(value: string) {
  return value
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
}

const SAFE_ARTIFACT_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
])

function sanitizeArtifactContentType(
  raw: string | null | undefined,
  artifactPath: string
): string {
  if (raw) {
    const mimeType = raw.split(";")[0].trim().toLowerCase()
    if (SAFE_ARTIFACT_CONTENT_TYPES.has(mimeType)) {
      return mimeType
    }
  }
  return contentTypeForArtifactPath(artifactPath)
}

function getArtifactPreviewKind(
  artifactPath: string,
  contentType?: string
): ArtifactPreview["previewKind"] {
  if (
    contentType?.startsWith("video/") ||
    /\.(mov|mp4|m4v|webm)$/i.test(artifactPath)
  ) {
    return "video"
  }

  if (contentType?.startsWith("image/")) {
    return "image"
  }

  if (/\.(avif|gif|jpe?g|png|svg|webp)$/i.test(artifactPath)) {
    return "image"
  }

  return "file"
}

function contentTypeForArtifactPath(artifactPath: string) {
  const normalized = artifactPath.toLowerCase()
  if (normalized.endsWith(".mp4") || normalized.endsWith(".m4v")) {
    return "video/mp4"
  }
  if (normalized.endsWith(".mov")) {
    return "video/quicktime"
  }
  if (normalized.endsWith(".webm")) {
    return "video/webm"
  }
  if (normalized.endsWith(".png")) {
    return "image/png"
  }
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg"
  }
  if (normalized.endsWith(".webp")) {
    return "image/webp"
  }
  if (normalized.endsWith(".gif")) {
    return "image/gif"
  }
  return "application/octet-stream"
}

function isNodeFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
