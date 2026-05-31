#!/usr/bin/env bash
# Regenerate the checked-in copyable Cursor skill from the SDK example source.

set -euo pipefail

SDK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SDK_ROOT/../.." && pwd)"
DEST="$REPO_ROOT/.cursor/skills/dag-task-runner"

echo "[sync-copyable-skill] sdk:  $SDK_ROOT"
echo "[sync-copyable-skill] dest: $DEST"

rm -rf "$DEST"
mkdir -p "$DEST/examples" "$DEST/scripts"

cp "$SDK_ROOT/skill/SKILL.md" "$DEST/SKILL.md"
cp -R "$SDK_ROOT/examples/." "$DEST/examples/"
cp -R "$SDK_ROOT/src/." "$DEST/scripts/"

cat > "$DEST/scripts/package.json" <<'EOF'
{
  "name": "dag-task-runner-skill-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Runtime scripts for the copyable DAG task runner Cursor skill.",
  "packageManager": "pnpm@10.9.0",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "dev": "tsx run_dag.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/run_dag.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "init-canvas": "tsx run_dag.ts --init-only --dag ../examples/example_dag.json --canvas-path \"$PWD/.canvas/dag-example.canvas.tsx\"",
    "example": "tsx run_dag.ts --dag ../examples/example_dag.json --canvas-path \"$PWD/.canvas/dag-example.canvas.tsx\""
  },
  "dependencies": {
    "@cursor/sdk": "^1.0.9"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "tsx": "^4.21.0",
    "typescript": "^6.0.3"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild", "sqlite3"]
  }
}
EOF

cat > "$DEST/scripts/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ESNext"],
    "types": ["node"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["*.ts"],
  "exclude": ["dist", "node_modules"]
}
EOF

cat > "$DEST/scripts/.gitignore" <<'EOF'
node_modules/
dist/
.env
.env.local
.canvas/
pnpm-lock.yaml
package-lock.json
*.tsbuildinfo
.DS_Store
EOF

echo "[sync-copyable-skill] done"
