import { Agent } from "@cursor/sdk"

// Wire sverklo as an MCP server for the Cursor SDK agent.
//
// Sverklo (https://github.com/sverklo/sverklo, MIT) is a local-first
// MCP code-intelligence server. It gives the agent 37 extra tools
// alongside Cursor's built-in semSearch / glob / grep:
//   sverklo_search   — hybrid (BM25 + ONNX embedding + PageRank) search
//   sverklo_impact   — recursive blast-radius (transitive callers)
//   sverklo_refs     — exact references to a symbol
//   sverklo_overview — PageRank-ranked codebase map
//   sverklo_audit    — god classes, dead code, security patterns
//   sverklo_remember / sverklo_recall — bi-temporal memory pinned to git SHAs
//   sverklo_review_diff — risk-scored diff review
//   …and 30 more.
//
// One-time setup before running this example:
//   npm install -g sverklo
// (Pulls the indexer + a small ONNX embedding model. ~30s, ~90MB.)

const projectPath = process.argv[2] ?? process.cwd()

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY,
  name: "Cursor SDK + sverklo (code intelligence over MCP)",
  model: { id: process.env.CURSOR_MODEL ?? "composer-2" },
  local: { cwd: projectPath },
  mcpServers: {
    sverklo: {
      type: "stdio",
      command: "npx",
      args: ["-y", "sverklo", projectPath],
      cwd: projectPath,
    },
  },
})

const prompt =
  process.argv[3] ??
  "Use sverklo_overview to give me a 5-minute mental model of this codebase " +
    "(PageRank-ranked, not file-size-ranked). Then run sverklo_audit and " +
    "highlight any high-risk findings I should look at first. Be concrete — " +
    "name files and symbols, not generalities."

const run = await agent.send(prompt)

for await (const event of run.stream()) {
  if (event.type === "tool_call") {
    // The SDK's tool_call event names the tool in `event.name` and only
    // emits the call-start once (status: "running"). Log on running so we
    // don't double-print when "completed" arrives later in the stream.
    if (event.status === "running") {
      process.stdout.write(`\n[tool] ${event.name}\n`)
    }
    continue
  }
  if (event.type !== "assistant") continue

  for (const block of event.message.content) {
    if (block.type === "text") {
      process.stdout.write(block.text)
    }
  }
}

await run.wait()
process.stdout.write("\n")
