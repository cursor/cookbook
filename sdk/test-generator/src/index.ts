#!/usr/bin/env node
import path from "node:path"
import { createInterface } from "node:readline/promises"
import React from "react"
import { render } from "ink"
import {
  normalizeFramework,
  normalizeLanguageOverride,
  type Framework,
  type LanguageOverride,
} from "./detector.js"
import { compactText, formatDuration } from "./format.js"
import { formatCommand } from "./runner.js"
import type { AgentEvent } from "./session.js"
import {
  acceptGeneratedFile,
  detectProjectForOptions,
  generateTestsForFile,
  rejectGeneratedFile,
  resolveTargetFiles,
} from "./workflow.js"

type CliOptions = {
  allowSourceEdits: boolean
  cwd: string
  framework?: Framework
  help: boolean
  language?: LanguageOverride
  maxIters: number
  model: string
  overwrite: boolean
  targets: string[]
  yes: boolean
}

type TuiAppComponent = React.ComponentType<{
  apiKey: string
  cwd: string
  initialModel: { id: string }
  initialOptions: CliOptions
}>

type PositiveIntegerOptions = {
  option: string
  value: string
}

const DEFAULT_MODEL = process.env.CURSOR_MODEL ?? "composer-2"

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    printHelp()
    return
  }

  const apiKey = process.env.CURSOR_API_KEY
  if (!apiKey) {
    throw new Error("Set CURSOR_API_KEY before running the test generator.")
  }

  if (options.targets.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    const tuiModuleUrl = new URL("./tui/App.js", import.meta.url)
    const { App } = (await import(tuiModuleUrl.href)) as { App: TuiAppComponent }
    const instance = render(
      React.createElement(App, {
        apiKey,
        cwd: options.cwd,
        initialModel: { id: options.model },
        initialOptions: options,
      }),
      {
        alternateScreen: true,
        maxFps: 30,
      }
    )
    await instance.waitUntilExit()
    return
  }

  await runPlain(apiKey, options)
}

function parseArgs(argv: string[]): CliOptions {
  const targets: string[] = []
  let allowSourceEdits = false
  let cwd = process.cwd()
  let framework: Framework | undefined
  let help = false
  let language: LanguageOverride | undefined
  let maxIters = 3
  let model = DEFAULT_MODEL
  let overwrite = false
  let yes = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === "--") {
      if (index === 0) {
        continue
      }

      targets.push(...argv.slice(index + 1))
      break
    }

    if (arg === "--help" || arg === "-h") {
      help = true
      continue
    }

    if (arg === "--allow-source-edits") {
      allowSourceEdits = true
      continue
    }

    if (arg === "--overwrite") {
      overwrite = true
      continue
    }

    if (arg === "--yes" || arg === "-y") {
      yes = true
      continue
    }

    if (arg === "--cwd" || arg === "-C") {
      cwd = readOptionValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith("--cwd=")) {
      cwd = arg.slice("--cwd=".length)
      continue
    }

    if (arg === "--lang") {
      language = normalizeLanguageOverride(readOptionValue(argv, index, arg))
      index += 1
      continue
    }

    if (arg.startsWith("--lang=")) {
      language = normalizeLanguageOverride(arg.slice("--lang=".length))
      continue
    }

    if (arg === "--framework") {
      framework = normalizeFramework(readOptionValue(argv, index, arg))
      index += 1
      continue
    }

    if (arg.startsWith("--framework=")) {
      framework = normalizeFramework(arg.slice("--framework=".length))
      continue
    }

    if (arg === "--max-iters") {
      maxIters = readPositiveInteger({
        option: arg,
        value: readOptionValue(argv, index, arg),
      })
      index += 1
      continue
    }

    if (arg.startsWith("--max-iters=")) {
      maxIters = readPositiveInteger({
        option: "--max-iters",
        value: arg.slice("--max-iters=".length),
      })
      continue
    }

    if (arg === "--model" || arg === "-m") {
      model = readOptionValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length)
      continue
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`)
    }

    targets.push(arg)
  }

  return {
    allowSourceEdits,
    cwd: path.resolve(cwd),
    framework,
    help,
    language,
    maxIters,
    model,
    overwrite,
    targets,
    yes,
  }
}

async function runPlain(apiKey: string, options: CliOptions) {
  if (options.targets.length === 0) {
    throw new Error("Provide at least one source file, folder, or glob.")
  }

  const { TestGenSession } = await import("./session.js")
  const project = await detectProjectForOptions(options.cwd, options)
  const files = await resolveTargetFiles(project, options.targets)
  const session = new TestGenSession({
    apiKey,
    cwd: options.cwd,
    model: { id: options.model },
  })

  try {
    for (const file of files) {
      process.stderr.write(`\n[test-gen] ${path.relative(project.cwd, file)}\n`)
      const result = await generateTestsForFile(session, project, file, {
        ...options,
        onEvent: renderPlainEvent,
      })

      process.stderr.write(`\n${result.diff}\n`)

      if (options.yes || (await confirm("Accept generated test file?"))) {
        await acceptGeneratedFile(result)
        process.stderr.write(`[accepted] ${path.relative(project.cwd, result.testPath)}\n`)
      } else {
        await rejectGeneratedFile(result)
        process.stderr.write(`[rejected] ${path.relative(project.cwd, result.testPath)}\n`)
      }
    }
  } finally {
    await session.dispose()
  }
}

function renderPlainEvent(event: AgentEvent) {
  switch (event.type) {
    case "assistant_delta":
      process.stdout.write(event.text)
      break
    case "thinking":
      process.stderr.write(`[thinking] ${compactText(event.text)}\n`)
      break
    case "tool":
      process.stderr.write(
        `[tool] ${event.status} ${event.name}${event.params ? ` ${event.params}` : ""}\n`
      )
      break
    case "status":
      process.stderr.write(
        `[status] ${event.status}${event.message ? ` ${event.message}` : ""}\n`
      )
      break
    case "task":
      process.stderr.write(
        `[task] ${compactText([event.status, event.text].filter(Boolean).join(" "))}\n`
      )
      break
    case "result":
      process.stderr.write(
        `[agent] status=${event.status}${event.durationMs ? ` duration=${formatDuration(event.durationMs)}` : ""}\n`
      )
      break
    case "test_run_started":
      process.stderr.write(`[test] ${formatCommand(event.command)}\n`)
      break
    case "test_run_finished":
      process.stderr.write(
        `[test] ${event.result.ok ? "passed" : "failed"} duration=${formatDuration(event.result.durationMs)}\n`
      )
      break
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

async function confirm(question: string) {
  if (!process.stdin.isTTY) {
    return false
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  try {
    const answer = await readline.question(`${question} [y/N] `)
    return answer.trim().toLowerCase() === "y"
  } finally {
    readline.close()
  }
}

function readOptionValue(argv: string[], index: number, option: string) {
  const value = argv[index + 1]
  if (!value || value.startsWith("-")) {
    throw new Error(`Expected a value after ${option}.`)
  }
  return value
}

function readPositiveInteger({ option, value }: PositiveIntegerOptions) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected ${option} to be a positive integer.`)
  }
  return parsed
}

function printHelp() {
  console.log(`Cursor SDK test generator

Usage:
  test-gen [files...|globs...] [options]
  test-gen [options]

Options:
  -C, --cwd <path>          Workspace root. Defaults to cwd.
      --lang <ts|js|python> Override language detection.
      --framework <name>    Override framework detection: vitest, jest, pytest.
      --max-iters <n>       Test repair iterations. Defaults to 3.
      --allow-source-edits  Let the agent fix source bugs during repair.
      --overwrite           Overwrite existing test files.
  -y, --yes                 Auto-accept generated test files.
  -m, --model <id>          Model id. Defaults to CURSOR_MODEL or composer-2.
  -h, --help                Show this help.

Examples:
  test-gen src/math.ts --yes
  test-gen --lang python app/service.py --max-iters 5
  test-gen
`)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Error: ${message}`)
  process.exitCode = 1
})
