import { existsSync } from "node:fs"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import fg from "fast-glob"
import { detectProject, listSourceFiles, type ProjectInfo } from "./detector.js"
import { runTests, type TestResult } from "./runner.js"
import type { AgentEvent, TestGenSession } from "./session.js"

export type GenerateOptions = {
  allowSourceEdits: boolean
  framework?: ProjectInfo["framework"]
  language?: "js" | "python" | "ts"
  maxIters: number
  overwrite: boolean
}

export type GenerateFileResult = {
  accepted: boolean
  diff: string
  iterations: number
  ok: boolean
  originalTestContent?: string
  sourcePath: string
  testPath: string
  testResult?: TestResult
}

export type GenerateFileOptions = GenerateOptions & {
  onEvent: (event: AgentEvent) => void
}

type UnifiedDiffOptions = {
  after: string
  before: string
  filePath: string
}

export async function detectProjectForOptions(cwd: string, options: GenerateOptions) {
  return detectProject(cwd, {
    framework: options.framework,
    language: options.language,
  })
}

export async function resolveTargetFiles(
  project: ProjectInfo,
  targets: string[]
): Promise<string[]> {
  if (targets.length === 0) {
    return listSourceFiles(project)
  }

  const files = new Set<string>()

  for (const target of targets) {
    const absolute = path.resolve(project.cwd, target)

    if (hasGlobMagic(target)) {
      const matches = await fg(target, {
        cwd: project.cwd,
        absolute: true,
        onlyFiles: true,
      })
      for (const match of matches) {
        files.add(match)
      }
      continue
    }

    const details = await stat(absolute)
    if (details.isDirectory()) {
      const matches = await fg(project.sourceGlobs, {
        cwd: absolute,
        absolute: true,
        onlyFiles: true,
      })
      for (const match of matches) {
        files.add(match)
      }
      continue
    }

    files.add(absolute)
  }

  return Array.from(files).sort((left, right) => left.localeCompare(right))
}

export async function generateTestsForFile(
  session: TestGenSession,
  project: ProjectInfo,
  sourcePath: string,
  options: GenerateFileOptions
): Promise<GenerateFileResult> {
  const testPath = project.testFilePathFor(sourcePath)
  const beforeTest = await readOptionalFile(testPath)

  if (beforeTest !== undefined && !options.overwrite) {
    throw new Error(
      `Refusing to overwrite existing test file ${path.relative(project.cwd, testPath)}. Pass --overwrite to continue.`
    )
  }

  await mkdir(path.dirname(testPath), { recursive: true })

  const sourceContent = await readFile(sourcePath, "utf8")
  await session.generateForFile(
    project,
    {
      allowSourceEdits: options.allowSourceEdits,
      sourceContent,
      sourcePath,
      testPath,
    },
    options.onEvent
  )

  let latestResult: TestResult | undefined
  let repairs = 0
  let testRuns = 0

  while (true) {
    testRuns += 1
    const command = project.runCommand(testPath)
    options.onEvent({ type: "test_run_started", command })
    latestResult = await runTests(project, testPath, {
      onOutput: (chunk) => options.onEvent({ type: "assistant_delta", text: chunk }),
    })
    options.onEvent({ type: "test_run_finished", result: latestResult })

    if (latestResult.ok || repairs >= options.maxIters) {
      break
    }

    const updatedSourceContent = await readFile(sourcePath, "utf8")
    const testContent = await readOptionalFile(testPath)

    await session.iterateRepair(
      project,
      {
        allowSourceEdits: options.allowSourceEdits,
        failureSummary: latestResult.failureSummary ?? latestResult.rawOutput,
        sourceContent: updatedSourceContent,
        sourcePath,
        testContent: testContent ?? "",
        testPath,
      },
      options.onEvent
    )
    repairs += 1
  }

  const afterTest = await readOptionalFile(testPath)

  return {
    accepted: false,
    diff: createUnifiedDiff({
      after: afterTest ?? "",
      before: beforeTest ?? "",
      filePath: path.relative(project.cwd, testPath),
    }),
    iterations: testRuns,
    ok: latestResult?.ok === true,
    originalTestContent: beforeTest,
    sourcePath,
    testPath,
    testResult: latestResult,
  }
}

export async function acceptGeneratedFile(result: GenerateFileResult) {
  result.accepted = true
}

export async function rejectGeneratedFile(result: GenerateFileResult) {
  if (result.originalTestContent !== undefined) {
    await writeFile(result.testPath, result.originalTestContent)
    result.accepted = false
    return
  }

  if (existsSync(result.testPath)) {
    await rm(result.testPath)
  }
  result.accepted = false
}

async function readOptionalFile(filePath: string) {
  try {
    return await readFile(filePath, "utf8")
  } catch {
    return undefined
  }
}

function hasGlobMagic(value: string) {
  return /[*?[\]{}()!+@]/.test(value)
}

function createUnifiedDiff({ after, before, filePath }: UnifiedDiffOptions) {
  if (before === after) {
    return `No changes in ${filePath}`
  }

  const beforeLines = splitDiffLines(before)
  const afterLines = splitDiffLines(after)
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`]
  const max = Math.max(beforeLines.length, afterLines.length)

  for (let index = 0; index < max; index += 1) {
    const left = beforeLines[index]
    const right = afterLines[index]

    if (left === right) {
      if (left !== undefined && left.trim()) {
        lines.push(` ${left}`)
      }
      continue
    }

    if (left !== undefined) {
      lines.push(`-${left}`)
    }

    if (right !== undefined) {
      lines.push(`+${right}`)
    }
  }

  return lines.join("\n")
}

function splitDiffLines(value: string) {
  return value.length === 0 ? [] : value.split("\n")
}
