import { Agent } from "@cursor/sdk";
import * as dotenv from "dotenv";

// Load variables from .env into process.env
dotenv.config();

async function main() {
  const apiKey = process.env.CURSOR_API_KEY;

  if (!apiKey) {
    console.error("Error: CURSOR_API_KEY is not set in environment variables.");
    console.log("Please copy .env.example to .env and fill in your API key.");
    process.exit(1);
  }

  const agent = await Agent.create({
    apiKey,
    name: "SDK quickstart",
    model: { id: process.env.CURSOR_MODEL ?? "composer-2" },
    local: { cwd: process.cwd() },
  });

  const run = await agent.send("Summarize what this repository does");

  for await (const event of run.stream()) {
    console.log(event);
  }

  await run.wait();
}

main().catch((err) => {
  console.error("An error occurred:", err);
  process.exit(1);
});
