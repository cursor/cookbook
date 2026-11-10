import path from "node:path"
import React, { useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useApp, useInput } from "ink"
import SelectInput from "ink-select-input"
import TextInput from "ink-text-input"
import type { ModelSelection } from "@cursor/sdk"
import type { Framework, LanguageOverride, ProjectInfo } from "../detector.js"
import { compactText, formatDuration } from "../format.js"
import { formatCommand } from "../runner.js"
import {
  formatModelLabel,
  type AgentEvent,
  type ModelChoice,
  TestGenSession,
} from "../session.js"
import {
  acceptGeneratedFile,
  detectProjectForOptions,
  generateTestsForFile,
  rejectGeneratedFile,
  resolveTargetFiles,
  type GenerateFileResult,
} from "../workflow.js"
import { FilePicker } from "./FilePicker.js"
import { IterationView } from "./IterationView.js"
import { ReviewPanel } from "./ReviewPanel.js"

type TuiOptions = {
  allowSourceEdits: boolean
  framework?: Framework
  language?: LanguageOverride
  maxIters: number
  overwrite: boolean
  targets: string[]
  yes: boolean
}

type TuiAppProps = {
  apiKey: string
  cwd: string
  initialModel: ModelSelection
  initialOptions: TuiOptions
}

type View = "command" | "error" | "loading" | "model" | "picker" | "review" | "running"

type ModelSelectItem = {
  key?: string
  label: string
  value: ModelSelection
}

export function App({ apiKey, cwd, initialModel, initialOptions }: TuiAppProps) {
  const { exit } = useApp()
  const generationCancelledRef = useRef(false)
  const reviewActionInFlightRef = useRef(false)
  const sessionRef = useRef<TestGenSession | null>(null)
  const [commandInput, setCommandInput] = useState("")
  const [cursorIndex, setCursorIndex] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [model, setModel] = useState<ModelSelection>(initialModel)
  const [modelItems, setModelItems] = useState<ModelSelectItem[]>([])
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [results, setResults] = useState<GenerateFileResult[]>([])
  const [reviewIndex, setReviewIndex] = useState(0)
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [view, setView] = useState<View>("loading")

  if (!sessionRef.current) {
    sessionRef.current = new TestGenSession({
      apiKey,
      cwd,
      model,
    })
  }

  useEffect(() => {
    let mounted = true

    async function loadFiles() {
      try {
        const detected = await detectProjectForOptions(cwd, initialOptions)
        const sourceFiles = await resolveTargetFiles(detected, initialOptions.targets)

        if (!mounted) {
          return
        }

        setProject(detected)
        setFiles(sourceFiles)
        setCursorIndex(0)
        setSelectedFiles(new Set(sourceFiles.slice(0, Math.min(5, sourceFiles.length))))
        setView("picker")
      } catch (error) {
        if (mounted) {
          addLog(`Error: ${getErrorMessage(error)}`)
          setView("error")
        }
      }
    }

    void loadFiles()

    return () => {
      mounted = false
      void sessionRef.current?.dispose()
    }
  }, [cwd, initialOptions])

  useEffect(() => {
    reviewActionInFlightRef.current = false
  }, [reviewIndex, view])

  const selectedCount = selectedFiles.size
  const currentReview = results[reviewIndex]
  const title = useMemo(() => {
    if (!project) {
      return "Test generator"
    }

    return `Test generator - ${project.framework} - ${formatModelLabel(model)}`
  }, [model, project])

  useInput((character, key) => {
    if (key.ctrl && character === "c") {
      if (view === "running") {
        void cancelRun()
      } else {
        exit()
      }
      return
    }

    if (view === "command") {
      if (key.escape) {
        setCommandInput("")
        setView(project ? "picker" : "error")
      }
      return
    }

    if (view === "model" && key.escape) {
      setView(project ? "picker" : "error")
      return
    }

    if (character === "/" && (view === "picker" || view === "error")) {
      setCommandInput("/")
      setView("command")
      return
    }

    if (view === "picker") {
      if (key.upArrow) {
        setCursorIndex((index) => Math.max(0, index - 1))
      } else if (key.downArrow) {
        setCursorIndex((index) => Math.min(Math.max(0, files.length - 1), index + 1))
      } else if (character === " ") {
        toggleCurrentFile()
      } else if (key.return) {
        void startGeneration()
      }
      return
    }

    if (view === "review" && currentReview) {
      if (character === "a") {
        void acceptCurrent()
      } else if (character === "r" || character === "s") {
        void rejectCurrent()
      }
    }
  })

  const runCommand = async (value: string) => {
    const command = value.trim()
    setCommandInput("")

    switch (command) {
      case "/help":
        addLog("Commands: /help /model /cancel /exit")
        setView(project ? "picker" : "error")
        break
      case "/model":
        await openModelPicker()
        break
      case "/cancel":
        await cancelRun()
        setView(project ? "picker" : "error")
        break
      case "/exit":
      case "/quit":
        exit()
        break
      default:
        addLog(`Unknown command: ${command}`)
        setView(project ? "picker" : "error")
        break
    }
  }

  const openModelPicker = async () => {
    const session = sessionRef.current
    if (!session) {
      return
    }

    try {
      const choices = await session.listModels()
      setModelItems(choices.map(modelChoiceToItem))
      setView("model")
    } catch (error) {
      addLog(`Model list failed: ${getErrorMessage(error)}`)
      setView(project ? "picker" : "error")
    }
  }

  const selectModel = (item: ModelSelectItem) => {
    setModel(item.value)
    sessionRef.current?.setModel(item.value)
    addLog(`Model set to ${formatModelLabel(item.value)}`)
    setView(project ? "picker" : "error")
  }

  const toggleCurrentFile = () => {
    const file = files[cursorIndex]
    if (!file) {
      return
    }

    setSelectedFiles((current) => {
      const next = new Set(current)
      if (next.has(file)) {
        next.delete(file)
      } else {
        next.add(file)
      }
      return next
    })
  }

  const startGeneration = async () => {
    const session = sessionRef.current
    if (!session || !project || selectedFiles.size === 0) {
      return
    }

    setView("running")
    setLogs([])
    setResults([])
    generationCancelledRef.current = false
    const nextResults: GenerateFileResult[] = []

    for (const file of selectedFiles) {
      if (generationCancelledRef.current) {
        break
      }

      addLog(`Generating tests for ${path.relative(project.cwd, file)}`)
      try {
        const result = await generateTestsForFile(session, project, file, {
          ...initialOptions,
          onEvent: addEvent,
        })
        nextResults.push(result)
        setResults([...nextResults])
      } catch (error) {
        addLog(`Error: ${getErrorMessage(error)}`)
        if (generationCancelledRef.current) {
          break
        }
      }
    }

    setReviewIndex(0)
    setView(nextResults.length > 0 ? "review" : "picker")
  }

  const acceptCurrent = async () => {
    if (reviewActionInFlightRef.current) {
      return
    }

    const result = results[reviewIndex]
    if (!result) {
      return
    }

    reviewActionInFlightRef.current = true
    await acceptGeneratedFile(result)
    moveToNextReview()
  }

  const rejectCurrent = async () => {
    if (reviewActionInFlightRef.current) {
      return
    }

    const result = results[reviewIndex]
    if (!result) {
      return
    }

    reviewActionInFlightRef.current = true
    await rejectGeneratedFile(result)
    moveToNextReview()
  }

  const moveToNextReview = () => {
    if (reviewIndex + 1 >= results.length) {
      addLog("Review complete.")
      setView("picker")
      return
    }

    setReviewIndex((index) => index + 1)
  }

  const cancelRun = async () => {
    generationCancelledRef.current = true
    const result = await sessionRef.current?.cancelCurrentRun()
    if (result?.cancelled) {
      addLog("Cancelled generation.")
    } else if (result) {
      addLog(result.reason)
    }
  }

  const addEvent = (event: AgentEvent) => {
    switch (event.type) {
      case "assistant_delta":
        addLog(event.text.trim() || ".")
        break
      case "thinking":
        addLog(`thinking: ${compactText(event.text)}`)
        break
      case "tool":
        addLog(`tool: ${event.status} ${event.name}${event.params ? ` ${event.params}` : ""}`)
        break
      case "status":
        addLog(`status: ${event.status}${event.message ? ` ${event.message}` : ""}`)
        break
      case "task":
        addLog(`task: ${compactText([event.status, event.text].filter(Boolean).join(" "))}`)
        break
      case "result":
        addLog(
          `agent: ${event.status}${event.durationMs ? ` in ${formatDuration(event.durationMs)}` : ""}`
        )
        break
      case "test_run_started":
        addLog(`test: ${formatCommand(event.command)}`)
        break
      case "test_run_finished":
        addLog(
          `test: ${event.result.ok ? "passed" : "failed"} in ${formatDuration(event.result.durationMs)}`
        )
        break
      default: {
        const exhaustive: never = event
        return exhaustive
      }
    }
  }

  function addLog(message: string) {
    setLogs((current) => [...current, ...message.split("\n").filter(Boolean)].slice(-200))
  }

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {view === "loading" ? <Text>Loading project...</Text> : null}
      {view === "error" ? (
        <Box flexDirection="column">
          <Text color="red">Could not load project.</Text>
          <Text dimColor>Press / for commands or Ctrl+C to exit.</Text>
          <Box marginTop={1} flexDirection="column">
            {logs.slice(-8).map((log, index) => (
              <Text key={`${index}-${log}`}>{log}</Text>
            ))}
          </Box>
        </Box>
      ) : null}
      {view === "picker" && project ? (
        <>
          <FilePicker
            cursorIndex={cursorIndex}
            files={files}
            project={project}
            selectedFiles={selectedFiles}
          />
          <Text dimColor>
            Selected {selectedCount}/{files.length}
          </Text>
        </>
      ) : null}
      {view === "running" ? <IterationView logs={logs} /> : null}
      {view === "review" && project && currentReview ? (
        <ReviewPanel
          currentIndex={reviewIndex}
          project={project}
          result={currentReview}
          total={results.length}
        />
      ) : null}
      {view === "command" ? (
        <Box>
          <Text color="cyan">Command </Text>
          <TextInput value={commandInput} onChange={setCommandInput} onSubmit={runCommand} />
        </Box>
      ) : null}
      {view === "model" ? (
        <SelectInput items={modelItems} onSelect={selectModel} />
      ) : null}
    </Box>
  )
}

function modelChoiceToItem(choice: ModelChoice): ModelSelectItem {
  return {
    key: choice.label,
    label: choice.description ? `${choice.label} - ${choice.description}` : choice.label,
    value: choice.value,
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
