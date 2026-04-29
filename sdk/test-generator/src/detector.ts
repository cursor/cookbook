import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import fg from "fast-glob"

export type Language = "javascript" | "python" | "typescript"
export type Framework = "jest" | "pytest" | "vitest"
export type LanguageOverride = "js" | "python" | "ts"

export type CommandSpec = {
  command: string
  args: string[]
}

export type DetectOptions = {
  framework?: Framework
  language?: LanguageOverride
}

export type ProjectInfo = {
  cwd: string
  framework: Framework
  language: Language
  packageManager?: "npm" | "pnpm" | "yarn"
  runCommand: (testPath: string) => CommandSpec
  sourceGlobs: string[]
  testFilePathFor: (sourcePath: string) => string
}

type PackageJson = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

const TS_SOURCE_GLOBS = ["**/*.{ts,tsx,js,jsx}", "!**/*.test.*", "!**/*.spec.*"]
const PYTHON_SOURCE_GLOBS = ["**/*.py", "!**/test_*.py", "!**/*_test.py"]
const IGNORED_GLOBS = ["!**/node_modules/**", "!**/dist/**", "!**/.git/**"]

export async function detectProject(
  cwd: string,
  options: DetectOptions = {}
): Promise<ProjectInfo> {
  const language = await detectLanguage(cwd, options.language)
  const framework = await detectFramework(cwd, language, options.framework)

  if (framework === "pytest") {
    return createPythonProject(cwd)
  }

  if (language === "python") {
    throw new Error(`Framework ${framework} is not compatible with Python.`)
  }

  return createJavaScriptProject(cwd, language, framework)
}

export async function listSourceFiles(project: ProjectInfo): Promise<string[]> {
  const entries = await fg([...project.sourceGlobs, ...IGNORED_GLOBS], {
    cwd: project.cwd,
    absolute: true,
    onlyFiles: true,
  })

  return entries.sort((left, right) => left.localeCompare(right))
}

export function normalizeLanguageOverride(
  value: string | undefined
): LanguageOverride | undefined {
  if (!value) {
    return undefined
  }

  if (value === "ts" || value === "js" || value === "python") {
    return value
  }

  throw new Error(`Unsupported language: ${value}. Expected ts, js, or python.`)
}

export function normalizeFramework(value: string | undefined): Framework | undefined {
  if (!value) {
    return undefined
  }

  if (value === "vitest" || value === "jest" || value === "pytest") {
    return value
  }

  throw new Error(`Unsupported framework: ${value}. Expected vitest, jest, or pytest.`)
}

async function detectLanguage(
  cwd: string,
  override: LanguageOverride | undefined
): Promise<Language> {
  if (override) {
    switch (override) {
      case "ts":
        return "typescript"
      case "js":
        return "javascript"
      case "python":
        return "python"
      default: {
        const exhaustive: never = override
        return exhaustive
      }
    }
  }

  if (existsSync(path.join(cwd, "package.json"))) {
    const packageJson = await readPackageJson(cwd)
    if (packageJson && hasDependency(packageJson, "typescript")) {
      return "typescript"
    }
    return "javascript"
  }

  if (
    existsSync(path.join(cwd, "pyproject.toml")) ||
    existsSync(path.join(cwd, "pytest.ini")) ||
    existsSync(path.join(cwd, "setup.cfg"))
  ) {
    return "python"
  }

  throw new Error(
    "Could not detect a supported project. Add package.json, pyproject.toml, pytest.ini, or pass --lang."
  )
}

async function detectFramework(
  cwd: string,
  language: Language,
  override: Framework | undefined
): Promise<Framework> {
  if (override) {
    assertFrameworkMatchesLanguage(language, override)
    return override
  }

  if (language === "python") {
    return "pytest"
  }

  const packageJson = await readPackageJson(cwd)
  if (!packageJson) {
    throw new Error("Could not read package.json. Pass --framework to continue.")
  }

  if (hasDependency(packageJson, "vitest") || scriptMentions(packageJson, "vitest")) {
    return "vitest"
  }

  if (hasDependency(packageJson, "jest") || scriptMentions(packageJson, "jest")) {
    return "jest"
  }

  throw new Error("Could not detect Vitest or Jest. Install one or pass --framework.")
}

function createJavaScriptProject(
  cwd: string,
  language: "javascript" | "typescript",
  framework: "jest" | "vitest"
): ProjectInfo {
  const packageManager = detectPackageManager(cwd)

  return {
    cwd,
    framework,
    language,
    packageManager,
    runCommand: (testPath) => runPackageBin(packageManager, framework, [
      framework === "vitest" ? "run" : testPath,
      ...(framework === "vitest" ? [testPath] : []),
    ]),
    sourceGlobs: TS_SOURCE_GLOBS,
    testFilePathFor: (sourcePath) => {
      const parsed = path.parse(sourcePath)
      return path.join(parsed.dir, `${parsed.name}.test${parsed.ext}`)
    },
  }
}

function createPythonProject(cwd: string): ProjectInfo {
  const pythonCommand = detectPythonCommand()

  return {
    cwd,
    framework: "pytest",
    language: "python",
    runCommand: (testPath) => ({
      command: pythonCommand,
      args: ["-m", "pytest", testPath, "--tb=short", "-q"],
    }),
    sourceGlobs: PYTHON_SOURCE_GLOBS,
    testFilePathFor: (sourcePath) => pythonTestPath(cwd, sourcePath),
  }
}

function detectPythonCommand() {
  for (const command of ["python", "python3"]) {
    try {
      execFileSync(command, ["--version"], {
        stdio: ["ignore", "ignore", "ignore"],
      })
      return command
    } catch {
      continue
    }
  }

  return "python"
}

function pythonTestPath(cwd: string, sourcePath: string) {
  const relative = path.relative(cwd, sourcePath)
  const parsed = path.parse(relative)
  const parts = parsed.dir.split(path.sep).filter(Boolean)
  const srcIndex = parts.lastIndexOf("src")
  const baseParts = srcIndex > 0 ? parts.slice(0, srcIndex) : []
  const testsDir = path.join(cwd, ...baseParts, "tests")

  return path.join(testsDir, `test_${parsed.name}.py`)
}

function assertFrameworkMatchesLanguage(language: Language, framework: Framework) {
  if (language === "python" && framework !== "pytest") {
    throw new Error(`Framework ${framework} is not compatible with Python.`)
  }

  if (language !== "python" && framework === "pytest") {
    throw new Error("Pytest is only compatible with Python projects.")
  }
}

async function readPackageJson(cwd: string): Promise<PackageJson | undefined> {
  try {
    const raw = await readFile(path.join(cwd, "package.json"), "utf8")
    return JSON.parse(raw) as PackageJson
  } catch {
    return undefined
  }
}

function hasDependency(packageJson: PackageJson, name: string) {
  return Boolean(packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name])
}

function scriptMentions(packageJson: PackageJson, command: string) {
  return Object.values(packageJson.scripts ?? {}).some((script) => script.includes(command))
}

function detectPackageManager(cwd: string): "npm" | "pnpm" | "yarn" {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
    return "pnpm"
  }

  if (existsSync(path.join(cwd, "yarn.lock"))) {
    return "yarn"
  }

  return "npm"
}

function runPackageBin(
  packageManager: "npm" | "pnpm" | "yarn",
  bin: string,
  args: string[]
): CommandSpec {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["exec", bin, ...args] }
    case "yarn":
      return { command: "yarn", args: [bin, ...args] }
    case "npm":
      return { command: "npx", args: [bin, ...args] }
    default: {
      const exhaustive: never = packageManager
      return exhaustive
    }
  }
}
