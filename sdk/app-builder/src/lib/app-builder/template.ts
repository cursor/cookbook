export type TemplateFile = {
  path: string
  content: string
}

export const generatedAppFiles: TemplateFile[] = [
  {
    path: "package.json",
    content: JSON.stringify(
      {
        name: "generated-app",
        private: true,
        version: "0.0.0",
        packageManager: "pnpm@10.9.0",
        scripts: {
          dev: "vite",
          build: "tsc -b && vite build",
          preview: "vite preview",
        },
        dependencies: {
          "@vitejs/plugin-react": "latest",
          vite: "latest",
          react: "latest",
          "react-dom": "latest",
        },
        devDependencies: {
          "@types/react": "latest",
          "@types/react-dom": "latest",
          typescript: "latest",
        },
      },
      null,
      2
    ),
  },
  {
    path: "pnpm-workspace.yaml",
    content: `packages:
  - "."

onlyBuiltDependencies:
  - esbuild
`,
  },
  {
    path: "index.html",
    content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Generated App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  },
  {
    path: "tsconfig.json",
    content: JSON.stringify(
      {
        compilerOptions: {
          target: "ES2020",
          useDefineForClassFields: true,
          lib: ["DOM", "DOM.Iterable", "ES2020"],
          allowJs: false,
          skipLibCheck: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          strict: true,
          forceConsistentCasingInFileNames: true,
          module: "ESNext",
          moduleResolution: "Node",
          resolveJsonModule: true,
          isolatedModules: true,
          noEmit: true,
          jsx: "react-jsx",
        },
        include: ["src"],
      },
      null,
      2
    ),
  },
  {
    path: "vite.config.ts",
    content: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`,
  },
  {
    path: "src/main.tsx",
    content: `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
  },
  {
    path: "src/App.tsx",
    content: `export default function App() {
  return (
    <main className="boilerplate">
      <p>This is your boilerplate. Start making changes by prompting the agent.</p>
    </main>
  );
}
`,
  },
  {
    path: "src/styles.css",
    content: `* {
  box-sizing: border-box;
}

:root {
  color: #171717;
  background: #ffffff;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

html,
body,
#root {
  min-height: 100%;
}

body {
  margin: 0;
  font-family:
    ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
}

.boilerplate {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 24px;
  text-align: center;
}

.boilerplate p {
  max-width: 420px;
  margin: 0;
  color: #666666;
  font-size: 16px;
  line-height: 1.6;
}
`,
  },
]
