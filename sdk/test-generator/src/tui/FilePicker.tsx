import path from "node:path"
import React from "react"
import { Box, Text } from "ink"
import type { ProjectInfo } from "../detector.js"

type FilePickerProps = {
  cursorIndex: number
  files: string[]
  project: ProjectInfo
  selectedFiles: Set<string>
}

export function FilePicker({
  cursorIndex,
  files,
  project,
  selectedFiles,
}: FilePickerProps) {
  const visibleFiles = files.slice(Math.max(0, cursorIndex - 8), cursorIndex + 12)

  return (
    <Box flexDirection="column">
      <Text color="cyan">Select source files</Text>
      <Text dimColor>
        Space toggles, Enter starts, / opens commands. Framework: {project.framework}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {visibleFiles.map((file) => {
          const active = file === files[cursorIndex]
          const checked = selectedFiles.has(file)
          return (
            <Text key={file} color={active ? "green" : undefined}>
              {active ? ">" : " "} {checked ? "[x]" : "[ ]"}{" "}
              {path.relative(project.cwd, file)}
            </Text>
          )
        })}
      </Box>
    </Box>
  )
}
