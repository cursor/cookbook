import { spawn } from "node:child_process"
import { performance } from "node:perf_hooks"
import type { CommandSpec, ProjectInfo } from "./detector.js"

export type TestResult = {
  command: CommandSpec
  durationMs: number
  failureSummary?: string
  ok: boolean
  rawOutput: string
}

export type RunTestsOptions = {
  onOutput?: (chunk: string) => void
}

const FAILURE_TAIL_LINES = 150

export async function runTests(
  project: ProjectInfo,
  testPath: string,
  options: RunTestsOptions = {}
): Promise<TestResult> {
  const command = project.runCommand(testPath)
  const startedAt = performance.now()
  const chunks: string[] = []

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: project.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")

    child.stdout.on("data", (chunk: string) => {
      chunks.push(chunk)
      options.onOutput?.(chunk)
    })

    child.stderr.on("data", (chunk: string) => {
      chunks.push(chunk)
      options.onOutput?.(chunk)
    })

    child.on("error", reject)
    child.on("close", resolve)
  })

  const rawOutput = chunks.join("")
  const ok = exitCode === 0

  return {
    command,
    durationMs: Math.round(performance.now() - startedAt),
    failureSummary: ok ? undefined : summarizeFailure(rawOutput),
    ok,
    rawOutput,
  }
}

export function formatCommand(command: CommandSpec) {
  return [command.command, ...command.args].join(" ")
}

function summarizeFailure(output: string) {
  const lines = output.replace(/\r/g, "").split("\n")
  const meaningfulLines = lines.filter((line) => line.trim().length > 0)
  const tail = meaningfulLines.slice(-FAILURE_TAIL_LINES)

  return tail.join("\n").trim()
}
