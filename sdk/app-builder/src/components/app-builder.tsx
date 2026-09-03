"use client"

import {
  FormEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  ArrowRightIcon as ArrowRight,
  BrainIcon as Brain,
  CaretDownIcon as CaretDown,
  CubeIcon as Cube,
  FileTextIcon as FileText,
  FilesIcon as Files,
  FlaskIcon as FlaskConical,
  GearIcon as Settings,
  HammerIcon as Hammer,
  InfoIcon as Info,
  ListChecksIcon as ListTodo,
  MagnifyingGlassIcon as Search,
  PencilIcon as Pencil,
  PlusIcon as Plus,
  ArrowUpIcon as ArrowUp,
  SidebarSimpleIcon as PanelLeftClose,
  SidebarSimpleIcon as PanelLeftOpen,
  SparkleIcon as Sparkles,
  SpinnerGapIcon as Loader2,
  TerminalWindowIcon as Terminal,
  TrashIcon as Trash2,
  type Icon as PhosphorIcon,
  WrenchIcon as Wrench,
} from "@phosphor-icons/react"
import ReactMarkdown from "react-markdown"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

type Session = {
  id: string
  previewUrl: string
  projectPath: string
  models: ModelCatalogItem[]
  user: CurrentUser | null
}

type CurrentUser = {
  name: string
  email?: string
}

type ModelCatalogItem = {
  id: string
  label: string
  description?: string
  parameters: ModelParameterConfig[]
  defaultParams: ModelParam[]
}

type ModelParameterConfig = {
  id: string
  label: string
  values: ModelParameterValue[]
}

type ModelParameterValue = {
  id: string
  label: string
}

type ModelParam = {
  id: string
  value: string
}

type ChatMessage = {
  id: string
  activityCount?: number
  activityGroupKey?: string
  activityIcon?: ActivityIcon
  activityKey?: string
  activityState?: ActivityState
  activitySymbol?: string
  activityTargets?: string[]
  activityType?: StreamPayload["type"]
  role: "activity" | "assistant" | "user" | "system"
  content: string
}

type ProjectNameMessage = {
  role: "assistant" | "user"
  content: string
}

type Conversation = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  input: string
  model: string
  session: Session | null
}

type PersistedAppState = {
  version: 2
  activeConversationId: string
  conversations: Conversation[]
}

type ConversationRuntimeState = {
  isRunning: boolean
  isCreatingSession: boolean
  isCursorTyping: boolean
  sessionError: string | null
}

type StreamPayload =
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

type ActivityDescriptor = {
  groupKey: string
  icon: ActivityIcon
  key?: string
  state?: ActivityState
  symbol: string
  targets?: string[]
  content: string
}

type ActivityState = "active" | "complete"

type ActivityIcon =
  | "read"
  | "search"
  | "glob"
  | "edit"
  | "delete"
  | "shell"
  | "test"
  | "build"
  | "thinking"
  | "status"
  | "task"
  | "default"

type ToolParamDisplay = {
  target?: string
  details: string
}

type ProjectContextMenuState = {
  conversationId: string
  x: number
  y: number
}

const SAVED_CURSOR_API_KEY = "app-builder.cursor-api-key"
const SAVED_CHAT_STATE = "app-builder.chat-state"
const CHAT_WIDTH_DEFAULT = 400
const GROUPED_FILE_TARGET_LIMIT = 4
const PROJECT_NAME_TIMEOUT_MS = 15_000
const SAVED_API_KEY_READY_MESSAGE =
  "Saved Cursor API key updated. The local preview is ready."
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
const fallbackModelSelection = encodeModelSelection({ id: fallbackModels[0].id })

export function AppBuilder() {
  const [bootstrap] = useState(createInitialAppState)
  const [conversations, setConversations] = useState(bootstrap.conversations)
  const [activeConversationId, setActiveConversationId] = useState(
    bootstrap.activeConversationId
  )
  const [apiKey, setApiKey] = useState("")
  const [hasSavedApiKey, setHasSavedApiKey] = useState(false)
  const [runtimeByConversationId, setRuntimeByConversationId] = useState<
    Record<string, ConversationRuntimeState>
  >(() => ({
    [bootstrap.activeConversationId]: createRuntimeState(),
  }))
  const [isProjectSidebarOpen, setIsProjectSidebarOpen] = useState(true)
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(true)
  const [isApiKeySettingsOpen, setIsApiKeySettingsOpen] = useState(false)
  const [isApiKeyClearConfirming, setIsApiKeyClearConfirming] = useState(false)
  const [titleGenerationConversationIds, setTitleGenerationConversationIds] =
    useState(() => new Set<string>())
  const bottomRef = useRef<HTMLDivElement>(null)
  const conversationsRef = useRef(conversations)
  const restoredConversationIdsRef = useRef(new Set<string>())
  const titleGenerationConversationIdsRef = useRef(new Set<string>())
  const lastStreamEventTypeRef = useRef<
    Record<string, StreamPayload["type"] | null>
  >({})
  const activeConversation = useMemo(
    () =>
      getConversationById(conversations, activeConversationId) ??
      conversations[0] ??
      createEmptyConversation("Project 1"),
    [activeConversationId, conversations]
  )
  const activeRuntime =
    runtimeByConversationId[activeConversation.id] ?? createRuntimeState()
  const session = activeConversation.session
  const messages = activeConversation.messages
  const input = activeConversation.input
  const model = activeConversation.model
  const isRunning = activeRuntime.isRunning
  const isCreatingSession = activeRuntime.isCreatingSession
  const isCursorTyping = activeRuntime.isCursorTyping
  const sessionError = activeRuntime.sessionError
  const showProjectSetup = isCreatingSession && !session
  const availableModels = useMemo(
    () => ensureModelCatalog(session?.models),
    [session]
  )
  const sidebarConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations]
  )

  useLayoutEffect(() => {
    const persisted = readPersistedAppStateFromStorage()
    setConversations(persisted.conversations)
    setActiveConversationId(persisted.activeConversationId)
    setRuntimeByConversationId(
      Object.fromEntries(
        persisted.conversations.map((conversation) => [
          conversation.id,
          createRuntimeState(),
        ])
      )
    )
    const savedKey = getSavedCursorApiKey()
    if (savedKey && isCursorApiKey(savedKey)) {
      setIsOnboardingOpen(false)
    }
  }, [])

  useEffect(() => {
    conversationsRef.current = conversations
  }, [conversations])

  useEffect(() => {
    let cancelled = false
    const timeout = window.setTimeout(async () => {
      if (cancelled) {
        return
      }

      const conversation = getConversationById(
        conversationsRef.current,
        activeConversationId
      )
      if (!conversation) {
        return
      }

      if (
        conversation.session &&
        restoredConversationIdsRef.current.has(conversation.id)
      ) {
        setIsOnboardingOpen(false)
        setConversationRuntime(conversation.id, (current) => ({
          ...current,
          isCursorTyping: false,
          isCreatingSession: false,
          sessionError: null,
        }))
        return
      }

      const savedApiKey = getSavedCursorApiKey()
      const restoredSessionId = conversation.session?.id
      const hasValidSavedApiKey = Boolean(
        savedApiKey && isCursorApiKey(savedApiKey)
      )
      const validSavedApiKey = hasValidSavedApiKey ? savedApiKey : undefined

      if (savedApiKey && !hasValidSavedApiKey) {
        window.localStorage.removeItem(SAVED_CURSOR_API_KEY)
      }

      setHasSavedApiKey(hasValidSavedApiKey)
      if (!validSavedApiKey) {
        setIsOnboardingOpen(true)
        setConversationRuntime(conversation.id, (current) => ({
          ...current,
          isCreatingSession: false,
          isCursorTyping: false,
          sessionError: null,
        }))
        return
      }

      setConversationRuntime(conversation.id, (current) => ({
        ...current,
        isCreatingSession: true,
        isCursorTyping: false,
        sessionError: null,
      }))

      try {
        const data = await requestSession(
          validSavedApiKey,
          restoredSessionId,
          { persistApiKey: hasValidSavedApiKey }
        )

        if (cancelled) {
          return
        }

        restoredConversationIdsRef.current.add(conversation.id)
        applySession(conversation.id, data)
        setIsOnboardingOpen(false)
        setHasSavedApiKey(true)
        setConversationRuntime(conversation.id, (current) => ({
          ...current,
          isCreatingSession: false,
          isCursorTyping: false,
          sessionError: null,
        }))
      } catch (error) {
        if (cancelled) {
          return
        }

        if (isMissingApiKeyError(error)) {
          setHasSavedApiKey(false)
          setIsOnboardingOpen(true)
          setConversationRuntime(conversation.id, (current) => ({
            ...current,
            isCreatingSession: false,
            isCursorTyping: false,
            sessionError: null,
          }))
          return
        }

        const message =
          error instanceof Error ? error.message : "Could not start preview."
        setHasSavedApiKey(true)
        setConversationRuntime(conversation.id, (current) => ({
          ...current,
          isCreatingSession: false,
          isCursorTyping: false,
          sessionError: message,
        }))
      } finally {
        if (!cancelled) {
          setConversationRuntime(conversation.id, (current) => ({
            ...current,
            isCreatingSession: false,
          }))
        }
      }
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
    // The restore pass is keyed only by active conversation; helper functions
    // intentionally read the latest state through refs inside the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [activeConversation.id, messages])

  useEffect(() => {
    writePersistedAppState({
      version: 2,
      activeConversationId,
      conversations: conversations.map((conversation) => ({
        ...conversation,
        messages: compactActivityMessages(conversation.messages),
      })),
    })
  }, [activeConversationId, conversations])

  useEffect(() => {
    for (const conversation of conversations) {
      if (
        !conversation.session ||
        !shouldGenerateProjectName(conversation) ||
        titleGenerationConversationIdsRef.current.has(conversation.id)
      ) {
        continue
      }

      const firstUserMessage = conversation.messages.find(
        (message) => message.role === "user"
      )
      if (!firstUserMessage?.content.trim()) {
        continue
      }

      void requestGeneratedConversationTitle(
        conversation.id,
        conversation.session.id,
        { prompt: firstUserMessage.content }
      )
    }
    // Title generation is triggered by conversation state; the request helper
    // has its own in-flight guard via titleGenerationConversationIdsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations])

  const canSubmit = useMemo(
    () => Boolean(session && input.trim() && !isRunning),
    [input, isRunning, session]
  )
  const visibleMessages = useMemo(() => compactActivityMessages(messages), [
    messages,
  ])
  const selectedModel = useMemo(
    () => getSelectedModel(availableModels, model),
    [availableModels, model]
  )

  function setConversationRuntime(
    conversationId: string,
    updater: (
      current: ConversationRuntimeState
    ) => ConversationRuntimeState
  ) {
    setRuntimeByConversationId((current) => {
      const previous = current[conversationId] ?? createRuntimeState()
      return {
        ...current,
        [conversationId]: updater(previous),
      }
    })
  }

  function setConversationTitleGenerationState(
    conversationId: string,
    isGenerating: boolean
  ) {
    setTitleGenerationConversationIds((current) => {
      const next = new Set(current)

      if (isGenerating) {
        next.add(conversationId)
      } else {
        next.delete(conversationId)
      }

      return next
    })
  }

  function updateConversation(
    conversationId: string,
    updater: (conversation: Conversation) => Conversation
  ) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId ? updater(conversation) : conversation
      )
    )
  }

  function setConversationMessages(
    conversationId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[]
  ) {
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      messages: updater(conversation.messages),
      updatedAt: Date.now(),
    }))
  }

  function setConversationInput(conversationId: string, nextInput: string) {
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      input: nextInput,
      updatedAt: Date.now(),
    }))
  }

  function setConversationModel(conversationId: string, nextModel: string) {
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      model: nextModel,
      updatedAt: Date.now(),
    }))
  }

  function createConversation() {
    if (!hasSavedApiKey) {
      openOnboarding()
      return
    }

    const conversation = createEmptyConversation(
      getNextConversationTitle(conversations)
    )
    setConversations((current) => [conversation, ...current])
    setRuntimeByConversationId((current) => ({
      ...current,
      [conversation.id]: createRuntimeState(),
    }))
    setActiveConversationId(conversation.id)
    setApiKey("")
  }

  function openOnboarding() {
    setApiKey("")
    setIsOnboardingOpen(true)
    setConversationRuntime(activeConversation.id, (current) => ({
      ...current,
      sessionError: null,
    }))
  }

  function renameConversation(conversationId: string, title: string) {
    const nextTitle = sanitizeProjectTitle(title)
    if (!nextTitle) {
      return
    }

    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      title: nextTitle,
      updatedAt: Date.now(),
    }))
  }

  function setApiKeySettingsOpen(open: boolean) {
    setIsApiKeySettingsOpen(open)
    setIsApiKeyClearConfirming(false)

    if (open) {
      setApiKey("")
    }
  }

  async function requestGeneratedConversationTitle(
    conversationId: string,
    sessionId: string,
    context: { prompt?: string; messages?: ProjectNameMessage[] },
    options: { force?: boolean; notifyOnError?: boolean } = {}
  ) {
    if (titleGenerationConversationIdsRef.current.has(conversationId)) {
      return
    }

    titleGenerationConversationIdsRef.current.add(conversationId)
    setConversationTitleGenerationState(conversationId, true)
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => {
      controller.abort()
    }, PROJECT_NAME_TIMEOUT_MS)

    try {
      const response = await fetch("/api/project-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ sessionId, ...context }),
      })

      const data = (await response.json().catch(() => ({}))) as {
        error?: unknown
        title?: unknown
      }
      if (!response.ok || typeof data.title !== "string") {
        const message =
          typeof data.error === "string"
            ? data.error
            : "The API did not return a generated title."
        throw new Error(message)
      }

      const title = sanitizeProjectTitle(data.title)
      if (!title) {
        throw new Error("The generated project name was empty.")
      }

      updateConversation(conversationId, (conversation) =>
        options.force || shouldGenerateProjectName(conversation)
          ? { ...conversation, title, updatedAt: Date.now() }
          : conversation
      )
    } catch (error) {
      if (!options.notifyOnError) {
        return
      }

      const message = getProjectNameErrorMessage(error)
      setConversationMessages(conversationId, (current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: message,
        },
      ])
    } finally {
      window.clearTimeout(timeoutId)
      titleGenerationConversationIdsRef.current.delete(conversationId)
      setConversationTitleGenerationState(conversationId, false)
    }
  }

  async function generateConversationTitle(conversationId: string) {
    const conversation = getConversationById(
      conversationsRef.current,
      conversationId
    )
    if (!conversation?.session) {
      return
    }

    const messages = getProjectNameMessages(conversation)
    if (messages.length === 0) {
      return
    }

    await requestGeneratedConversationTitle(
      conversation.id,
      conversation.session.id,
      { messages },
      { force: true, notifyOnError: true }
    )
  }

  function applySession(conversationId: string, nextSession: Session) {
    const nextModels = ensureModelCatalog(nextSession.models)

    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      session: { ...nextSession, models: nextModels },
      model: isModelSelectionAvailable(nextModels, conversation.model)
        ? conversation.model
        : encodeModelForCatalogItem(nextModels[0]),
      updatedAt: Date.now(),
    }))
  }

  function selectModel(modelId: string) {
    const nextModel = availableModels.find((item) => item.id === modelId)
    if (nextModel) {
      setConversationModel(
        activeConversation.id,
        encodeModelForCatalogItem(nextModel)
      )
    }
  }

  function selectModelParameter(parameterId: string, value: string) {
    const currentSelection = parseModelSelectionValue(model)
    const params = new Map(
      normalizeSelectedParams(selectedModel, currentSelection.params).map(
        (param) => [param.id, param.value]
      )
    )
    params.set(parameterId, value)

    setConversationModel(
      activeConversation.id,
      encodeModelSelection({
        id: selectedModel.id,
        params: Array.from(params.entries()).map(([id, paramValue]) => ({
          id,
          value: paramValue,
        })),
      })
    )
  }

  async function createSessionFromApiKey(
    rawApiKey: string,
    options: {
      openOnboardingOnError?: boolean
      persist: boolean
      readyMessage?: string
    },
    conversationId = activeConversation.id
  ) {
    if (!rawApiKey.trim() || isCreatingSession) {
      return false
    }

    const trimmedApiKey = rawApiKey.trim()
    const restoredSessionId = getConversationById(
      conversationsRef.current,
      conversationId
    )?.session?.id

    if (!isCursorApiKey(trimmedApiKey)) {
      setConversationRuntime(conversationId, (current) => ({
        ...current,
        sessionError: "Cursor API keys start with crsr_. Please check the key.",
      }))
      return false
    }

    setConversationRuntime(conversationId, (current) => ({
      ...current,
      isCreatingSession: true,
      isCursorTyping: false,
      sessionError: null,
    }))

    try {
      const data = await requestSession(trimmedApiKey, restoredSessionId, {
        persistApiKey: options.persist,
      })

      restoredConversationIdsRef.current.add(conversationId)
      applySession(conversationId, data)
      if (options.persist) {
        window.localStorage.setItem(SAVED_CURSOR_API_KEY, trimmedApiKey)
      }
      setHasSavedApiKey(true)
      setApiKey("")
      setConversationRuntime(conversationId, (current) => ({
        ...current,
        isCreatingSession: false,
        isCursorTyping: false,
        sessionError: null,
      }))
      setIsOnboardingOpen(false)
      const readyMessage = options.readyMessage
      if (readyMessage) {
        setConversationMessages(conversationId, (current) =>
          appendReadyMessage(current, readyMessage)
        )
      }
      return true
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not start preview."
      const shouldOpenOnboarding = options.openOnboardingOnError ?? true
      setConversationRuntime(conversationId, (current) => ({
        ...current,
        isCreatingSession: false,
        isCursorTyping: false,
        sessionError: message,
      }))
      if (shouldOpenOnboarding) {
        setIsOnboardingOpen(true)
      }
      return false
    } finally {
      setConversationRuntime(conversationId, (current) => ({
        ...current,
        isCreatingSession: false,
      }))
    }
  }

  async function submitApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!apiKey.trim() || isCreatingSession) {
      return
    }

    const didStart = await createSessionFromApiKey(apiKey, {
      persist: true,
    })

    if (didStart) {
      setIsOnboardingOpen(false)
    }
  }

  async function submitApiKeySettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!apiKey.trim() || isCreatingSession) {
      return
    }

    const didSave = await createSessionFromApiKey(apiKey, {
      openOnboardingOnError: !activeConversation.session,
      persist: true,
      readyMessage: SAVED_API_KEY_READY_MESSAGE,
    })

    if (didSave) {
      setIsOnboardingOpen(false)
      setApiKeySettingsOpen(false)
    }
  }

  async function clearSavedApiKey() {
    window.localStorage.removeItem(SAVED_CURSOR_API_KEY)
    await fetch("/api/settings/api-key", { method: "DELETE" }).catch(() => {})
    setHasSavedApiKey(false)
    setApiKey("")
    if (!activeConversation.session) {
      setIsOnboardingOpen(true)
    }
    setConversationRuntime(activeConversation.id, (current) => ({
      ...current,
      sessionError: null,
    }))
  }

  async function confirmClearSavedApiKey() {
    if (!isApiKeyClearConfirming) {
      setIsApiKeyClearConfirming(true)
      return
    }

    await clearSavedApiKey()
    setIsApiKeyClearConfirming(false)
  }

  async function retrySavedApiKey() {
    const conversationId = activeConversation.id
    const restoredSessionId = activeConversation.session?.id
    const savedApiKey = getSavedCursorApiKey()
    const validSavedApiKey =
      savedApiKey && isCursorApiKey(savedApiKey) ? savedApiKey : undefined

    if (savedApiKey && !validSavedApiKey) {
      window.localStorage.removeItem(SAVED_CURSOR_API_KEY)
    }

    if (!validSavedApiKey) {
      setHasSavedApiKey(false)
      setIsOnboardingOpen(true)
      setConversationRuntime(conversationId, (current) => ({
        ...current,
        isCreatingSession: false,
        isCursorTyping: false,
        sessionError: null,
      }))
      return
    }

    setConversationRuntime(conversationId, (current) => ({
      ...current,
      isCreatingSession: true,
      isCursorTyping: false,
      sessionError: null,
    }))

    try {
      const data = await requestSession(validSavedApiKey, restoredSessionId, {
        persistApiKey: Boolean(validSavedApiKey),
      })
      restoredConversationIdsRef.current.add(conversationId)
      applySession(conversationId, data)
      setHasSavedApiKey(true)
      setConversationRuntime(conversationId, (current) => ({
        ...current,
        isCreatingSession: false,
        isCursorTyping: false,
        sessionError: null,
      }))
    } catch (error) {
      if (isMissingApiKeyError(error)) {
        setHasSavedApiKey(false)
        setIsOnboardingOpen(true)
        setConversationRuntime(conversationId, (current) => ({
          ...current,
          sessionError: null,
        }))
      } else {
        const message =
          error instanceof Error ? error.message : "Could not start preview."
        setConversationRuntime(conversationId, (current) => ({
          ...current,
          sessionError: message,
        }))
      }
      setConversationRuntime(conversationId, (current) => ({
        ...current,
        isCursorTyping: false,
      }))
    } finally {
      setConversationRuntime(conversationId, (current) => ({
        ...current,
        isCreatingSession: false,
      }))
    }
  }

  async function sendMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    if (!session || !input.trim() || isRunning) {
      return
    }

    const conversationId = activeConversation.id
    const activeSession = session
    const activeModel = model
    const userText = input.trim()
    const assistantId = crypto.randomUUID()
    lastStreamEventTypeRef.current[conversationId] = null
    setConversationRuntime(conversationId, (current) => ({
      ...current,
      isRunning: true,
    }))
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      input: "",
      messages: [
        ...conversation.messages,
        { id: crypto.randomUUID(), role: "user", content: userText },
        {
          id: createAssistantSegmentId(assistantId),
          role: "assistant",
          content: "",
        },
      ],
      updatedAt: Date.now(),
    }))

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: activeSession.id,
          message: userText,
          model: activeModel,
        }),
      })

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error ?? "The agent request failed.")
      }

      await readAgentStream(response.body, conversationId, assistantId)
    } catch (error) {
      const message = getFriendlyErrorMessage(error)
      setConversationMessages(conversationId, (current) => [
        ...current,
        { id: crypto.randomUUID(), role: "system", content: message },
      ])
    } finally {
      setConversationMessages(conversationId, finalizeActiveThinkingMessages)
      setConversationRuntime(conversationId, (current) => ({
        ...current,
        isRunning: false,
      }))
    }
  }

  async function readAgentStream(
    body: ReadableStream<Uint8Array>,
    conversationId: string,
    assistantId: string
  ) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() ?? ""

      for (const chunk of chunks) {
        handleStreamChunk(chunk, conversationId, assistantId)
      }
    }

    if (buffer.trim()) {
      handleStreamChunk(buffer, conversationId, assistantId)
    }
  }

  function handleStreamChunk(
    chunk: string,
    conversationId: string,
    assistantId: string
  ) {
    const parsed = parseServerSentEvent(chunk)
    if (!parsed) {
      return
    }

    if (parsed.event === "error") {
      const data = parsed.data as { message?: string }
      throw new Error(data.message ?? "The agent run failed.")
    }

    if (parsed.event === "session") {
      applySession(conversationId, parsed.data as Session)
      return
    }

    if (parsed.event === "assistant_delta") {
      const data = parsed.data as StreamPayload
      if (data.type === "assistant_delta") {
        appendAssistantDelta(conversationId, assistantId, data.text)
      }
      return
    }

    if (
      parsed.event === "status" ||
      parsed.event === "tool_call" ||
      parsed.event === "task" ||
      parsed.event === "thinking"
    ) {
      updateActivity(parsed.data as StreamPayload, conversationId, assistantId)
    }
  }

  function appendAssistantDelta(
    conversationId: string,
    assistantId: string,
    text: string
  ) {
    if (!text) {
      return
    }

    lastStreamEventTypeRef.current[conversationId] = "assistant_delta"

    setConversationMessages(conversationId, (current) => {
      const nextMessages = finalizeActiveThinkingMessages(current)
      const lastMessage = nextMessages.at(-1)

      if (lastMessage && isAssistantSegment(lastMessage, assistantId)) {
        return nextMessages.map((message, index) =>
          index === nextMessages.length - 1
            ? { ...message, content: `${message.content}${text}` }
            : message
        )
      }

      return [
        ...nextMessages,
        {
          id: createAssistantSegmentId(assistantId),
          role: "assistant",
          content: text,
        },
      ]
    })
  }

  function updateActivity(
    payload: StreamPayload,
    conversationId: string,
    assistantId: string
  ) {
    const activity = formatActivity(payload)

    if (!activity) {
      if (payload.type !== "thinking") {
        lastStreamEventTypeRef.current[conversationId] = payload.type
        setConversationMessages(conversationId, finalizeActiveThinkingMessages)
      }
      return
    }

    const activityKey = activity.key
      ? `${assistantId}:${activity.key}`
      : undefined
    const shouldCoalesceThinking =
      payload.type === "thinking" &&
      !activityKey &&
      lastStreamEventTypeRef.current[conversationId] === "thinking"
    lastStreamEventTypeRef.current[conversationId] = payload.type

    setConversationMessages(conversationId, (current) => {
      const currentMessages =
        payload.type === "thinking"
          ? current
          : finalizeActiveThinkingMessages(current)
      const activityIndex = activityKey
        ? findActivityMessageIndex(currentMessages, activityKey)
        : -1

      if (activityIndex !== -1) {
        const currentActivity = currentMessages[activityIndex]
        const content = mergeActivityContent(currentActivity.content, activity)

        if (
          currentActivity.content === content &&
          currentActivity.activityGroupKey === activity.groupKey &&
          currentActivity.activityIcon === activity.icon &&
          currentActivity.activityState === activity.state &&
          currentActivity.activitySymbol === activity.symbol &&
          areStringArraysEqual(currentActivity.activityTargets, activity.targets) &&
          currentActivity.activityType === payload.type
        ) {
          return currentMessages
        }

        return currentMessages.map((message, index) =>
          index === activityIndex
            ? {
                ...message,
                activityKey,
                activityGroupKey: activity.groupKey,
                activityIcon: activity.icon,
                activityState: activity.state,
                activitySymbol: activity.symbol,
                activityTargets: activity.targets,
                activityType: payload.type,
                content,
              }
            : message
        )
      }

      const nextMessages = removeTrailingEmptyAssistantSegment(
        currentMessages,
        assistantId
      )
      const lastMessage = nextMessages.at(-1)

      if (
        !activityKey &&
        payload.type === "thinking" &&
        shouldCoalesceThinking &&
        lastMessage &&
        getMessageDisplayRole(lastMessage) === "activity" &&
        lastMessage.activityType === "thinking"
      ) {
        if (
          lastMessage.content === activity.content &&
          lastMessage.activityGroupKey === activity.groupKey &&
          lastMessage.activityIcon === activity.icon
        ) {
          return nextMessages
        }

        return nextMessages.map((message, index) =>
          index === nextMessages.length - 1
            ? {
                ...message,
                activityGroupKey: activity.groupKey,
                activityIcon: activity.icon,
                activityState: activity.state,
                activitySymbol: activity.symbol,
                content: activity.content,
              }
            : message
        )
      }

      if (lastMessage && canGroupActivityMessages(lastMessage, activity)) {
        return nextMessages.map((message, index) =>
          index === nextMessages.length - 1
            ? {
                ...message,
                activityCount: (message.activityCount ?? 1) + 1,
                content: activity.content,
              }
            : message
        )
      }

      return [
        ...nextMessages,
        {
          id: crypto.randomUUID(),
          activityCount: 1,
          activityGroupKey: activity.groupKey,
          activityIcon: activity.icon,
          activityKey,
          activityState: activity.state,
          activitySymbol: activity.symbol,
          activityTargets: activity.targets,
          activityType: payload.type,
          role: "activity",
          content: activity.content,
        },
      ]
    })
  }

  function createAssistantSegmentId(assistantId: string) {
    return `${assistantId}:assistant:${crypto.randomUUID()}`
  }

  function isAssistantSegment(message: ChatMessage, assistantId: string) {
    return (
      message.role === "assistant" &&
      message.id.startsWith(`${assistantId}:assistant:`)
    )
  }

  function removeTrailingEmptyAssistantSegment(
    messages: ChatMessage[],
    assistantId: string
  ) {
    const lastMessage = messages.at(-1)

    if (
      lastMessage &&
      isAssistantSegment(lastMessage, assistantId) &&
      !lastMessage.content
    ) {
      return messages.slice(0, -1)
    }

    return messages
  }

  function canGroupActivityMessages(
    message: ChatMessage,
    activity: ActivityDescriptor
  ) {
    return (
      getMessageDisplayRole(message) === "activity" &&
      !message.activityKey &&
      !activity.key &&
      message.activityType === "tool_call" &&
      message.activityGroupKey === activity.groupKey &&
      message.activityIcon === activity.icon
    )
  }

  return (
    <main
      className={cn(
        "flex h-screen gap-0 bg-background p-0",
        session ? "" : "items-stretch"
      )}
    >
      {isProjectSidebarOpen ? (
        <ConversationSidebar
          conversations={sidebarConversations}
          activeConversationId={activeConversation.id}
          apiKey={apiKey}
          hasSavedApiKey={hasSavedApiKey}
          isApiKeyClearConfirming={isApiKeyClearConfirming}
          isApiKeySettingsOpen={isApiKeySettingsOpen}
          isCreatingSession={isCreatingSession}
          titleGenerationConversationIds={titleGenerationConversationIds}
          sessionError={sessionError}
          user={session?.user ?? null}
          onApiKeyChange={setApiKey}
          onApiKeySettingsOpenChange={setApiKeySettingsOpen}
          onClearSavedApiKey={confirmClearSavedApiKey}
          onCreateConversation={createConversation}
          onGenerateName={generateConversationTitle}
          onHideSidebar={() => {
            setIsProjectSidebarOpen(false)
            setApiKeySettingsOpen(false)
          }}
          onSelectConversation={(conversationId) => {
            setActiveConversationId(conversationId)
            setApiKey("")
            setIsApiKeyClearConfirming(false)
          }}
          onRenameConversation={renameConversation}
          onRequireApiKey={openOnboarding}
          onSubmitApiKey={submitApiKeySettings}
        />
      ) : (
        <CollapsedProjectSidebar
          onShowSidebar={() => setIsProjectSidebarOpen(true)}
        />
      )}
      <Card
        className={cn(
          "flex h-full gap-0 overflow-hidden rounded-none border-y-0 border-l-0 border-r-0 py-0 shadow-none ring-0",
          session ? "shrink-0 border-r border-border/80" : "min-w-0 flex-1"
        )}
        style={session ? { width: CHAT_WIDTH_DEFAULT } : undefined}
      >
        <CardContent className="relative flex min-h-0 flex-1 flex-col p-0">
          {session ? (
            <ProjectChatHeader
              conversation={activeConversation}
              session={session}
              title={activeConversation.title}
              updatedAt={activeConversation.updatedAt}
            />
          ) : null}
          <ScrollArea className="min-h-0 flex-1">
            <div
              className={cn(
                "flex min-h-full flex-col gap-2.5 p-3",
                session && "pb-48",
                !showProjectSetup && "justify-end",
                showProjectSetup && "items-center justify-center"
              )}
            >
              {showProjectSetup ? (
                <p className="text-sm font-medium text-muted-foreground">
                  Setting up project ...
                </p>
              ) : isCursorTyping ? (
                <div className="mr-8 flex w-fit items-center gap-2 rounded-md bg-muted/70 px-2.5 py-1.5 text-sm text-muted-foreground">
                  <Loader2 aria-hidden="true" className="animate-spin" />
                  Cursor is typing...
                </div>
              ) : null}

              {visibleMessages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "flex flex-col gap-1 text-sm leading-6",
                    getMessageDisplayRole(message) === "user" &&
                      "w-fit max-w-[85%] self-end rounded-md bg-muted/80 px-3 py-2 text-foreground",
                    getMessageDisplayRole(message) === "assistant" &&
                      "py-1 text-foreground",
                    getMessageDisplayRole(message) === "activity" &&
                      "py-px text-xs leading-5 text-muted-foreground/85",
                    getMessageDisplayRole(message) === "system" &&
                      "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive"
                  )}
                >
                  {message.role === "user" ? (
                    <p className="whitespace-pre-wrap break-words">
                      {message.content || "Working..."}
                    </p>
                  ) : getMessageDisplayRole(message) === "activity" ? (
                    <ActivityMessage message={message} />
                  ) : message.role === "assistant" && !message.content ? (
                    <AssistantPending />
                  ) : (
                    <MarkdownMessage content={message.content || "Working..."} />
                  )}
                </div>
              ))}

              {!session && hasSavedApiKey && sessionError ? (
                <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
                  <p className="text-sm text-destructive">{sessionError}</p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      onClick={retrySavedApiKey}
                      disabled={isCreatingSession}
                      className="rounded-md"
                    >
                      {isCreatingSession ? (
                        <Loader2
                          data-icon="inline-start"
                          className="animate-spin"
                        />
                      ) : (
                        <Sparkles data-icon="inline-start" />
                      )}
                      Retry
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setApiKeySettingsOpen(true)}
                      className="rounded-md"
                    >
                      Change API key
                    </Button>
                  </div>
                </div>
              ) : null}

              <div ref={bottomRef} />
            </div>
          </ScrollArea>

          {session ? (
            <form
              className="absolute inset-x-0 bottom-0 z-20 bg-linear-to-t from-background via-background/95 to-transparent px-4 pb-4 pt-12"
              onSubmit={sendMessage}
            >
              <div className="rounded-xl border bg-background p-3 shadow-sm transition-colors focus-within:border-ring/60 focus-within:ring-3 focus-within:ring-ring/15">
                <Textarea
                  value={input}
                  onChange={(event) =>
                    setConversationInput(
                      activeConversation.id,
                      event.target.value
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }
                  }}
                  placeholder="What do you want to build?"
                  rows={1}
                  disabled={isRunning}
                  className="max-h-40 min-h-16 resize-none border-0 bg-transparent px-1 py-0 text-base shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent"
                />
                <div className="flex items-center justify-between gap-2 pt-3 text-xs text-muted-foreground">
                  <div className="flex min-w-0 items-center gap-2">
                    <ModelConfigPopover
                      models={availableModels}
                      selectedModel={selectedModel}
                      model={model}
                      onModelChange={selectModel}
                      onParameterChange={selectModelParameter}
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="submit"
                      size="icon-sm"
                      className="size-7 rounded-full bg-foreground text-background hover:bg-foreground/90 [&_svg:not([class*='size-'])]:size-4"
                      disabled={!canSubmit}
                      aria-label="Send message"
                    >
                      {isRunning ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <ArrowUp aria-hidden="true" className="size-5" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </form>
          ) : null}
        </CardContent>
      </Card>

      {session ? (
        <Card className="flex min-w-0 flex-1 gap-0 overflow-hidden rounded-none border-0 py-0 shadow-none ring-0">
          <CardContent className="flex min-h-0 flex-1 flex-col bg-background p-0">
            <iframe
              title="Generated app preview"
              src={session.previewUrl}
              className="min-h-0 flex-1 border-0 bg-white"
            />
          </CardContent>
        </Card>
      ) : null}
      {isOnboardingOpen ? (
        <ApiKeyOnboardingModal
          apiKey={apiKey}
          isCreatingSession={isCreatingSession}
          sessionError={sessionError}
          onApiKeyChange={setApiKey}
          onSubmit={submitApiKey}
        />
      ) : null}
    </main>
  )
}

function findActivityMessageIndex(messages: ChatMessage[], activityKey: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].activityKey === activityKey) {
      return index
    }
  }

  return -1
}

function finalizeActiveThinkingMessages(messages: ChatMessage[]) {
  let changed = false
  const finalized = messages.map((message) => {
    if (
      getMessageDisplayRole(message) !== "activity" ||
      message.activityType !== "thinking" ||
      message.activityState !== "active"
    ) {
      return message
    }

    changed = true
    const content = finalizeThinkingContent(message.content)
    return {
      ...message,
      activityGroupKey: getActivityGroupKey(content),
      activityState: "complete" as const,
      activitySymbol: getActivitySymbol(content),
      content,
    }
  })

  return changed ? finalized : messages
}

function finalizeThinkingContent(content: string) {
  const normalized = normalizeActivityContent(content) ?? content
  const detail = normalized.replace(/^Thinking(?: through)?(?:\.\.\.)?:?\s*/i, "")

  return detail && detail !== normalized ? `Thought: ${detail}` : "Thought"
}

function mergeActivityContent(
  previousContent: string,
  nextActivity: ActivityDescriptor
) {
  if (nextActivity.content.includes(":")) {
    return nextActivity.content
  }

  const previousParams = getInlineActivityParams(previousContent)
  return previousParams ? `${nextActivity.content}: ${previousParams}` : nextActivity.content
}

function getInlineActivityParams(content: string) {
  const [, params] = content.match(/^[^:]+:\s*(.+)$/) ?? []
  return params
}

function getActivityGroupKey(content: string) {
  return stripActivityCount(content)
    .replace(/:\s*.+$/, "")
    .trim()
    .toLowerCase()
}

function formatActivity(payload: StreamPayload): ActivityDescriptor | null {
  if (payload.type === "tool_call") {
    const icon = getToolActivityIcon(payload.name)
    const content = formatToolActivity(
      payload.name,
      payload.status,
      payload.args,
      payload.truncatedArgs
    )
    return {
      groupKey: getActivityGroupKey(content),
      icon,
      key: payload.callId ? `tool:${payload.callId}` : undefined,
      symbol: getActivitySymbol(content),
      targets: getExactToolFileTargets(payload.name, payload.args, icon),
      content,
    }
  }

  if (payload.type === "thinking") {
    const content = formatThinkingActivity(payload.text)

    return {
      groupKey: getActivityGroupKey(content),
      icon: "thinking",
      key: payload.id ? `thinking:${payload.id}` : undefined,
      state: "active",
      symbol: getActivitySymbol(content),
      content,
    }
  }

  if (payload.type === "status") {
    const content = formatStatusActivity(payload.status, payload.message)

    return content
      ? {
          groupKey: getActivityGroupKey(content),
          icon: "status",
          symbol: getActivitySymbol(content),
          content,
        }
      : null
  }

  if (payload.type === "task") {
    const content = payload.text ?? formatStatusText(payload.status) ?? "Task updated"
    return {
      groupKey: getActivityGroupKey(content),
      icon: "task",
      symbol: getActivitySymbol(content),
      content,
    }
  }

  return null
}

function formatThinkingActivity(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim()

  if (
    !normalized ||
    /^(thinking|thinking\.{3}|working|working\.{3})$/i.test(normalized)
  ) {
    return "Thinking..."
  }

  return `Thinking...: ${truncateInline(normalized, 120)}`
}

function getToolActivityIcon(name: string): ActivityIcon {
  const normalized = name.toLowerCase()

  if (normalized.includes("search")) {
    return "search"
  }

  if (normalized.includes("glob") || normalized.includes("list")) {
    return "glob"
  }

  if (normalized.includes("read") || normalized.includes("fetch")) {
    return "read"
  }

  if (normalized.includes("delete") || normalized.includes("remove")) {
    return "delete"
  }

  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("update") ||
    normalized.includes("create")
  ) {
    return "edit"
  }

  if (normalized.includes("test")) {
    return "test"
  }

  if (normalized.includes("build")) {
    return "build"
  }

  if (
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("terminal")
  ) {
    return "shell"
  }

  return "default"
}

function formatToolActivity(
  name: string,
  status: string,
  args: unknown,
  truncatedArgs: boolean | undefined
) {
  const toolName = humanizeToolName(name)
  const normalizedStatus = status.toLowerCase()
  const params = formatToolParams(args, truncatedArgs)
  const pathLabel = getPathToolActivityLabel(name, params.target)

  if (pathLabel) {
    const content =
      normalizedStatus === "error" || normalizedStatus === "failed"
        ? `${pathLabel} failed`
        : pathLabel
    return appendInlineDetails(content, params.details)
  }

  const suffix = params.details || params.target
  const contentSuffix = suffix ? `: ${suffix}` : ""

  if (
    normalizedStatus === "requested" ||
    normalizedStatus === "running" ||
    normalizedStatus === "in_progress"
  ) {
    return `${getRunningToolLabel(toolName)}${contentSuffix}`
  }

  if (normalizedStatus === "completed" || normalizedStatus === "success") {
    return `${getFinishedToolLabel(toolName)}${contentSuffix}`
  }

  if (normalizedStatus === "error" || normalizedStatus === "failed") {
    return `${getFailedToolLabel(toolName)}${contentSuffix}`
  }

  const statusText = formatStatusText(status)?.toLowerCase() ?? status
  return `${toolName} ${statusText}${contentSuffix}`
}

function appendInlineDetails(content: string, details: string) {
  return details ? `${content}: ${details}` : content
}

function getPathToolActivityLabel(name: string, target: string | undefined) {
  if (!target) {
    return null
  }

  const normalized = name.toLowerCase()

  if (
    normalized.includes("read") ||
    normalized.includes("search") ||
    normalized.includes("glob") ||
    normalized.includes("list") ||
    normalized.includes("fetch")
  ) {
    return `Read ${target}`
  }

  if (normalized.includes("delete") || normalized.includes("remove")) {
    return `Deleted ${target}`
  }

  if (normalized.includes("create")) {
    return `Created ${target}`
  }

  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("update")
  ) {
    return `Edited ${target}`
  }

  return null
}

function getExactToolFileTargets(
  name: string,
  args: unknown,
  icon: ActivityIcon
) {
  if (!isExactFileToolName(name, icon)) {
    return undefined
  }

  const paths = collectPathValues(parseMaybeJson(args))
    .filter(isExactFileActivityPath)
    .map(formatPathDisplay)
    .filter(Boolean)

  return normalizeActivityTargets(Array.from(new Set(paths)))
}

function isExactFileToolName(name: string, icon: ActivityIcon) {
  const normalized = name.toLowerCase()

  if (icon === "read") {
    return (
      normalized.includes("read") &&
      !normalized.includes("search") &&
      !normalized.includes("glob") &&
      !normalized.includes("list") &&
      !normalized.includes("fetch")
    )
  }

  if (icon === "edit") {
    return (
      normalized.includes("edit") ||
      normalized.includes("write") ||
      normalized.includes("patch") ||
      normalized.includes("update") ||
      normalized.includes("create")
    )
  }

  return false
}

function isExactFileActivityPath(path: string) {
  const trimmedPath = path.trim().replace(/[?#].*$/, "")

  return (
    Boolean(trimmedPath) &&
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedPath.replace(/^file:\/\//i, "")) &&
    !/[/\\]$/.test(trimmedPath) &&
    !/[*?\[\]{}]/.test(trimmedPath)
  )
}

function formatStatusActivity(status: string, message: string | undefined) {
  const normalizedStatus = status.toUpperCase()

  if (normalizedStatus === "RUNNING" || normalizedStatus === "FINISHED") {
    return null
  }

  return formatStatusText(message ?? status)
}

function getRunningToolLabel(toolName: string) {
  return toolName
}

function getFinishedToolLabel(toolName: string) {
  if (toolName.endsWith("ing files")) {
    return toolName.replace(/ing files$/, "ed files")
  }

  if (toolName.endsWith("ing changes")) {
    return toolName.replace(/ing changes$/, "ed changes")
  }

  if (toolName === "Reading context") {
    return "Read context"
  }

  if (toolName.endsWith("ing")) {
    return toolName.replace(/ing$/, "ed")
  }

  return `${toolName} done`
}

function getFailedToolLabel(toolName: string) {
  if (toolName.endsWith("ing files")) {
    return toolName.replace(/ing files$/, "ing files failed")
  }

  if (toolName.endsWith("ing changes")) {
    return toolName.replace(/ing changes$/, "ing changes failed")
  }

  return `${toolName} failed`
}

function formatToolParams(
  args: unknown,
  truncated: boolean | undefined
): ToolParamDisplay {
  if (args === undefined || args === null) {
    return { details: truncated ? "params truncated" : "" }
  }

  const redactedArgs = redactSensitiveValues(parseMaybeJson(args))
  const target = formatPathTarget(collectPathValues(redactedArgs))
  const details = formatParamDetails(redactedArgs)

  return {
    target,
    details: appendTruncatedDetails(details, truncated),
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value
  }

  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function appendTruncatedDetails(details: string, truncated: boolean | undefined) {
  if (!truncated) {
    return details
  }

  return details ? `${details} (truncated)` : "params truncated"
}

function collectPathValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectPathValues)
  }

  if (!value || typeof value !== "object") {
    return []
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, item]) => {
      if (isPathParamKey(key)) {
        return collectStringValues(item)
      }

      return collectPathValues(item)
    }
  )
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return value ? [value] : []
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectStringValues)
  }

  if (!value || typeof value !== "object") {
    return []
  }

  return Object.values(value as Record<string, unknown>).flatMap(
    collectStringValues
  )
}

function formatPathTarget(paths: string[]) {
  const uniquePaths = Array.from(new Set(paths.map(formatPathDisplay))).filter(
    Boolean
  )

  if (uniquePaths.length === 0) {
    return undefined
  }

  if (uniquePaths.length <= 2) {
    return uniquePaths.join(", ")
  }

  return `${uniquePaths.slice(0, 2).join(", ")} +${uniquePaths.length - 2}`
}

function formatPathDisplay(path: string) {
  const trimmedPath = path.trim().replace(/[?#].*$/, "").replace(/[/\\]+$/, "")
  const normalizedPath = trimmedPath.replace(/^file:\/\//, "")
  const parts = normalizedPath.split(/[/\\]/).filter(Boolean)

  return parts.at(-1) ?? normalizedPath
}

function formatParamDetails(value: unknown) {
  if (value === undefined || value === null) {
    return ""
  }

  if (Array.isArray(value)) {
    return truncateInline(value.map(formatParamValue).join(", "))
  }

  if (typeof value !== "object") {
    return truncateInline(formatParamValue(value))
  }

  const details = Object.entries(value as Record<string, unknown>)
    .filter(
      ([key, item]) =>
        !isPathParamKey(key) &&
        !isVerboseParamKey(key) &&
        !isEmptyParamValue(item)
    )
    .map(([key, item]) => `${formatParamKey(key)}: ${formatParamValue(item)}`)
    .join(", ")

  return truncateInline(details)
}

function formatParamValue(value: unknown): string {
  if (value === undefined || value === null) {
    return ""
  }

  if (typeof value === "string") {
    return truncateInline(value)
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  if (Array.isArray(value)) {
    const values = value.slice(0, 3).map(formatParamValue).filter(Boolean)
    const hiddenCount = value.length - values.length
    const suffix = hiddenCount > 0 ? ` +${hiddenCount}` : ""
    return `[${values.join(", ")}${suffix}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(
      ([key, item]) =>
        !isPathParamKey(key) &&
        !isVerboseParamKey(key) &&
        !isEmptyParamValue(item)
    )
    .slice(0, 3)
    .map(([key, item]) => `${formatParamKey(key)}: ${formatParamValue(item)}`)

  return `{${entries.join(", ")}}`
}

function formatParamKey(key: string) {
  return key.replace(/[_-]+/g, " ")
}

function isEmptyParamValue(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  )
}

function isPathParamKey(key: string) {
  const normalized = key.toLowerCase().replace(/[_\-\s]+/g, "")

  return (
    normalized.includes("path") ||
    normalized === "file" ||
    normalized === "files" ||
    normalized === "filename" ||
    normalized === "filenames" ||
    normalized === "targetfile" ||
    normalized === "targetfiles"
  )
}

function isVerboseParamKey(key: string) {
  const normalized = key.toLowerCase().replace(/[_\-\s]+/g, "")

  return (
    normalized === "content" ||
    normalized === "contents" ||
    normalized === "code" ||
    normalized === "diff" ||
    normalized === "patch" ||
    normalized === "oldstring" ||
    normalized === "newstring"
  )
}

function truncateInline(value: string, maxLength = 180) {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength - 3)}...`
    : compact
}

function redactSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveValues)
  }

  if (!value || typeof value !== "object") {
    return value
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSensitiveParamKey(key) ? "[redacted]" : redactSensitiveValues(item),
    ])
  )
}

function isSensitiveParamKey(key: string) {
  return /api[_-]?key|token|secret|password|credential/i.test(key)
}

function formatStatusText(value: string | undefined) {
  if (!value) {
    return null
  }

  const formatted = value.replace(/[_-]+/g, " ").trim()

  if (!formatted) {
    return null
  }

  const normalized =
    formatted === formatted.toUpperCase() ? formatted.toLowerCase() : formatted
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function humanizeToolName(name: string) {
  const normalized = name.toLowerCase()

  if (normalized.includes("read") || normalized.includes("search")) {
    return "Reading context"
  }

  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch")
  ) {
    return "Editing files"
  }

  if (
    normalized.includes("shell") ||
    normalized.includes("lint") ||
    normalized.includes("test") ||
    normalized.includes("build")
  ) {
    return "Checking changes"
  }

  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function getMessageDisplayRole(message: ChatMessage) {
  if (
    message.role === "activity" ||
    (message.role === "system" &&
      (message.content.startsWith("**Activity**") ||
        message.content.startsWith("**Agent activity**")))
  ) {
    return "activity"
  }

  return message.role
}

const activityIconMap: Record<ActivityIcon, PhosphorIcon> = {
  read: FileText,
  search: Search,
  glob: Files,
  edit: Pencil,
  delete: Trash2,
  shell: Terminal,
  test: FlaskConical,
  build: Hammer,
  thinking: Brain,
  status: Info,
  task: ListTodo,
  default: Wrench,
}

function ActivityMessage({ message }: { message: ChatMessage }) {
  const content = normalizeActivityContent(message.content) ?? ""
  const Icon = activityIconMap[getActivityIcon(message, content)]
  const segments = getActivityInlineSegments(content)
  const count = message.activityCount ?? getActivityCount(content)

  return (
    <div className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="grid size-4 shrink-0 place-items-center rounded-sm bg-muted/70 text-muted-foreground/80"
      >
        <Icon className="size-2.5" />
      </span>
      <span className="min-w-0 truncate text-muted-foreground/85">
        {segments.map((segment, index) =>
          segment.kind === "code" ? (
            <code
              key={index}
              className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground/85"
            >
              {segment.text}
            </code>
          ) : (
            <span key={index}>{segment.text}</span>
          )
        )}
      </span>
      {count > 1 ? (
        <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
          x{count}
        </span>
      ) : null}
    </div>
  )
}

function getActivityInlineSegments(content: string) {
  const displayContent = stripActivityCount(content)
  const commandMatch = displayContent.match(
    /^(.*?\bcommand:\s*)(.*?)(?=,\s*[a-z][a-z\s-]*:\s|$)(.*)$/i
  )

  if (!commandMatch) {
    return [{ kind: "text" as const, text: displayContent }]
  }

  const [, beforeCommand, command, afterCommand] = commandMatch
  return [
    { kind: "text" as const, text: beforeCommand },
    { kind: "code" as const, text: command.trim() },
    { kind: "text" as const, text: afterCommand },
  ].filter((segment) => segment.text)
}

function getActivityIcon(message: ChatMessage, content: string): ActivityIcon {
  if (message.activityIcon) {
    return message.activityIcon
  }

  if (message.activityType === "thinking") {
    return "thinking"
  }

  if (message.activityType === "status") {
    return "status"
  }

  if (message.activityType === "task") {
    return "task"
  }

  const normalized = content.toLowerCase()

  if (normalized.startsWith("read ")) {
    return "read"
  }

  if (normalized.startsWith("edited ") || normalized.startsWith("created ")) {
    return "edit"
  }

  if (normalized.startsWith("deleted ")) {
    return "delete"
  }

  if (normalized.includes("test")) {
    return "test"
  }

  if (normalized.includes("build")) {
    return "build"
  }

  if (normalized.includes("shell") || normalized.includes("command")) {
    return "shell"
  }

  return "default"
}


function cleanActivityContent(content: string) {
  return stripActivityCount(content)
    .replace(/^\*\*(Agent activity|Activity)\*\*\s*/i, "")
    .split("\n")
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean)
    .join(" · ")
}

function stripActivityCount(content: string) {
  return content.replace(/\s+x\d+$/i, "").trim()
}

function getActivityCount(content: string) {
  const [, count] = content.match(/\s+x(\d+)$/i) ?? []
  return count ? Number(count) : 1
}

function compactActivityMessages(messages: ChatMessage[]) {
  return messages.reduce<ChatMessage[]>((compacted, message) => {
    const normalizedMessage = normalizeActivityMessage(message)

    if (!normalizedMessage) {
      return compacted
    }

    const lastMessage = compacted.at(-1)
    const canCoalesceActivity =
      getMessageDisplayRole(normalizedMessage) === "activity" &&
      lastMessage &&
      getMessageDisplayRole(lastMessage) === "activity" &&
      (normalizedMessage.activityKey
        ? lastMessage.activityKey === normalizedMessage.activityKey
        : normalizedMessage.activityType === "thinking" &&
          lastMessage.activityType === "thinking")
    const canGroupActivity =
      getMessageDisplayRole(normalizedMessage) === "activity" &&
      lastMessage &&
      getMessageDisplayRole(lastMessage) === "activity" &&
      !normalizedMessage.activityKey &&
      !lastMessage.activityKey &&
      normalizedMessage.activityType === "tool_call" &&
      lastMessage.activityType === "tool_call" &&
      normalizedMessage.activityGroupKey === lastMessage.activityGroupKey &&
      normalizedMessage.activityIcon === lastMessage.activityIcon

    if (canCoalesceActivity) {
      compacted[compacted.length - 1] = normalizedMessage
      return compacted
    }

    if (canGroupActivity) {
      compacted[compacted.length - 1] = {
        ...lastMessage,
        activityCount:
          (lastMessage.activityCount ?? 1) +
          (normalizedMessage.activityCount ?? 1),
        content: normalizedMessage.content,
      }
      return compacted
    }

    const groupedFileMessage =
      lastMessage && mergeFileActivityMessages(lastMessage, normalizedMessage)

    if (groupedFileMessage) {
      compacted[compacted.length - 1] = groupedFileMessage
      return compacted
    }

    compacted.push(normalizedMessage)
    return compacted
  }, [])
}

function appendReadyMessage(messages: ChatMessage[], readyMessage: string) {
  if (
    messages.some(
      (message) => message.role === "assistant" && message.content === readyMessage
    )
  ) {
    return messages
  }

  return [
    ...messages,
    {
      id: crypto.randomUUID(),
      role: "assistant" as const,
      content: readyMessage,
    },
  ]
}

function mergeFileActivityMessages(
  previousMessage: ChatMessage,
  nextMessage: ChatMessage
) {
  const previousContent = normalizeActivityContent(previousMessage.content)
  const nextContent = normalizeActivityContent(nextMessage.content)

  if (!previousContent || !nextContent) {
    return null
  }

  const previousActivity = getGroupableFileActivity(
    previousMessage,
    previousContent
  )
  const nextActivity = getGroupableFileActivity(nextMessage, nextContent)

  if (
    !previousActivity ||
    !nextActivity ||
    previousActivity.verb !== nextActivity.verb
  ) {
    return null
  }

  const previousCount =
    previousMessage.activityCount ?? getActivityCount(previousMessage.content)
  const nextCount = nextMessage.activityCount ?? getActivityCount(nextMessage.content)

  if (
    previousActivity.targets.length === 1 &&
    nextActivity.targets.length === 1 &&
    previousActivity.targets[0] === nextActivity.targets[0]
  ) {
    return {
      ...previousMessage,
      activityCount: previousCount + nextCount,
      activityKey: undefined,
      content: nextContent,
    }
  }

  if (previousCount > 1 || nextCount > 1) {
    return null
  }

  const activityTargets = [...previousActivity.targets, ...nextActivity.targets]
  const content = formatGroupedFileActivityContent(
    previousActivity.verb,
    activityTargets
  )

  return {
    ...previousMessage,
    activityCount: 1,
    activityGroupKey: getActivityGroupKey(content),
    activityIcon: previousActivity.icon,
    activityKey: undefined,
    activityState: nextMessage.activityState ?? previousMessage.activityState,
    activitySymbol: getActivitySymbol(content),
    activityTargets,
    activityType: previousMessage.activityType ?? nextMessage.activityType,
    content,
  }
}

type GroupableFileActivityVerb = "Created" | "Edited" | "Read"

type GroupableFileActivity = {
  icon: ActivityIcon
  targets: string[]
  verb: GroupableFileActivityVerb
}

function getGroupableFileActivity(
  message: ChatMessage,
  content: string
): GroupableFileActivity | null {
  const icon = getActivityIcon(message, content)
  const verb = getFileActivityVerb(content)

  if (!verb || !isGroupableFileActivityIcon(icon, verb)) {
    return null
  }

  const targetText = getFileActivityTargetText(content, verb)

  if (!targetText || /\b(failed|done|complete)$/i.test(targetText)) {
    return null
  }

  const explicitTargets = normalizeActivityTargets(message.activityTargets)
  if (explicitTargets && !explicitTargets.some(isBroadFileActivityTarget)) {
    return { icon, targets: explicitTargets, verb }
  }

  const targets = getFileActivityTargetsFromTargetText(targetText)
  return targets ? { icon, targets, verb } : null
}

function getFileActivityTargetsFromContent(message: ChatMessage, content: string) {
  const activity = getGroupableFileActivity(message, content)
  return activity?.targets
}

function getFileActivityVerb(content: string): GroupableFileActivityVerb | null {
  const [, verb] =
    stripActivityCount(content).match(/^(Created|Edited|Read)\s+/i) ?? []

  if (!verb) {
    return null
  }

  return `${verb.charAt(0).toUpperCase()}${verb
    .slice(1)
    .toLowerCase()}` as GroupableFileActivityVerb
}

function isGroupableFileActivityIcon(
  icon: ActivityIcon,
  verb: GroupableFileActivityVerb
) {
  if (verb === "Read") {
    return icon === "read"
  }

  return icon === "edit"
}

function getFileActivityTargetText(
  content: string,
  verb: GroupableFileActivityVerb
) {
  const pattern = new RegExp(`^${verb}\\s+(.+)$`, "i")
  return stripActivityCount(content)
    .match(pattern)?.[1]
    ?.replace(/:\s*.*$/, "")
    .replace(/\s+\+\d+$/i, "")
    .trim()
}

function getFileActivityTargetsFromTargetText(targetText: string) {
  const targets = targetText.split(/\s*,\s*/).filter(Boolean)

  if (targets.length === 0 || targets.some(isBroadFileActivityTarget)) {
    return undefined
  }

  return normalizeActivityTargets(targets)
}

function isBroadFileActivityTarget(target: string) {
  const normalized = target.toLowerCase()

  return (
    normalized === "context" ||
    normalized === "files" ||
    normalized === "params truncated" ||
    /[*?\[\]{}]/.test(target)
  )
}

function formatGroupedFileActivityContent(
  verb: GroupableFileActivityVerb,
  targets: string[]
) {
  const visibleTargets = targets.slice(0, GROUPED_FILE_TARGET_LIMIT)
  const hiddenCount = targets.length - visibleTargets.length

  return `${verb} ${visibleTargets.join(", ")}${
    hiddenCount > 0 ? ` +${hiddenCount}` : ""
  }`
}

function normalizeActivityTargets(targets: string[] | undefined) {
  if (!targets) {
    return undefined
  }

  const normalizedTargets = targets
    .map((target) => target.trim())
    .filter(Boolean)

  return normalizedTargets.length > 0 ? normalizedTargets : undefined
}

function areStringArraysEqual(
  previous: string[] | undefined,
  next: string[] | undefined
) {
  const previousValues = normalizeActivityTargets(previous) ?? []
  const nextValues = normalizeActivityTargets(next) ?? []

  return (
    previousValues.length === nextValues.length &&
    previousValues.every((value, index) => value === nextValues[index])
  )
}

function normalizeActivityMessage(message: ChatMessage) {
  if (getMessageDisplayRole(message) !== "activity") {
    return message
  }

  const content = normalizeActivityContent(message.content)
  return content
    ? {
        ...message,
        activityCount: message.activityCount ?? getActivityCount(message.content),
        activityGroupKey: message.activityGroupKey ?? getActivityGroupKey(content),
        activityTargets:
          normalizeActivityTargets(message.activityTargets) ??
          getFileActivityTargetsFromContent(message, content),
        content,
      }
    : null
}

function normalizeActivityContent(content: string) {
  const cleaned = cleanActivityContent(content)
  const normalized = cleaned.trim()

  if (
    /^(running|finished)$/i.test(normalized) ||
    /^run (finished|completed|success)$/i.test(normalized)
  ) {
    return null
  }

  if (/^editing files complete$/i.test(normalized)) {
    return "Edited files"
  }

  if (/^checking changes complete$/i.test(normalized)) {
    return "Checked changes"
  }

  if (/^reading context complete$/i.test(normalized)) {
    return "Read context"
  }

  return normalized.replace(/\bcomplete$/i, "done")
}

function getActivitySymbol(content: string) {
  const words = content
    .replace(/^\*\*(Agent activity|Activity)\*\*\s*/i, "")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)

  if (words.length >= 2) {
    return `${words[0].charAt(0)}${words[1].charAt(0)}`.toUpperCase()
  }

  return (words[0] ?? "?").slice(0, 2).padEnd(2, "?").toUpperCase()
}

function AssistantPending() {
  return (
    <div
      className="flex items-center gap-1 py-1 text-muted-foreground"
      aria-label="Assistant is thinking"
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
          style={{ animationDelay: `${index * 120}ms` }}
        />
      ))}
    </div>
  )
}

function ApiKeyOnboardingModal({
  apiKey,
  isCreatingSession,
  sessionError,
  onApiKeyChange,
  onSubmit,
}: {
  apiKey: string
  isCreatingSession: boolean
  sessionError: string | null
  onApiKeyChange: (apiKey: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-6">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-key-onboarding-title"
        className="flex w-full max-w-sm flex-col overflow-hidden rounded-md border bg-card text-card-foreground shadow-lg"
        onSubmit={onSubmit}
      >
        <div className="border-b px-4 py-3">
          <div className="mb-3 flex items-center gap-2 text-muted-foreground">
            <div className="grid size-6 place-items-center rounded-md bg-muted text-foreground">
              <Cube aria-hidden="true" size={14} weight="duotone" />
            </div>
            <span className="text-xs font-medium">App Builder</span>
          </div>
          <h2
            id="api-key-onboarding-title"
            className="text-base font-semibold tracking-tight"
          >
            Connect Cursor to start building
          </h2>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            Add your Cursor API key to start a local preview workspace. You can
            update or clear it later from settings.
          </p>
        </div>

        <div className="flex flex-col gap-3 p-4">
          <label
            htmlFor="onboarding-cursor-api-key"
            className="text-xs font-medium"
          >
            Cursor API key
          </label>
          <Input
            id="onboarding-cursor-api-key"
            type="password"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder="crsr_..."
            autoComplete="off"
            disabled={isCreatingSession}
            className="h-9 rounded-md font-mono text-sm"
            autoFocus
          />
          {sessionError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
              {sessionError}
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={!apiKey.trim() || isCreatingSession}
            className="h-9 rounded-md"
          >
            {isCreatingSession ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <ArrowRight data-icon="inline-start" weight="bold" />
            )}
            Start local builder
          </Button>
        </div>
      </form>
    </div>
  )
}

function ConversationSidebar({
  conversations,
  activeConversationId,
  apiKey,
  hasSavedApiKey,
  isApiKeyClearConfirming,
  isApiKeySettingsOpen,
  isCreatingSession,
  sessionError,
  titleGenerationConversationIds,
  user,
  onApiKeyChange,
  onApiKeySettingsOpenChange,
  onClearSavedApiKey,
  onCreateConversation,
  onGenerateName,
  onHideSidebar,
  onRenameConversation,
  onRequireApiKey,
  onSelectConversation,
  onSubmitApiKey,
}: {
  conversations: Conversation[]
  activeConversationId: string
  apiKey: string
  hasSavedApiKey: boolean
  isApiKeyClearConfirming: boolean
  isApiKeySettingsOpen: boolean
  isCreatingSession: boolean
  sessionError: string | null
  titleGenerationConversationIds: ReadonlySet<string>
  user: CurrentUser | null
  onApiKeyChange: (apiKey: string) => void
  onApiKeySettingsOpenChange: (open: boolean) => void
  onClearSavedApiKey: () => void
  onCreateConversation: () => void
  onGenerateName: (conversationId: string) => void
  onHideSidebar: () => void
  onRenameConversation: (conversationId: string, title: string) => void
  onRequireApiKey: () => void
  onSelectConversation: (conversationId: string) => void
  onSubmitApiKey: (event: FormEvent<HTMLFormElement>) => void
}) {
  const [contextMenu, setContextMenu] = useState<ProjectContextMenuState | null>(
    null
  )
  const [renameState, setRenameState] = useState<{
    conversationId: string
    title: string
  } | null>(null)
  const activeRenameConversationId = renameState?.conversationId
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const contextMenuConversation = contextMenu
    ? conversations.find(
        (conversation) => conversation.id === contextMenu.conversationId
      )
    : undefined
  const isContextMenuGeneratingName = Boolean(
    contextMenu &&
      titleGenerationConversationIds.has(contextMenu.conversationId)
  )
  const canGenerateName = Boolean(
    contextMenuConversation?.session &&
      getProjectNameMessages(contextMenuConversation).length > 0 &&
      !isContextMenuGeneratingName
  )

  useEffect(() => {
    if (!contextMenu) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (
        target instanceof Node &&
        contextMenuRef.current?.contains(target)
      ) {
        return
      }

      setContextMenu(null)
      setRenameState(null)
    }

    function handleKeyDown(event: WindowEventMap["keydown"]) {
      if (event.key === "Escape") {
        setContextMenu(null)
        setRenameState(null)
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!activeRenameConversationId) {
      return
    }

    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [activeRenameConversationId])

  function openProjectContextMenu(
    event: ReactMouseEvent<HTMLButtonElement>,
    conversationId: string
  ) {
    event.preventDefault()
    event.stopPropagation()

    const margin = 8
    const menuWidth = 176
    const menuHeight = 112
    setContextMenu({
      conversationId,
      x: Math.min(
        Math.max(event.clientX, margin),
        window.innerWidth - menuWidth - margin
      ),
      y: Math.min(
        Math.max(event.clientY, margin),
        window.innerHeight - menuHeight - margin
      ),
    })
    setRenameState(null)
  }

  function startRename() {
    if (!contextMenuConversation) {
      return
    }

    setRenameState({
      conversationId: contextMenuConversation.id,
      title: contextMenuConversation.title,
    })
  }

  function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!renameState) {
      return
    }

    onRenameConversation(renameState.conversationId, renameState.title)
    setContextMenu(null)
    setRenameState(null)
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-muted/30">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 px-2 pt-2">
          <div className="mb-1 flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              className="min-w-0 flex-1 justify-start rounded-md px-2 py-1.5 text-sm text-muted-foreground"
              onClick={hasSavedApiKey ? onCreateConversation : onRequireApiKey}
            >
              <Plus data-icon="inline-start" />
              New project
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-md text-muted-foreground"
              aria-label="Hide projects sidebar"
              title="Hide projects sidebar"
              onClick={onHideSidebar}
            >
              <PanelLeftClose aria-hidden="true" />
            </Button>
          </div>
          {conversations.map((conversation) => {
            const isActive = conversation.id === activeConversationId
            const isGeneratingName = titleGenerationConversationIds.has(
              conversation.id
            )

            return (
              <Button
                key={conversation.id}
                type="button"
                variant="ghost"
                className={cn(
                  "relative h-auto w-full justify-start rounded-md px-2 py-1.5 text-left text-muted-foreground",
                  isActive && "bg-muted text-foreground"
                )}
                aria-current={isActive ? "page" : undefined}
                onClick={() => {
                  setContextMenu(null)
                  onSelectConversation(conversation.id)
                }}
                onContextMenu={(event) =>
                  openProjectContextMenu(event, conversation.id)
                }
              >
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
                    <span className="truncate">{conversation.title}</span>
                    {isGeneratingName ? (
                      <Loader2
                        aria-label="Generating project name"
                        className="size-3 shrink-0 animate-spin text-muted-foreground"
                      />
                    ) : null}
                  </span>
                  <span className="block truncate text-xs font-normal text-muted-foreground/80">
                    {getConversationPreview(conversation)}
                  </span>
                </span>
              </Button>
            )
          })}
          {contextMenu ? (
            <div
              ref={contextMenuRef}
              role="menu"
              aria-label="Project actions"
              className="fixed z-50 min-w-44 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              {renameState ? (
                <form
                  className="flex flex-col gap-2 p-1"
                  onSubmit={submitRename}
                >
                  <Input
                    ref={renameInputRef}
                    value={renameState.title}
                    onChange={(event) =>
                      setRenameState((current) =>
                        current
                          ? { ...current, title: event.target.value }
                          : current
                      )
                    }
                    aria-label="Project name"
                    className="h-8 rounded-sm"
                  />
                  <div className="flex gap-1">
                    <Button
                      type="submit"
                      size="sm"
                      className="h-8 flex-1 rounded-sm"
                      disabled={!renameState.title.trim()}
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 flex-1 rounded-sm"
                      onClick={() => setRenameState(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                    onClick={startRename}
                  >
                    <Pencil aria-hidden="true" className="size-4" />
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!canGenerateName}
                    className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                    onClick={() => {
                      if (!canGenerateName) {
                        return
                      }

                      const conversationId = contextMenu.conversationId
                      setContextMenu(null)
                      onGenerateName(conversationId)
                    }}
                  >
                    {isContextMenuGeneratingName ? (
                      <Loader2
                        aria-hidden="true"
                        className="size-4 animate-spin"
                      />
                    ) : (
                      <Sparkles aria-hidden="true" className="size-4" />
                    )}
                    {isContextMenuGeneratingName
                      ? "Generating name..."
                      : "Generate name"}
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>
      </ScrollArea>
      <div className="flex items-center justify-between gap-2 py-2 pl-4 pr-2">
        <div className="min-w-0 flex-1">
          {user ? (
            <p
              className="truncate text-xs font-medium text-muted-foreground"
              title={user.email ? `${user.name} (${user.email})` : user.name}
            >
              {user.name}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ApiKeySettingsPopover
            apiKey={apiKey}
            hasSavedApiKey={hasSavedApiKey}
            isClearConfirming={isApiKeyClearConfirming}
            isCreatingSession={isCreatingSession}
            open={isApiKeySettingsOpen}
            sessionError={sessionError}
            onApiKeyChange={onApiKeyChange}
            onClearSavedApiKey={onClearSavedApiKey}
            onOpenChange={onApiKeySettingsOpenChange}
            onSubmit={onSubmitApiKey}
          />
        </div>
      </div>
    </aside>
  )
}

function ApiKeySettingsPopover({
  apiKey,
  hasSavedApiKey,
  isClearConfirming,
  isCreatingSession,
  open,
  sessionError,
  onApiKeyChange,
  onClearSavedApiKey,
  onOpenChange,
  onSubmit,
}: {
  apiKey: string
  hasSavedApiKey: boolean
  isClearConfirming: boolean
  isCreatingSession: boolean
  open: boolean
  sessionError: string | null
  onApiKeyChange: (apiKey: string) => void
  onClearSavedApiKey: () => void
  onOpenChange: (open: boolean) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-md text-muted-foreground"
            aria-label="Open Cursor API key settings"
            title="Open Cursor API key settings"
          />
        }
      >
        <Settings aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 rounded-md">
        <PopoverHeader>
          <PopoverTitle>Cursor API key</PopoverTitle>
          <PopoverDescription>
            {hasSavedApiKey ? "Saved for future projects." : "Required to start."}
          </PopoverDescription>
        </PopoverHeader>
        <form className="flex flex-col gap-2" onSubmit={onSubmit}>
          <FieldGroup className="gap-2">
            <Field>
              <FieldLabel htmlFor="settings-cursor-api-key">API key</FieldLabel>
              <Input
                id="settings-cursor-api-key"
                type="password"
                value={apiKey}
                onChange={(event) => onApiKeyChange(event.target.value)}
                placeholder="crsr_..."
                autoComplete="off"
                disabled={isCreatingSession}
                className="rounded-md"
              />
            </Field>
            {sessionError ? (
              <p role="alert" className="text-sm text-destructive">
                {sessionError}
              </p>
            ) : null}
            <Button
              type="submit"
              className="rounded-md"
              disabled={!apiKey.trim() || isCreatingSession}
            >
              {isCreatingSession ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <ArrowRight data-icon="inline-start" weight="bold" />
              )}
              Save key
            </Button>
          </FieldGroup>
        </form>
        <div className="border-t pt-2">
          <Button
            type="button"
            variant={isClearConfirming ? "destructive" : "ghost"}
            size="sm"
            className="w-full justify-start rounded-md text-muted-foreground"
            disabled={!hasSavedApiKey || isCreatingSession}
            onClick={onClearSavedApiKey}
          >
            {isClearConfirming ? "Confirm clear saved key" : "Clear saved key"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function CollapsedProjectSidebar({
  onShowSidebar,
}: {
  onShowSidebar: () => void
}) {
  return (
    <div className="flex h-full w-12 shrink-0 flex-col items-center border-r bg-muted/30 py-2">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="rounded-md text-muted-foreground"
        aria-label="Show projects sidebar"
        title="Show projects sidebar"
        onClick={onShowSidebar}
      >
        <PanelLeftOpen aria-hidden="true" />
      </Button>
    </div>
  )
}

function ProjectChatHeader({
  conversation,
  session,
  title,
  updatedAt,
}: {
  conversation: Conversation
  session: Session
  title: string
  updatedAt: number
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-2 border-b px-3 py-1.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">
          {title}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {formatHeaderUpdatedAt(updatedAt)}
        </p>
      </div>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-md text-muted-foreground"
              aria-label="Show project information"
              title="Show project information"
            />
          }
        >
          <Info aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 rounded-md">
          <PopoverHeader>
            <PopoverTitle>Project info</PopoverTitle>
            <PopoverDescription>
              Local preview and workspace metadata.
            </PopoverDescription>
          </PopoverHeader>
          <dl className="flex flex-col gap-2 text-xs">
            <ProjectInfoRow label="Path" value={session.projectPath} mono />
            <ProjectInfoRow label="Preview" value={session.previewUrl} mono />
            <ProjectInfoRow label="Session" value={session.id} mono />
            <ProjectInfoRow
              label="Created"
              value={formatMetadataTimestamp(conversation.createdAt)}
            />
            <ProjectInfoRow
              label="Updated"
              value={formatMetadataTimestamp(conversation.updatedAt)}
            />
          </dl>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function ProjectInfoRow({
  label,
  mono,
  value,
}: {
  label: string
  mono?: boolean
  value: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "break-all rounded-md bg-muted/50 px-2 py-1 text-foreground",
          mono && "font-mono"
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function formatHeaderUpdatedAt(updatedAt: number) {
  if (!isFiniteTimestamp(updatedAt)) {
    return "Updated recently"
  }

  const elapsedMs = Date.now() - updatedAt
  if (elapsedMs < 0 || elapsedMs < 60_000) {
    return "Updated just now"
  }

  const elapsedSeconds = Math.round(elapsedMs / 1000)
  const relativeTimeFormat = new Intl.RelativeTimeFormat("en", {
    numeric: "auto",
    style: "narrow",
  })
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ]

  const [unit, secondsPerUnit] =
    units.find(([, secondsPerUnit]) => elapsedSeconds >= secondsPerUnit) ??
    units[units.length - 1]
  const value = -Math.round(elapsedSeconds / secondsPerUnit)

  return `Updated ${relativeTimeFormat.format(value, unit)}`
}

function formatMetadataTimestamp(value: number) {
  if (!isFiniteTimestamp(value)) {
    return "Unknown"
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function ModelConfigPopover({
  models,
  selectedModel,
  model,
  onModelChange,
  onParameterChange,
}: {
  models: ModelCatalogItem[]
  selectedModel: ModelCatalogItem
  model: string
  onModelChange: (modelId: string) => void
  onParameterChange: (parameterId: string, value: string) => void
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 max-w-56 rounded-full border border-transparent px-2.5 text-sm font-normal leading-5 text-muted-foreground hover:bg-muted focus-visible:bg-muted focus-visible:text-foreground"
          />
        }
      >
        <Brain aria-hidden="true" className="size-4" />
        <span className="min-w-0 truncate">
          {getModelSelectionLabel(selectedModel, model)}
        </span>
        <CaretDown aria-hidden="true" className="size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 rounded-md">
        <PopoverHeader>
          <PopoverTitle>Model</PopoverTitle>
          <PopoverDescription>
            Choose a base model and configure its available attributes.
          </PopoverDescription>
        </PopoverHeader>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel>Base model</FieldLabel>
            <Select
              items={models.map((option) => ({
                label: option.label,
                value: option.id,
              }))}
              value={selectedModel.id}
              onValueChange={(value) => {
                if (value) {
                  onModelChange(value)
                }
              }}
            >
              <SelectTrigger aria-label="Base model" className="rounded-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" className="rounded-md">
                <SelectGroup>
                  {models.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {selectedModel.description ? (
              <FieldDescription>{selectedModel.description}</FieldDescription>
            ) : null}
          </Field>

          {selectedModel.parameters.map((parameter) => (
            <ModelParameterControl
              key={parameter.id}
              parameter={parameter}
              value={getSelectedParameterValue(model, selectedModel, parameter)}
              onChange={(value) => onParameterChange(parameter.id, value)}
            />
          ))}

          {selectedModel.parameters.length === 0 ? (
            <FieldDescription>
              This model does not expose extra configuration.
            </FieldDescription>
          ) : null}
        </FieldGroup>
      </PopoverContent>
    </Popover>
  )
}

function ModelParameterControl({
  parameter,
  value,
  onChange,
}: {
  parameter: ModelParameterConfig
  value: string
  onChange: (value: string) => void
}) {
  const booleanOptions = getBooleanParameterOptions(parameter)
  if (booleanOptions) {
    const isOn = value === booleanOptions.on.id
    return (
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">{parameter.label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          aria-label={parameter.label}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border p-0 transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            isOn ? "border-primary bg-primary" : "border-input bg-muted"
          )}
          onClick={() => {
            onChange(
              isOn ? booleanOptions.off.id : booleanOptions.on.id
            )
          }}
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute left-0.5 top-1/2 size-4 -translate-y-1/2 rounded-full bg-background shadow-sm transition-transform",
              isOn ? "translate-x-4" : "translate-x-0"
            )}
          />
        </button>
      </div>
    )
  }

  if (parameter.values.length <= 4) {
    return (
      <Field>
        <FieldLabel>{parameter.label}</FieldLabel>
        <ToggleGroup
          value={[value]}
          onValueChange={(nextValue) => {
            if (nextValue[0]) {
              onChange(nextValue[0])
            }
          }}
          size="sm"
          variant="outline"
          className="rounded-md bg-muted/40 data-[size=sm]:rounded-md"
        >
          {parameter.values.map((option) => (
            <ToggleGroupItem
              key={option.id}
              value={option.id}
              aria-label={`${parameter.label}: ${option.label}`}
              className="h-7 rounded-md px-2 text-xs text-muted-foreground group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-md group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-md data-[state=on]:bg-background data-[state=on]:text-foreground"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
    )
  }

  return (
    <Field>
      <FieldLabel>{parameter.label}</FieldLabel>
      <Select
        items={parameter.values.map((option) => ({
          label: option.label,
          value: option.id,
        }))}
        value={value}
        onValueChange={(nextValue) => {
          if (nextValue) {
            onChange(nextValue)
          }
        }}
      >
        <SelectTrigger
          aria-label={parameter.label}
          size="sm"
          className="h-7 rounded-md border-0 bg-muted/60 px-2.5 text-xs font-medium text-muted-foreground data-[size=sm]:rounded-md"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" className="rounded-md">
          <SelectGroup>
            {parameter.values.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="max-w-none text-sm leading-6 text-foreground">
      <ReactMarkdown
        components={{
          p: ({ children }) => (
            <p className="whitespace-pre-wrap break-words">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="ml-4 list-disc whitespace-normal">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="ml-4 list-decimal whitespace-normal">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          code: ({ children }) => (
            <code className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-2 max-w-full overflow-x-auto rounded-md border bg-muted p-3 text-sm text-foreground">
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function parseServerSentEvent(chunk: string) {
  const eventLine = chunk
    .split("\n")
    .find((line) => line.startsWith("event: "))
  const dataLines = chunk
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))

  if (!eventLine || dataLines.length === 0) {
    return null
  }

  return {
    event: eventLine.slice("event: ".length),
    data: JSON.parse(dataLines.join("\n")) as unknown,
  }
}

function isCursorApiKey(value: string) {
  return value.startsWith("crsr_")
}

function getSavedCursorApiKey() {
  if (typeof window === "undefined") {
    return undefined
  }

  return window.localStorage.getItem(SAVED_CURSOR_API_KEY)?.trim()
}

function getFriendlyErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : "The agent request failed."

  if (message.toLowerCase().includes("already has active run")) {
    return "Cursor is still working on the previous request. Wait a moment and try again."
  }

  return message
}

function sanitizeModelCatalog(models: unknown[]) {
  const byId = new Map<string, ModelCatalogItem>()
  for (const model of models) {
    const catalogItem = toModelCatalogItem(model)
    if (catalogItem && !byId.has(catalogItem.id)) {
      byId.set(catalogItem.id, catalogItem)
    }
  }

  return Array.from(byId.values())
}

function ensureModelCatalog(models: unknown[] | undefined) {
  if (!models?.length) {
    return fallbackModels
  }

  const catalog = sanitizeModelCatalog(models)
  return catalog.length ? catalog : fallbackModels
}

function toModelCatalogItem(value: unknown): ModelCatalogItem | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const maybeCatalogItem = value as Partial<ModelCatalogItem>
  if (
    typeof maybeCatalogItem.id === "string" &&
    typeof maybeCatalogItem.label === "string" &&
    Array.isArray(maybeCatalogItem.parameters)
  ) {
    return {
      id: maybeCatalogItem.id,
      label: maybeCatalogItem.label,
      description:
        typeof maybeCatalogItem.description === "string"
          ? maybeCatalogItem.description
          : undefined,
      parameters: maybeCatalogItem.parameters.filter(isModelParameterConfig),
      defaultParams: Array.isArray(maybeCatalogItem.defaultParams)
        ? maybeCatalogItem.defaultParams.filter(isModelParam)
        : [],
    }
  }

  return null
}

function isCurrentUser(value: unknown): value is CurrentUser {
  if (!value || typeof value !== "object") {
    return false
  }

  const user = value as Partial<CurrentUser>
  return (
    typeof user.name === "string" &&
    (typeof user.email === "string" || user.email === undefined)
  )
}

function isModelParameterConfig(value: unknown): value is ModelParameterConfig {
  if (!value || typeof value !== "object") {
    return false
  }

  const parameter = value as Partial<ModelParameterConfig>
  return (
    typeof parameter.id === "string" &&
    typeof parameter.label === "string" &&
    Array.isArray(parameter.values) &&
    parameter.values.every(isModelParameterValue)
  )
}

function isModelParameterValue(value: unknown): value is ModelParameterValue {
  if (!value || typeof value !== "object") {
    return false
  }

  const option = value as Partial<ModelParameterValue>
  return typeof option.id === "string" && typeof option.label === "string"
}

function isModelParam(value: unknown): value is ModelParam {
  if (!value || typeof value !== "object") {
    return false
  }

  const param = value as Partial<ModelParam>
  return typeof param.id === "string" && typeof param.value === "string"
}

function getSelectedModel(models: ModelCatalogItem[], value: string) {
  const selection = parseModelSelectionValue(value)
  return models.find((model) => model.id === selection.id) ?? models[0] ?? fallbackModels[0]
}

function isModelSelectionAvailable(models: ModelCatalogItem[], value: string) {
  const selection = parseModelSelectionValue(value)
  return models.some((model) => model.id === selection.id)
}

function encodeModelForCatalogItem(model: ModelCatalogItem) {
  return encodeModelSelection({
    id: model.id,
    params: normalizeSelectedParams(model, model.defaultParams),
  })
}

function getSelectedParameterValue(
  encodedSelection: string,
  selectedModel: ModelCatalogItem,
  parameter: ModelParameterConfig
) {
  const selection = parseModelSelectionValue(encodedSelection)
  const selectedParam = selection.params?.find(
    (param) => param.id === parameter.id
  )
  const defaultParam = selectedModel.defaultParams.find(
    (param) => param.id === parameter.id
  )

  return (
    selectedParam?.value ??
    defaultParam?.value ??
    parameter.values[0]?.id ??
    ""
  )
}

function getModelSelectionLabel(
  selectedModel: ModelCatalogItem,
  encodedSelection: string
) {
  const selection = parseModelSelectionValue(encodedSelection)
  const configuredValues = selectedModel.parameters
    .map((parameter) => {
      const selectedValue = getSelectedParameterValue(
        encodedSelection,
        selectedModel,
        parameter
      )
      const option = parameter.values.find((value) => value.id === selectedValue)
      return getModelParameterLabel(parameter, option)
    })
    .filter(Boolean)

  if (!configuredValues.length || selection.id !== selectedModel.id) {
    return selectedModel.label
  }

  return `${selectedModel.label} · ${configuredValues.join(" · ")}`
}

function getModelParameterLabel(
  parameter: ModelParameterConfig,
  option: ModelParameterValue | undefined
) {
  if (!option) {
    return undefined
  }

  const booleanOptions = getBooleanParameterOptions(parameter)
  if (!booleanOptions) {
    return option.label
  }

  if (option.id === booleanOptions.off.id) {
    return undefined
  }

  return getBooleanOnLabel(parameter, option)
}

function getBooleanParameterOptions(parameter: ModelParameterConfig) {
  if (parameter.values.length !== 2) {
    return null
  }

  const on = parameter.values.find((value) => isOnValue(value))
  const off = parameter.values.find((value) => isOffValue(value))

  return on && off ? { on, off } : null
}

function getBooleanOnLabel(
  parameter: ModelParameterConfig,
  option: ModelParameterValue
) {
  return isGenericBooleanLabel(option.label) ? parameter.label : option.label
}

function isOnValue(option: ModelParameterValue) {
  const value = normalizeBooleanValue(option.id)
  const label = normalizeBooleanValue(option.label)
  return (
    ["true", "on", "enabled", "enable", "yes"].includes(value) ||
    label === "true"
  )
}

function isOffValue(option: ModelParameterValue) {
  const value = normalizeBooleanValue(option.id)
  const label = normalizeBooleanValue(option.label)
  return (
    ["false", "off", "disabled", "disable", "no"].includes(value) ||
    label === "false"
  )
}

function isGenericBooleanLabel(label: string) {
  return ["true", "on", "enabled", "enable", "yes"].includes(
    normalizeBooleanValue(label)
  )
}

function normalizeBooleanValue(value: string) {
  return value.toLowerCase().replace(/[\s_-]+/g, "")
}

function normalizeSelectedParams(
  model: ModelCatalogItem,
  selectedParams: ModelParam[] | undefined
) {
  return model.parameters.map((parameter) => {
    const selectedParam = selectedParams?.find(
      (param) => param.id === parameter.id
    )
    const defaultParam = model.defaultParams.find(
      (param) => param.id === parameter.id
    )

    return {
      id: parameter.id,
      value:
        selectedParam?.value ??
        defaultParam?.value ??
        parameter.values[0]?.id ??
        "",
    }
  })
}

function encodeModelSelection(selection: { id: string; params?: ModelParam[] }) {
  const params = selection.params?.filter((param) => param.value)
  return JSON.stringify({
    id: selection.id,
    ...(params?.length ? { params } : {}),
  })
}

function parseModelSelectionValue(value: string): {
  id: string
  params?: ModelParam[]
} {
  try {
    const parsed = JSON.parse(value) as { id?: unknown; params?: unknown }
    if (typeof parsed.id === "string") {
      return {
        id: parsed.id,
        params: Array.isArray(parsed.params)
          ? parsed.params.filter(isModelParam)
          : undefined,
      }
    }
  } catch {}

  return { id: fallbackModels[0].id }
}

class SessionRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

function isMissingApiKeyError(error: unknown) {
  return error instanceof SessionRequestError && error.code === "missing_api_key"
}

async function requestSession(
  apiKey?: string,
  sessionId?: string,
  options?: { persistApiKey?: boolean }
): Promise<Session> {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey,
      persistApiKey: options?.persistApiKey,
      sessionId,
    }),
  })
  const data = (await response.json()) as {
    code?: string
    error?: string
  }

  if (!response.ok) {
    throw new SessionRequestError(
      data.error ?? "Failed to create a session.",
      data.code
    )
  }

  return data as Session
}

function getConversationById(
  conversations: Conversation[],
  conversationId: string
) {
  return conversations.find((conversation) => conversation.id === conversationId)
}

function createRuntimeState(): ConversationRuntimeState {
  return {
    isRunning: false,
    isCreatingSession: false,
    isCursorTyping: false,
    sessionError: null,
  }
}

function createEmptyConversation(title: string): Conversation {
  const now = Date.now()
  return {
    id: createConversationId(),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
    input: "",
    model: fallbackModelSelection,
    session: null,
  }
}

function createConversationId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }

  return `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getNextConversationTitle(conversations: Conversation[]) {
  const nextNumber =
    conversations.reduce((highest, conversation) => {
      const [, number] = conversation.title.match(/^Project (\d+)$/) ?? []
      return number ? Math.max(highest, Number(number)) : highest
    }, 0) + 1

  return `Project ${nextNumber}`
}

function shouldGenerateProjectName(conversation: Conversation) {
  return isPlaceholderProjectTitle(conversation.title)
}

function isPlaceholderProjectTitle(title: string) {
  const normalized = title.trim()
  return (
    !normalized ||
    normalized === "Untitled project" ||
    /^Project \d+$/i.test(normalized)
  )
}

function sanitizeProjectTitle(value: string) {
  const title = value
    .replace(/[`*_#>]+/g, "")
    .replace(/^[-\s"']+|[-\s"'.:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()

  if (!title) {
    return ""
  }

  return title.length > 42 ? `${title.slice(0, 39).trim()}...` : title
}

function getProjectNameErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    return "Project name generation timed out. Try again."
  }

  const message = error instanceof Error ? error.message.trim() : ""
  if (!message) {
    return "Could not generate a project name."
  }

  if (/project name generation timed out/i.test(message)) {
    return message
  }

  if (/^could not generate (a )?project name\.?$/i.test(message)) {
    return "Could not generate a project name."
  }

  return `Could not generate a project name. ${message}`
}

function getConversationPreview(conversation: Conversation) {
  const lastMessage = [...conversation.messages]
    .reverse()
    .find((message) => getMessageDisplayRole(message) !== "activity")
  const preview = lastMessage?.content.replace(/\s+/g, " ").trim()

  if (preview) {
    return preview.length > 48 ? `${preview.slice(0, 45)}...` : preview
  }

  return conversation.session ? "Preview ready" : "No preview yet"
}

function getProjectNameMessages(conversation: Conversation): ProjectNameMessage[] {
  const messages = conversation.messages
    .filter(
      (message): message is ChatMessage & { role: ProjectNameMessage["role"] } =>
        message.role === "assistant" || message.role === "user"
    )
    .map((message) => ({
      role: message.role,
      content: message.content.replace(/\s+/g, " ").trim(),
    }))
    .filter((message) => message.content)

  const firstUserMessageIndex = messages.findIndex(
    (message) => message.role === "user"
  )
  if (firstUserMessageIndex === -1) {
    return []
  }

  const conversationContext = messages.slice(firstUserMessageIndex)
  return conversationContext.length > 12
    ? [conversationContext[0], ...conversationContext.slice(-11)]
    : conversationContext
}

/** Client-only: restores chats after SSR hydration so markup matches server on first paint. */
function readPersistedAppStateFromStorage(): PersistedAppState {
  try {
    const raw = window.localStorage.getItem(SAVED_CHAT_STATE)
    if (!raw) {
      return createInitialAppState()
    }

    const parsed = JSON.parse(raw) as unknown
    const appState = parsePersistedAppState(parsed)
    if (appState) {
      return appState
    }
  } catch {
    return createInitialAppState()
  }

  return createInitialAppState()
}

function createInitialAppState(): PersistedAppState {
  const conversation = createEmptyConversation("Project 1")
  return {
    version: 2,
    activeConversationId: conversation.id,
    conversations: [conversation],
  }
}

function parsePersistedAppState(value: unknown): PersistedAppState | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const parsed = value as Partial<PersistedAppState>
  if (parsed.version !== 2 || !Array.isArray(parsed.conversations)) {
    return null
  }

  const conversations = parsed.conversations
    .map(normalizePersistedConversation)
    .filter((conversation): conversation is Conversation => Boolean(conversation))

  if (conversations.length === 0) {
    return null
  }

  const activeConversationId =
    typeof parsed.activeConversationId === "string" &&
    conversations.some(
      (conversation) => conversation.id === parsed.activeConversationId
    )
      ? parsed.activeConversationId
      : conversations[0].id

  return {
    version: 2,
    activeConversationId,
    conversations,
  }
}

function normalizePersistedConversation(value: unknown): Conversation | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const conversation = value as Partial<Conversation>
  if (
    typeof conversation.id !== "string" ||
    typeof conversation.title !== "string"
  ) {
    return null
  }

  return {
    id: conversation.id,
    title: conversation.title || "Untitled project",
    createdAt: isFiniteTimestamp(conversation.createdAt)
      ? conversation.createdAt
      : Date.now(),
    updatedAt: isFiniteTimestamp(conversation.updatedAt)
      ? conversation.updatedAt
      : Date.now(),
    messages: Array.isArray(conversation.messages)
      ? compactActivityMessages(conversation.messages.filter(isChatMessage))
      : [],
    input: typeof conversation.input === "string" ? conversation.input : "",
    model:
      typeof conversation.model === "string"
        ? conversation.model
        : fallbackModelSelection,
    session: normalizeSession(conversation.session),
  }
}

function normalizeSession(value: unknown): Session | null {
  if (!isSession(value)) {
    return null
  }

  return {
    ...value,
    models: ensureModelCatalog(value.models),
    user: isCurrentUser(value.user) ? value.user : null,
  }
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function writePersistedAppState(state: PersistedAppState) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.setItem(SAVED_CHAT_STATE, JSON.stringify(state))
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") {
    return false
  }

  const message = value as Partial<ChatMessage>
  return (
    typeof message.id === "string" &&
    typeof message.content === "string" &&
    (message.activityCount === undefined ||
      (typeof message.activityCount === "number" &&
        Number.isFinite(message.activityCount))) &&
    (message.activityGroupKey === undefined ||
      typeof message.activityGroupKey === "string") &&
    (message.activityIcon === undefined ||
      isActivityIcon(message.activityIcon)) &&
    (message.activityState === undefined ||
      message.activityState === "active" ||
      message.activityState === "complete") &&
    (message.activityTargets === undefined ||
      (Array.isArray(message.activityTargets) &&
        message.activityTargets.every((target) => typeof target === "string"))) &&
    (message.role === "activity" ||
      message.role === "assistant" ||
      message.role === "user" ||
      message.role === "system")
  )
}

function isActivityIcon(value: unknown): value is ActivityIcon {
  return typeof value === "string" && value in activityIconMap
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") {
    return false
  }

  const session = value as Partial<Session>
  return (
    typeof session.id === "string" &&
    typeof session.previewUrl === "string" &&
    typeof session.projectPath === "string" &&
    Array.isArray(session.models) &&
    (session.user === null ||
      session.user === undefined ||
      isCurrentUser(session.user))
  )
}
