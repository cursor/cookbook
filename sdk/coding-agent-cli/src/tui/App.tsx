import React, { useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useApp, useInput, useWindowSize } from "ink"
import SelectInput from "ink-select-input"
import TextInput from "ink-text-input"

import {
  CodingAgentSession,
  type ExecutionMode,
  formatDuration,
  formatModelLabel,
  type AgentEvent,
  type ModelChoice,
} from "../agent.js"
import {
  getSlashCommand,
  getSlashCommandItems,
  type SlashCommandName,
} from "../commands.js"
import type { ModelSelection } from "@cursor/sdk"

type TuiAppProps = {
  apiKey: string
  cwd: string
  force: boolean
  initialModel: ModelSelection
}

type TranscriptEntry = {
  id: string
  kind: "assistant" | "error" | "meta" | "status" | "tool" | "user"
  label: string
  text: string
}

type ModelSelectItem = {
  key?: string
  label: string
  value: ModelSelection
}

type CommandSelectItem = {
  key?: string
  label: string
  value: SlashCommandName
}

type ModelPreference = {
  fast: boolean
  thinking: boolean
}

type ViewMode = "command" | "input" | "model"

export function App({ apiKey, cwd, force, initialModel }: TuiAppProps) {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const sessionRef = useRef<CodingAgentSession | null>(null)
  const nextIdRef = useRef(0)
  const [busy, setBusy] = useState(false)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [executionMode, setExecutionModeState] = useState<ExecutionMode>("local")
  const [input, setInput] = useState("")
  const [mode, setMode] = useState<ViewMode>("input")
  const [model, setModel] = useState<ModelSelection>(initialModel)
  const [modelItems, setModelItems] = useState<ModelSelectItem[]>([])
  const [modelSearch, setModelSearch] = useState("")
  const [modelPreference, setModelPreference] = useState<ModelPreference>({
    fast: false,
    thinking: false,
  })
  const [loadingModels, setLoadingModels] = useState(false)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])

  if (!sessionRef.current) {
    sessionRef.current = new CodingAgentSession({
      apiKey,
      cwd,
      force,
      model: initialModel,
    })
  }

  useEffect(() => {
    const session = sessionRef.current

    return () => {
      void session?.dispose()
    }
  }, [])

  useInput((character, key) => {
    if (mode === "model" && key.escape) {
      setMode("input")
      return
    }

    if (mode === "model") {
      const normalizedCharacter = character.toLowerCase()

      if (key.backspace || key.delete) {
        setModelSearch((value) => value.slice(0, -1))
      } else if (normalizedCharacter === "t") {
        toggleModelPreference("thinking")
      } else if (normalizedCharacter === "f") {
        toggleModelPreference("fast")
      } else if (isSearchInput(character)) {
        setModelSearch((value) => `${value}${character}`)
      }

      return
    }

    if (mode === "command" && key.escape) {
      setInput("")
      setMode("input")
      return
    }

    if (mode === "input" && busy && key.ctrl && character === "c") {
      if (!cancelRequested) {
        void cancelActiveRun()
      }
      return
    }

    if (mode === "input" && !busy && key.ctrl && character === "c") {
      exit()
      return
    }

    if (mode === "input") {
      const pageSize = Math.max(1, transcriptViewportRows - 1)
      const maxScrollOffset = Math.max(0, transcriptLines.length - transcriptViewportRows)

      if (key.upArrow) {
        setScrollOffset((offset) => Math.min(maxScrollOffset, offset + 1))
      } else if (key.downArrow) {
        setScrollOffset((offset) => Math.max(0, offset - 1))
      } else if (key.pageUp) {
        setScrollOffset((offset) => Math.min(maxScrollOffset, offset + pageSize))
      } else if (key.pageDown) {
        setScrollOffset((offset) => Math.max(0, offset - pageSize))
      } else if (key.home) {
        setScrollOffset(maxScrollOffset)
      } else if (key.end) {
        setScrollOffset(0)
      }
    }
  })

  const transcriptViewportRows = Math.max(
    4,
    rows - (mode === "model" || mode === "command" ? 10 : 6)
  )
  const scrollableEntries = useMemo(
    () => [
      { id: "status-cwd", kind: "meta" as const, label: "cwd", text: cwd },
      {
        id: "status-mode",
        kind: "meta" as const,
        label: "mode",
        text: `${executionMode} - ${sessionRef.current?.executionTarget ?? cwd}`,
      },
      {
        id: "status-model",
        kind: "meta" as const,
        label: "model",
        text: formatModelLabel(model),
      },
      ...transcript,
    ],
    [cwd, executionMode, model, transcript]
  )
  const transcriptLines = useMemo(
    () => buildTranscriptLines(scrollableEntries, columns),
    [columns, scrollableEntries]
  )
  const maxScrollOffset = Math.max(0, transcriptLines.length - transcriptViewportRows)
  const effectiveScrollOffset = Math.min(scrollOffset, maxScrollOffset)
  const visibleTranscriptLines = useMemo(() => {
    const end = transcriptLines.length - effectiveScrollOffset
    const start = Math.max(0, end - transcriptViewportRows)
    return transcriptLines.slice(start, end)
  }, [effectiveScrollOffset, transcriptLines, transcriptViewportRows])

  useEffect(() => {
    setScrollOffset((offset) => Math.min(offset, maxScrollOffset))
  }, [maxScrollOffset])

  const commandItems = useMemo<CommandSelectItem[]>(
    () => getSlashCommandItems(input),
    [input]
  )
  const filteredModelItems = useMemo(
    () => filterModelItems(modelItems, modelSearch, modelPreference),
    [modelItems, modelPreference, modelSearch]
  )

  const submitInput = (value: string) => {
    const prompt = value.trim()
    setInput("")

    if (!prompt || busy) {
      return
    }

    if (prompt.startsWith("/")) {
      void runCommand(prompt)
      return
    }

    void sendPrompt(prompt)
  }

  const runCommand = async (rawCommand: string) => {
    const command = getSlashCommand(rawCommand)
    setMode("input")
    setInput("")

    switch (command) {
      case "/help":
        setInput("/")
        setMode("command")
        break
      case "/model":
        await openModelPicker()
        break
      case "/local":
        await switchExecutionMode("local")
        break
      case "/cloud":
        await switchExecutionMode("cloud")
        break
      case "/reset":
        await resetAgent()
        break
      case "/exit":
      case "/quit":
        exit()
        break
      default:
        addEntry("error", "command", `Unknown command: ${rawCommand}. Type /help.`)
        break
    }
  }

  const openModelPicker = async () => {
    const session = sessionRef.current
    if (!session) {
      return
    }

    setLoadingModels(true)
    setModelSearch("")
    setModelPreference({
      fast: getSelectionPreference(model, "fast") === true,
      thinking: getSelectionPreference(model, "thinking") === true,
    })
    setMode("model")

    try {
      const choices = await session.listModels()
      setModelItems(
        choices.map((choice) => ({
          key: modelKey(choice),
          label: choice.description
            ? `${choice.label} - ${choice.description}`
            : choice.label,
          value: choice.value,
        }))
      )
    } catch (error) {
      setMode("input")
      addEntry("error", "model", getErrorMessage(error))
    } finally {
      setLoadingModels(false)
    }
  }

  const selectModel = (item: ModelSelectItem) => {
    const selection =
      findPreferredSelection(item.value, modelItems, modelPreference) ?? item.value
    sessionRef.current?.setModel(selection)
    setModel(selection)
    setMode("input")
  }

  const toggleModelPreference = (preference: keyof ModelPreference) => {
    setModelPreference((current) => {
      const next = { ...current, [preference]: !current[preference] }
      const selection = findPreferredSelection(model, modelItems, next)

      if (selection) {
        sessionRef.current?.setModel(selection)
        setModel(selection)
      }

      return next
    })
  }

  const selectCommand = (item: CommandSelectItem) => {
    void runCommand(item.value)
  }

  const resetAgent = async () => {
    const session = sessionRef.current
    if (!session || busy) {
      return
    }

    setBusy(true)

    try {
      await session.reset()
      setTranscript([])
      setScrollOffset(0)
    } catch (error) {
      addEntry("error", "reset", getErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const switchExecutionMode = async (nextMode: ExecutionMode) => {
    const session = sessionRef.current
    if (!session || busy) {
      return
    }

    if (session.executionMode === nextMode) {
      addEntry("status", "mode", `Already using ${nextMode} execution.`)
      return
    }

    setBusy(true)

    try {
      await session.setExecutionMode(nextMode)
      setExecutionModeState(nextMode)
      addEntry(
        "status",
        "mode",
        `Switched to ${nextMode} execution. Target: ${session.executionTarget}.`
      )
    } catch (error) {
      addEntry("error", "mode", getErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const sendPrompt = async (prompt: string) => {
    const session = sessionRef.current
    if (!session) {
      return
    }

    const assistantId = nextId()
    setBusy(true)
    setCancelRequested(false)
    setScrollOffset(0)
    setTranscript((items) => [
      ...items,
      { id: nextId(), kind: "user", label: "you", text: prompt },
    ])

    try {
      await session.sendPrompt({
        prompt,
        onEvent: (event) => {
          setTranscript((items) => applyAgentEvent(items, event, assistantId))
        },
      })
    } catch (error) {
      addEntry("error", "run", getErrorMessage(error))
    } finally {
      setBusy(false)
      setCancelRequested(false)
    }
  }

  const cancelActiveRun = async () => {
    const session = sessionRef.current
    if (!session || cancelRequested) {
      return
    }

    setCancelRequested(true)

    try {
      const result = await session.cancelCurrentRun()

      if (result.cancelled) {
        addEntry("status", "run", "Cancellation requested.")
      } else {
        setCancelRequested(false)
        addEntry("error", "cancel", result.reason)
      }
    } catch (error) {
      setCancelRequested(false)
      addEntry("error", "cancel", getErrorMessage(error))
    }
  }

  const addEntry = (
    kind: TranscriptEntry["kind"],
    label: string,
    text: string
  ) => {
    setTranscript((items) => [
      ...items,
      {
        id: nextId(),
        kind,
        label,
        text,
      },
    ])
  }

  const nextId = () => {
    const id = nextIdRef.current
    nextIdRef.current += 1
    return String(id)
  }

  return (
    <Box flexDirection="column" height={rows} paddingX={1}>
      <Box flexDirection="column" height={transcriptViewportRows}>
        {visibleTranscriptLines.map((line) => (
          <TranscriptLine key={line.id} line={line} />
        ))}
      </Box>

      {maxScrollOffset > 0 ? (
        <Text color="gray">
          Scroll: Up/Down PgUp/PgDn Home/End -{" "}
          {effectiveScrollOffset === 0 ? "at bottom" : `${effectiveScrollOffset} lines up`}
        </Text>
      ) : null}

      {mode === "command" ? (
        <Box
          borderStyle="single"
          borderColor="cyan"
          flexDirection="column"
          marginTop={1}
          paddingX={1}
        >
          <Text bold>Commands</Text>
          <Text color="gray">Use arrows and Enter, or Escape to cancel.</Text>
          <SelectInput
            items={commandItems}
            isFocused={mode === "command"}
            limit={Math.min(6, Math.max(3, rows - 10))}
            onSelect={selectCommand}
          />
        </Box>
      ) : mode === "model" ? (
        <Box
          borderStyle="single"
          borderColor="magenta"
          flexDirection="column"
          marginTop={1}
          paddingX={1}
        >
          <Text bold>Select a model</Text>
          <Text color="gray">
            Type to search - T thinking {modelPreference.thinking ? "on" : "off"} - F fast{" "}
            {modelPreference.fast ? "on" : "off"} - Enter choose - Escape cancel
          </Text>
          <Text color="gray">Search: {modelSearch || "all models"}</Text>
          {loadingModels ? (
            <Text color="yellow">Loading models...</Text>
          ) : filteredModelItems.length === 0 ? (
            <Text color="yellow">No matching models.</Text>
          ) : (
            <SelectInput
              items={filteredModelItems}
              isFocused={mode === "model"}
              limit={Math.min(8, Math.max(3, rows - 10))}
              onSelect={selectModel}
            />
          )}
        </Box>
      ) : (
        <Box
          borderStyle="single"
          borderColor={busy ? "yellow" : "green"}
          marginTop={1}
          paddingX={1}
        >
          <TextInput
            focus={!busy}
            placeholder={
              busy
                ? cancelRequested
                  ? "Cancelling the current run..."
                  : "Waiting for the current run... Ctrl+C to cancel"
                : "Ask or type /help"
            }
            value={input}
            onChange={(value) => {
              setInput(value)
              if (!busy && value.startsWith("/")) {
                setMode("command")
              }
            }}
            onSubmit={submitInput}
          />
        </Box>
      )}
    </Box>
  )
}

type TranscriptLine = {
  id: string
  kind: TranscriptEntry["kind"]
  label: string
  parts: TranscriptPart[]
}

type TranscriptPart = {
  text: string
  bold?: boolean
  color?: "blue" | "cyan" | "gray" | "green" | "magenta" | "red" | "white" | "yellow"
  dimColor?: boolean
}

function TranscriptLine({ line }: { line: TranscriptLine }) {
  const color = {
    assistant: "white",
    error: "red",
    meta: "cyan",
    status: "yellow",
    tool: "magenta",
    user: "green",
  }[line.kind]

  return (
    <Box>
      <Text color={color} bold>
        {line.label.padEnd(7)}
      </Text>
      <Text>
        {line.parts.map((part, index) => (
          <Text
            key={index}
            bold={part.bold}
            color={part.color}
            dimColor={part.dimColor}
          >
            {part.text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

function buildTranscriptLines(entries: TranscriptEntry[], columns: number) {
  const labelWidth = 7
  const textWidth = Math.max(20, columns - labelWidth - 4)

  return entries.flatMap((entry) => {
    const renderedLines = trimTrailingBlankLines(
      entry.kind === "assistant"
        ? renderMarkdownLines(entry.text || "...", textWidth)
        : wrapText(entry.text || "...", textWidth).map((text) => ({
            parts: [{ text }],
          }))
    )

    return renderedLines.map((line, index) => ({
      id: `${entry.id}-${index}`,
      kind: entry.kind,
      label: index === 0 ? entry.label : "",
      parts: line.parts,
    }))
  })
}

function trimTrailingBlankLines(lines: Array<{ parts: TranscriptPart[] }>) {
  let end = lines.length

  while (end > 1 && isBlankRenderedLine(lines[end - 1])) {
    end -= 1
  }

  return lines.slice(0, end)
}

function isBlankRenderedLine(line: { parts: TranscriptPart[] }) {
  return line.parts.every((part) => part.text.trim() === "")
}

function renderMarkdownLines(value: string, width: number) {
  const lines: Array<{ parts: TranscriptPart[] }> = []
  let inCodeBlock = false

  for (const rawLine of value.split("\n")) {
    const line = rawLine.trimEnd()
    const fence = line.match(/^```\s*(.*)$/)

    if (fence) {
      inCodeBlock = !inCodeBlock
      const language = fence[1]?.trim()
      lines.push({
        parts: [
          {
            text: inCodeBlock
              ? `--- code${language ? `: ${language}` : ""}`
              : "--- end code",
            color: "gray",
            dimColor: true,
          },
        ],
      })
      continue
    }

    if (inCodeBlock) {
      for (const text of wrapText(line || " ", width - 2)) {
        lines.push({
          parts: [{ text: `| ${text}`, color: "gray" }],
        })
      }
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      for (const text of wrapText(heading[2] ?? "", width - 2)) {
        lines.push({
          parts: [{ text: `# ${text}`, bold: true, color: "cyan" }],
        })
      }
      continue
    }

    const blockquote = line.match(/^>\s?(.*)$/)
    if (blockquote) {
      for (const text of wrapText(blockquote[1] || " ", width - 2)) {
        lines.push({
          parts: [
            { text: "> ", color: "gray", dimColor: true },
            ...parseInlineMarkdown(text),
          ],
        })
      }
      continue
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/)
    if (unordered) {
      for (const [index, text] of wrapText(unordered[1] ?? "", width - 2).entries()) {
        lines.push({
          parts: [
            { text: index === 0 ? "- " : "  ", color: "cyan" },
            ...parseInlineMarkdown(text),
          ],
        })
      }
      continue
    }

    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/)
    if (ordered) {
      const marker = `${ordered[1]}. `
      for (const [index, text] of wrapText(ordered[2] ?? "", width - marker.length).entries()) {
        lines.push({
          parts: [
            { text: index === 0 ? marker : " ".repeat(marker.length), color: "cyan" },
            ...parseInlineMarkdown(text),
          ],
        })
      }
      continue
    }

    for (const text of wrapText(line, width)) {
      lines.push({ parts: parseInlineMarkdown(text) })
    }
  }

  return lines
}

function wrapText(value: string, width: number) {
  const lines: string[] = []

  for (const rawLine of value.split("\n")) {
    let line = rawLine

    if (!line) {
      lines.push("")
      continue
    }

    while (line.length > width) {
      let breakAt = line.lastIndexOf(" ", width)
      if (breakAt < width * 0.5) {
        breakAt = width
      }

      lines.push(line.slice(0, breakAt).trimEnd())
      line = line.slice(breakAt).trimStart()
    }

    lines.push(line)
  }

  return lines
}

function parseInlineMarkdown(value: string): TranscriptPart[] {
  const parts: TranscriptPart[] = []
  const pattern = /(`[^`]+`|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/\S+))/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) {
      parts.push({ text: value.slice(lastIndex, match.index) })
    }

    const token = match[0]
    if (token.startsWith("`")) {
      parts.push({
        text: token.slice(1, -1),
        color: "yellow",
      })
    } else if (match[2] && match[3]) {
      parts.push({ text: match[2], color: "blue" })
      parts.push({ text: ` (${match[3]})`, color: "gray", dimColor: true })
    } else {
      parts.push({ text: token, color: "blue" })
    }

    lastIndex = match.index + token.length
  }

  if (lastIndex < value.length) {
    parts.push({ text: value.slice(lastIndex) })
  }

  return parts.length > 0 ? parts : [{ text: "" }]
}

function appendAssistantDelta(
  items: TranscriptEntry[],
  assistantId: string,
  text: string
) {
  const last = items.at(-1)

  if (last?.kind === "assistant" && last.id.startsWith(`assistant-${assistantId}`)) {
    return items.map((item, index) =>
      index === items.length - 1 ? { ...item, text: item.text + text } : item
    )
  }

  const segmentCount = items.filter((item) =>
    item.id.startsWith(`assistant-${assistantId}`)
  ).length

  return [
    ...items,
    {
      id: `assistant-${assistantId}-${segmentCount}`,
      kind: "assistant" as const,
      label: "agent",
      text,
    },
  ]
}

function applyAgentEvent(
  items: TranscriptEntry[],
  event: AgentEvent,
  assistantId: string
): TranscriptEntry[] {
  switch (event.type) {
    case "assistant_delta":
      return appendAssistantDelta(items, assistantId, event.text)
    case "thinking": {
      const text = compactText(event.text)
      return text
        ? upsertEntry(items, `thinking-${assistantId}`, "status", "think", text)
        : items
    }
    case "tool": {
      const id = event.callId
        ? `tool-${event.callId}`
        : `tool-${assistantId}-${event.name}`
      return upsertEntry(
        items,
        id,
        "tool",
        "tool",
        [
          formatToolStatus(event.status),
          formatToolIcon(event.name),
          event.name,
          event.params,
        ]
          .filter(Boolean)
          .join(" ")
      )
    }
    case "status":
      return ["CREATING", "RUNNING", "FINISHED"].includes(event.status)
        ? items
        : upsertEntry(
            items,
            `status-${assistantId}`,
            event.status === "ERROR" ? "error" : "status",
            "run",
            `${formatRunStatus(event.status)}${event.message ? ` ${event.message}` : ""}`
          )
    case "task": {
      const text = compactText([event.status, event.text].filter(Boolean).join(" "))
      return text
        ? upsertEntry(items, `task-${assistantId}`, "status", "task", text)
        : items
    }
    case "result": {
      const details = [
        event.status !== "finished" ? `status=${event.status}` : undefined,
        event.durationMs ? `duration=${formatDuration(event.durationMs)}` : undefined,
        event.usage?.inputTokens ? `input=${event.usage.inputTokens}` : undefined,
        event.usage?.outputTokens ? `output=${event.usage.outputTokens}` : undefined,
      ].filter(Boolean)

      return details.length > 0
        ? [...items, makeEntry("meta", "done", details.join(" "))]
        : items
    }
  }
}

function upsertEntry(
  items: TranscriptEntry[],
  id: string,
  kind: TranscriptEntry["kind"],
  label: string,
  text: string
) {
  const existingIndex = items.findIndex((item) => item.id === id)

  if (existingIndex === -1) {
    return [...items, { id, kind, label, text }]
  }

  return items.map((item, index) =>
    index === existingIndex ? { ...item, kind, label, text } : item
  )
}

function makeEntry(
  kind: TranscriptEntry["kind"],
  label: string,
  text: string
): TranscriptEntry {
  return {
    id: `${Date.now()}-${Math.random()}`,
    kind,
    label,
    text,
  }
}

function compactText(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function formatToolStatus(status: string) {
  switch (status) {
    case "requested":
      return "[ ]"
    case "running":
      return "[~]"
    case "completed":
      return "[x]"
    case "error":
      return "[!]"
    default:
      return status.toLowerCase()
  }
}

function formatToolIcon(name: string) {
  const key = name.toLowerCase()

  if (key.includes("read")) {
    return "[R]"
  }

  if (key.includes("glob") || key.includes("grep") || key.includes("search")) {
    return "[S]"
  }

  if (key.includes("shell") || key.includes("terminal") || key.includes("command")) {
    return "$"
  }

  if (
    key.includes("edit") ||
    key.includes("write") ||
    key.includes("patch") ||
    key.includes("delete")
  ) {
    return "[E]"
  }

  if (key.includes("todo") || key.includes("task")) {
    return "[T]"
  }

  return "[*]"
}

function formatRunStatus(status: string) {
  switch (status) {
    case "ERROR":
      return "error"
    case "CANCELLED":
      return "cancelled"
    case "EXPIRED":
      return "expired"
    default:
      return status.toLowerCase()
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function modelKey(choice: ModelChoice) {
  return JSON.stringify(choice.value)
}

function filterModelItems(
  items: ModelSelectItem[],
  search: string,
  preference: ModelPreference
) {
  const normalizedSearch = normalizeToken(search)

  return items.filter((item) => {
    const matchesSearch =
      !normalizedSearch ||
      normalizeToken(`${item.label} ${selectionSearchText(item.value)}`).includes(
        normalizedSearch
      )
    const matchesThinking =
      !preference.thinking ||
      getSelectionPreference(item.value, "thinking") === true
    const matchesFast =
      !preference.fast ||
      getSelectionPreference(item.value, "fast") === true

    return matchesSearch && matchesThinking && matchesFast
  })
}

function findPreferredSelection(
  current: ModelSelection,
  items: ModelSelectItem[],
  preference: ModelPreference
) {
  const sameModelItems = items.filter((item) => item.value.id === current.id)

  if (sameModelItems.length === 0) {
    return undefined
  }

  let candidates = sameModelItems
  for (const key of ["thinking", "fast"] as const) {
    if (!modelSupportsPreference(sameModelItems, key)) {
      continue
    }

    const desired = preference[key]
    const matching = candidates.filter((item) => {
      const value = getSelectionPreference(item.value, key)
      return desired ? value === true : value !== true
    })

    if (matching.length > 0) {
      candidates = matching
    }
  }

  return candidates.sort(
    (left, right) =>
      selectionOverlapScore(right.value, current) -
      selectionOverlapScore(left.value, current)
  )[0]?.value
}

function modelSupportsPreference(
  items: ModelSelectItem[],
  preference: keyof ModelPreference
) {
  return items.some(
    (item) => getSelectionPreference(item.value, preference) !== undefined
  )
}

function getSelectionPreference(
  selection: ModelSelection,
  preference: keyof ModelPreference
) {
  for (const param of selection.params ?? []) {
    const key = normalizeToken(`${param.id} ${param.value}`)
    if (key.includes(preference)) {
      return !isFalseValue(key)
    }
  }

  const idKey = normalizeToken(selection.id)
  return idKey.includes(preference) ? !isFalseValue(idKey) : undefined
}

function selectionOverlapScore(left: ModelSelection, right: ModelSelection) {
  const rightParams = new Set(
    (right.params ?? []).map((param) => `${param.id}=${param.value}`)
  )

  return (left.params ?? []).filter((param) =>
    rightParams.has(`${param.id}=${param.value}`)
  ).length
}

function selectionSearchText(selection: ModelSelection) {
  return [
    selection.id,
    ...(selection.params ?? []).flatMap((param) => [param.id, param.value]),
  ].join(" ")
}

function isSearchInput(input: string) {
  return input.length > 0 && !/[\u0000-\u001F\u007F]/.test(input)
}

function isFalseValue(value: string) {
  return (
    value.includes("false") ||
    value.includes("off") ||
    value.includes("disabled") ||
    value.includes("disable") ||
    value.includes("none") ||
    value.includes("no")
  )
}

function normalizeToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, "")
}
