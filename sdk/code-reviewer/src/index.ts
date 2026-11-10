import { Agent } from "@cursor/sdk"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

type Severity = "low" | "medium" | "high" | "critical"
type Category = "bug" | "security" | "performance" | "style" | "design" | "test"

interface ReviewComment {
  file: string
  line: number | null
  severity: Severity
  category: Category
  comment: string
  suggestion: string | null
}

interface ReviewResult {
  summary: string
  comments: ReviewComment[]
}

interface CliArgs {
  base: string
  head: string
  json: boolean
  maxDiffBytes: number
  model: string
  failOn: Severity
  cwd: string
}

const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
}

const SEVERITY_GLYPH: Record<Severity, string> = {
  low: "·",
  medium: "▴",
  high: "▲",
  critical: "⛔",
}

const HELP = `Usage: code-reviewer [options]

Review a git diff with a Cursor SDK agent and emit structured findings.

Options:
  --base <ref>            Base ref to diff against (default: main)
  --head <ref>            Head ref (default: HEAD)
  --json                  Emit machine-readable JSON instead of a human report
  --max-diff-bytes <N>    Refuse diffs larger than N bytes (default: 100000)
  --model <id>            Cursor model id (default: $CURSOR_MODEL or claude-4.6-sonnet-high)
  --fail-on <severity>    Exit non-zero on this severity or higher (default: high)
  --cwd <path>            Working directory for git + agent (default: process.cwd())
  -h, --help              Show this help

Examples:
  pnpm dev -- --base origin/main
  pnpm dev -- --base main --head my-branch --json | jq
  CURSOR_API_KEY=... pnpm dev -- --base HEAD~5 --fail-on critical
`

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    base: "main",
    head: "HEAD",
    json: false,
    maxDiffBytes: 100_000,
    model: process.env.CURSOR_MODEL ?? "claude-4.6-sonnet-high",
    failOn: "high",
    cwd: process.cwd(),
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`Missing value for ${arg}`)
      return v
    }
    switch (arg) {
      case "--base":
        args.base = next()
        break
      case "--head":
        args.head = next()
        break
      case "--json":
        args.json = true
        break
      case "--max-diff-bytes": {
        const n = Number.parseInt(next(), 10)
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error("--max-diff-bytes must be a positive integer")
        }
        args.maxDiffBytes = n
        break
      }
      case "--model":
        args.model = next()
        break
      case "--fail-on": {
        const v = next()
        if (!isSeverity(v)) {
          throw new Error("--fail-on must be one of: low, medium, high, critical")
        }
        args.failOn = v
        break
      }
      case "--cwd":
        args.cwd = next()
        break
      case "-h":
      case "--help":
        process.stdout.write(HELP)
        process.exit(0)
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

async function getDiff(args: CliArgs): Promise<string> {
  // Three-dot diff = changes on `head` since its merge-base with `base`.
  // Matches what GitHub shows on a PR — review only the new work, not upstream drift.
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", `${args.base}...${args.head}`, "--no-color"],
      { cwd: args.cwd, maxBuffer: args.maxDiffBytes },
    )
    return stdout
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    if (e.code === "ENOENT") {
      throw new Error("git not found on PATH")
    }
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error(
        `git diff exceeds --max-diff-bytes (${args.maxDiffBytes}). Narrow the range or raise the limit.`,
      )
    }
    const stderr = (e.stderr ?? "").toLowerCase()
    if (stderr.includes("not a git repository")) {
      throw new Error(`${args.cwd} is not a git repository`)
    }
    if (stderr.includes("unknown revision") || stderr.includes("bad revision")) {
      throw new Error(`Unknown ref. Check --base (${args.base}) and --head (${args.head}).`)
    }
    throw err
  }
}

function reviewerPrompt(diff: string): string {
  return `You are a senior code reviewer. Review the following unified git diff and produce concrete, actionable feedback.

CRITICAL RULES:
1. Reply with ONLY a single JSON object — no prose, no markdown fences.
2. Schema:
   {
     "summary": string,
     "comments": [
       {
         "file": string,
         "line": number | null,
         "severity": "low" | "medium" | "high" | "critical",
         "category": "bug" | "security" | "performance" | "style" | "design" | "test",
         "comment": string,
         "suggestion": string | null
       }
     ]
   }
3. "line" refers to the line number in the new (post-change) file. Use null only for file-level comments.
4. Only flag real defects. Do not invent issues. If the diff is clean, return an empty "comments" array and a brief "summary".
5. Prefer fewer high-signal comments over many nits. Combine related observations.
6. "summary" is one or two sentences on the overall change.

DIFF:
\`\`\`diff
${diff}
\`\`\``
}

function isSeverity(x: unknown): x is Severity {
  return x === "low" || x === "medium" || x === "high" || x === "critical"
}

function isCategory(x: unknown): x is Category {
  return (
    x === "bug" ||
    x === "security" ||
    x === "performance" ||
    x === "style" ||
    x === "design" ||
    x === "test"
  )
}

function extractJson(raw: string): unknown {
  // Strip surrounding markdown code fences first, in case the agent ignored the prompt.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim()
  try {
    return JSON.parse(stripped)
  } catch {
    // Last-ditch: slice from the first `{` to the last `}` and retry.
    const first = stripped.indexOf("{")
    const last = stripped.lastIndexOf("}")
    if (first === -1 || last <= first) {
      throw new Error("Agent response did not contain a JSON object")
    }
    return JSON.parse(stripped.slice(first, last + 1))
  }
}

function validateReview(value: unknown): ReviewResult {
  if (!value || typeof value !== "object") throw new Error("Review must be an object")
  const v = value as Record<string, unknown>
  if (typeof v.summary !== "string") throw new Error("Review.summary must be a string")
  if (!Array.isArray(v.comments)) throw new Error("Review.comments must be an array")

  const comments: ReviewComment[] = v.comments.map((raw, i) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`comments[${i}] must be an object`)
    }
    const c = raw as Record<string, unknown>
    if (typeof c.file !== "string") throw new Error(`comments[${i}].file must be a string`)
    if (
      c.line !== null &&
      (typeof c.line !== "number" || !Number.isInteger(c.line) || c.line < 1)
    ) {
      throw new Error(`comments[${i}].line must be a positive integer or null`)
    }
    if (!isSeverity(c.severity)) throw new Error(`comments[${i}].severity is invalid`)
    if (!isCategory(c.category)) throw new Error(`comments[${i}].category is invalid`)
    if (typeof c.comment !== "string") throw new Error(`comments[${i}].comment must be a string`)
    if (c.suggestion != null && typeof c.suggestion !== "string") {
      throw new Error(`comments[${i}].suggestion must be a string or null`)
    }
    return {
      file: c.file,
      line: c.line as number | null,
      severity: c.severity,
      category: c.category,
      comment: c.comment,
      suggestion: typeof c.suggestion === "string" ? c.suggestion : null,
    }
  })

  return { summary: v.summary, comments }
}

function printHuman(review: ReviewResult): void {
  process.stdout.write(`\n${review.summary}\n`)
  if (review.comments.length === 0) {
    process.stdout.write("\nNo issues found.\n")
    return
  }
  process.stdout.write(`\n${review.comments.length} comment(s):\n\n`)
  const sorted = [...review.comments].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  )
  for (const c of sorted) {
    const where = c.line === null ? c.file : `${c.file}:${c.line}`
    process.stdout.write(`${SEVERITY_GLYPH[c.severity]} [${c.severity}/${c.category}] ${where}\n`)
    process.stdout.write(`  ${c.comment}\n`)
    if (c.suggestion) {
      process.stdout.write(`  suggestion: ${c.suggestion}\n`)
    }
    process.stdout.write("\n")
  }
}

function exitCodeFor(review: ReviewResult, failOn: Severity): number {
  const threshold = SEVERITY_RANK[failOn]
  return review.comments.some((c) => SEVERITY_RANK[c.severity] >= threshold) ? 1 : 0
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!process.env.CURSOR_API_KEY) {
    process.stderr.write(
      "CURSOR_API_KEY is not set. Create one at https://cursor.com/dashboard/integrations\n",
    )
    process.exit(2)
  }

  const diff = await getDiff(args)

  if (!diff.trim()) {
    if (args.json) {
      process.stdout.write(
        JSON.stringify({ summary: "No changes to review.", comments: [] }) + "\n",
      )
    } else {
      process.stdout.write("No changes to review.\n")
    }
    return
  }

  const agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    name: "Code reviewer",
    model: { id: args.model },
    local: { cwd: args.cwd },
  })

  const session = await agent.send(reviewerPrompt(diff))

  let raw = ""
  for await (const event of session.stream()) {
    if (event.type !== "assistant") continue
    for (const block of event.message.content) {
      if (block.type === "text") raw += block.text
    }
  }
  await session.wait()

  const review = validateReview(extractJson(raw))

  if (args.json) {
    process.stdout.write(JSON.stringify(review, null, 2) + "\n")
  } else {
    printHuman(review)
  }

  process.exit(exitCodeFor(review, args.failOn))
}

try {
  await run()
} catch (err) {
  process.stderr.write(
    `code-reviewer: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  // Exit 2 = operational error. Reserve exit 1 for "review found findings >= --fail-on".
  process.exit(2)
}
