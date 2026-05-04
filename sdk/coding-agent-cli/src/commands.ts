export type SlashCommandName =
  | "/cloud"
  | "/exit"
  | "/help"
  | "/local"
  | "/model"
  | "/quit"
  | "/reset"

export type SlashCommand = {
  name: SlashCommandName
  summary: string
}

export const slashCommands: SlashCommand[] = [
  { name: "/help", summary: "Show available commands." },
  { name: "/local", summary: "Run future prompts in the local workspace." },
  { name: "/cloud", summary: "Run future prompts in Cursor cloud." },
  { name: "/model", summary: "Open a picker with available Cursor models." },
  { name: "/reset", summary: "Start a fresh agent and clear context." },
  { name: "/exit", summary: "Exit the TUI." },
  { name: "/quit", summary: "Exit the TUI." },
]

const commandNames = new Set<string>(slashCommands.map((command) => command.name))

export function getSlashCommand(input: string): SlashCommandName | undefined {
  const [command] = input.trim().split(/\s+/, 1)
  return commandNames.has(command) ? (command as SlashCommandName) : undefined
}

export function getSlashCommandItems(query: string) {
  const normalizedQuery = query.trim().toLowerCase()

  return slashCommands
    .filter((command) => command.name.startsWith(normalizedQuery || "/"))
    .map((command) => ({
      key: command.name,
      label: `${command.name}  ${command.summary}`,
      value: command.name,
    }))
}
