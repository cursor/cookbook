import React from "react"
import { Box, Text } from "ink"

type IterationViewProps = {
  logs: string[]
}

export function IterationView({ logs }: IterationViewProps) {
  const visibleLogs = logs.slice(-24)

  return (
    <Box flexDirection="column">
      <Text color="cyan">Generating tests</Text>
      <Text dimColor>Ctrl+C cancels the active agent run.</Text>
      <Box marginTop={1} flexDirection="column">
        {visibleLogs.map((log, index) => (
          <Text key={`${index}-${log}`}>{log}</Text>
        ))}
      </Box>
    </Box>
  )
}
