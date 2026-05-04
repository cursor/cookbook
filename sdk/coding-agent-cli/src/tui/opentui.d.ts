import type { InputRenderable } from "@opentui/core"

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "tui-input": typeof InputRenderable
  }
}
