import { Agent } from "@cursor/sdk"

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY,
  name: "SDK quickstart",
  model: { id: process.env.CURSOR_MODEL ?? "composer-2" },
  local: { cwd: process.cwd() },
})

const prompt = "Explain this project in one paragraph."
const run = await agent.send(prompt)

for await (const event of run.stream()) {
  if (event.type !== "assistant") continue

  for (const block of event.message.content) {
    if (block.type === "text") {
      process.stdout.write(block.text)
    }
  }
}

await run.wait()
agent.close()
