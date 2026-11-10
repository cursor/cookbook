"use client"

import dynamic from "next/dynamic"

// The builder seeds its state from localStorage and mints conversation ids at
// render time, so a server render can never match the client's first paint.
// Rendering it client-only removes the hydration mismatch at the source; this
// is a local development tool, so there is nothing to gain from SSR here.
export const AppBuilderClient = dynamic(
  () => import("@/components/app-builder").then((mod) => mod.AppBuilder),
  { ssr: false }
)
