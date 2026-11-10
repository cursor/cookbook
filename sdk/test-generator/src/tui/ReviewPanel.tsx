import path from "node:path"
import React from "react"
import { Box, Text } from "ink"
import type { ProjectInfo } from "../detector.js"
import type { GenerateFileResult } from "../workflow.js"

type ReviewPanelProps = {
  currentIndex: number
  project: ProjectInfo
  result: GenerateFileResult
  total: number
}

export function ReviewPanel({
  currentIndex,
  project,
  result,
  total,
}: ReviewPanelProps) {
  return (
    <Box flexDirection="column">
      <Text color={result.ok ? "green" : "yellow"}>
        Review {currentIndex + 1}/{total}: {path.relative(project.cwd, result.testPath)}
      </Text>
      <Text dimColor>
        a accepts, r rejects, s skips. Last test run: {result.ok ? "passed" : "failed"}.
      </Text>
      <Box marginTop={1} flexDirection="column">
        {result.diff.split("\n").slice(0, 30).map((line, index) => (
          <Text key={`${index}-${line}`} color={colorForDiffLine(line)}>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

function colorForDiffLine(line: string) {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "green"
  }

  if (line.startsWith("-") && !line.startsWith("---")) {
    return "red"
  }

  return undefined
}
