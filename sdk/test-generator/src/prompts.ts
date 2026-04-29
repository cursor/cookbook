import path from "node:path"
import type { ProjectInfo } from "./detector.js"

export type GeneratePromptOptions = {
  allowSourceEdits: boolean
  sourceContent: string
  sourcePath: string
  testPath: string
}

export type RepairPromptOptions = GeneratePromptOptions & {
  failureSummary: string
  testContent: string
}

const TESTING_GUIDANCE: Record<ProjectInfo["framework"], string> = {
  jest: [
    "Use Jest APIs from the existing project.",
    "Prefer focused unit tests with describe/test/expect.",
    "Do not add new test dependencies.",
  ].join("\n"),
  pytest: [
    "Use Pytest with plain assert statements.",
    "Prefer focused unit tests and local fixtures only when they clarify setup.",
    "Do not add new Python dependencies.",
  ].join("\n"),
  vitest: [
    "Use Vitest APIs from the existing project.",
    "Import test helpers from vitest, for example: import { describe, expect, test } from \"vitest\".",
    "Do not add new test dependencies.",
  ].join("\n"),
}

export function buildGeneratePrompt(
  project: ProjectInfo,
  options: GeneratePromptOptions
) {
  return [
    agentInstructions(project, options),
    "",
    "Task:",
    `Generate a high-value unit test file at ${relative(project, options.testPath)} for ${relative(project, options.sourcePath)}.`,
    "Cover the main happy path, important edge cases, and error paths that are inferable from the source.",
    "Keep the tests small and maintainable.",
    "",
    "Source file:",
    codeFence(options.sourcePath, options.sourceContent),
  ].join("\n")
}

export function buildRepairPrompt(project: ProjectInfo, options: RepairPromptOptions) {
  return [
    agentInstructions(project, options),
    "",
    "Task:",
    `Repair the generated tests at ${relative(project, options.testPath)} so the test command passes.`,
    options.allowSourceEdits
      ? "If the failure exposes a real source bug, you may make the smallest source fix needed."
      : "Do not edit the source file. Only change the generated test file.",
    "",
    "Source file:",
    codeFence(options.sourcePath, options.sourceContent),
    "",
    "Current test file:",
    codeFence(options.testPath, options.testContent),
    "",
    "Failure summary:",
    codeFence("test-output.txt", options.failureSummary),
  ].join("\n")
}

function agentInstructions(
  project: ProjectInfo,
  options: Pick<GeneratePromptOptions, "allowSourceEdits" | "sourcePath" | "testPath">
) {
  return [
    "You are a test generation agent running inside a local workspace.",
    "Your job is to create useful, passing unit tests for the requested source file.",
    `Framework: ${project.framework}.`,
    TESTING_GUIDANCE[project.framework],
    `Write tests only in ${relative(project, options.testPath)}.`,
    options.allowSourceEdits
      ? "Source edits are allowed only when the test failure reveals a real bug."
      : `Do not edit ${relative(project, options.sourcePath)} or any other source file.`,
    "Preserve unrelated user work.",
    "After editing, summarize what behavior the tests cover.",
  ].join("\n")
}

function relative(project: ProjectInfo, filePath: string) {
  return path.relative(project.cwd, filePath) || "."
}

function codeFence(filePath: string, content: string) {
  const extension = path.extname(filePath).slice(1) || "text"
  return [`\`\`\`${extension}`, content.trimEnd(), "```"].join("\n")
}
