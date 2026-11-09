// What the audit supports, one entry per stack the scan can recognise. references/supported.md
// lists the same entries in the same tiers; tests/supported.test.ts fails when the two drift.
// supported: the audit assesses it and gives a level. not_yet: the scan recognises it and gives no
// level, for a known reason. not_assessed: the scan lists it by name and share and has no support
// for it, so it gives no level.
export type SupportTier = "supported" | "not_yet" | "not_assessed";

export interface Stack {
  id: string;
  label: string;
  kind: "stack" | "machine";
  tier: SupportTier;
  // Why it isn't supported, said after "<label> isn't supported yet: ".
  reason?: string;
  // The files of a component in this stack, for a root app that shares "." with a root package.json.
  files?: RegExp;
  // Fixtures (fixtures/<name>) or pinned real repos (owner/repo@sha) that show the audit's behaviour.
  proof: string[];
}

export const SUPPORTED_DOC = "references/supported.md";

export const STACKS: Stack[] = [
  { id: "npm", label: "Node with npm", kind: "stack", tier: "supported", proof: ["fixtures/healthy-node", "sindresorhus/slugify@3b17b2e"] },
  { id: "npm-workspaces", label: "npm workspaces", kind: "stack", tier: "supported", proof: ["fixtures/monorepo-mixed", "fixtures/sampled-scope"] },
  { id: "pnpm", label: "Node with pnpm", kind: "stack", tier: "supported", proof: ["fixtures/standalone-nested-mixed", "t3-oss/create-t3-turbo@8f945b7"] },
  { id: "yarn", label: "Node with Yarn 1", kind: "stack", tier: "supported", proof: ["fixtures/yarn-classic"] },
  { id: "pip", label: "Python with pip", kind: "stack", tier: "supported", proof: ["fixtures/python-unpinned"] },
  { id: "uv", label: "Python with uv", kind: "stack", tier: "supported", proof: ["encode/starlette@2745bbc"] },
  { id: "poetry", label: "Poetry", kind: "stack", tier: "supported", reason: "the audit adds the Poetry that wrote poetry.lock to its Python image, from PyPI, and installs into .venv", proof: ["fixtures/poetry-only", "python-poetry/cleo@fd264ef"] },
  { id: "bun", label: "Bun", kind: "stack", tier: "supported", reason: "the audit adds the pinned Bun to its Node image, from the npm registry", proof: ["fixtures/bun-lock", "elysiajs/elysia@e037eca"] },
  { id: "yarn-berry", label: "Yarn 2 or later", kind: "stack", tier: "supported", reason: "Corepack runs the pinned Yarn, or Yarn hands over to the yarnPath release; the install is immutable", proof: ["fixtures/yarn-berry"] },
  { id: "yarn-berry-unpinned", label: "Yarn 2 or later with no version pin", kind: "stack", tier: "not_yet", reason: "nothing says which Yarn to run: add packageManager to package.json or yarnPath to .yarnrc.yml", proof: ["tests/toolchains.test.ts"] },
  { id: "uv-workspace", label: "A uv workspace", kind: "stack", tier: "supported", reason: "each member is a component; one frozen install syncs every member from the root uv.lock, with the dev group and any test group", proof: ["fixtures/uv-workspace"] },
  { id: "python-behind-root-package", label: "A Python app next to a root package.json", kind: "stack", tier: "not_yet", reason: "the audit runs one image per repo, and it picks Node's", files: /\.(py|pyi)$/, proof: ["fixtures/python-behind-root-package", "saleor/saleor@dfbf139"] },
  { id: "task-graph", label: "A package that needs a sibling package built first", kind: "stack", tier: "not_yet", reason: "the audit builds packages one by one, not in Turbo's or Nx's order", proof: ["fixtures/turbo-depends-on-build", "spree/spree@cdd9a02"] },
  { id: "go", label: "Go", kind: "stack", tier: "not_assessed", files: /\.go$|(^|\/)go\.(mod|sum)$/, proof: ["fixtures/unsupported-go-service", "google/uuid@2d3c2a9"] },
  { id: "rust", label: "Rust", kind: "stack", tier: "not_assessed", files: /\.rs$|(^|\/)Cargo\.(toml|lock)$/, proof: ["BurntSushi/ripgrep@91f5d22"] },
  { id: "jvm", label: "JVM", kind: "stack", tier: "not_assessed", files: /\.(java|kt|kts|scala|gradle)$|(^|\/)pom\.xml$/, proof: ["spring-projects/spring-petclinic@500158f"] },
  { id: "dotnet", label: ".NET", kind: "stack", tier: "not_assessed", files: /\.(cs|fs|vb|csproj|fsproj|vbproj|sln|razor)$/, proof: ["fixtures/nested-apps-dotnet", "fixtures/standalone-nested-mixed", "ShareX/ShareX@12d6342"] },
  { id: "ruby", label: "Ruby", kind: "stack", tier: "not_assessed", files: /\.(rb|rake|erb|gemspec)$|(^|\/)(Gemfile|Rakefile)(\.lock)?$/, proof: ["spree/spree@cdd9a02"] },
  { id: "php", label: "PHP", kind: "stack", tier: "not_assessed", files: /\.php$|(^|\/)composer\.(json|lock)$/, proof: ["laravel/laravel@def7ce1"] },
  { id: "swift", label: "Swift", kind: "stack", tier: "not_assessed", files: /\.swift$/, proof: ["fixtures/swift-package", "apple/swift-argument-parser@38ca4ec"] },
  { id: "dart", label: "Dart", kind: "stack", tier: "not_assessed", files: /\.dart$|(^|\/)pubspec\.(yaml|lock)$/, proof: ["fixtures/dart-packages", "dart-lang/http@8c0d66a"] },
  { id: "terraform", label: "Terraform", kind: "stack", tier: "not_assessed", files: /\.(tf|tfvars)$/, proof: ["fixtures/terraform-modules", "fixtures/monorepo-mixed", "terraform-aws-modules/terraform-aws-vpc@b3abd6d"] },
  { id: "docker", label: "Docker", kind: "machine", tier: "supported", proof: ["tests/fixtures.test.ts"] },
  { id: "host-fallback", label: "No container runtime on Linux or macOS", kind: "machine", tier: "supported", reason: "setup runs in a scrubbed copy on the host, so Level 1 can't be proved there", proof: ["fixtures/declared-image-missing-toolchain", "fixtures/sudo-start"] },
  { id: "windows", label: "Windows without Docker or Podman", kind: "machine", tier: "not_yet", reason: "the host fallback runs bash; run the audit in WSL 2 or with Docker Desktop", proof: ["tests/supported.test.ts"] },
  { id: "podman", label: "Podman", kind: "machine", tier: "not_assessed", reason: "the audit drives it like Docker, but no fixture run has used it", proof: [] },
];

export function stack(id: string): Stack {
  const s = STACKS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown stack ${id}`);
  return s;
}

export function supported(id: string): boolean {
  return stack(id).tier === "supported";
}

// The reason a component in this stack gets no level, for the report, where it follows "because"
// or a component's name.
export function notSupportedReason(id: string): string {
  const s = stack(id);
  return `${s.label.replace(/^A /, "a ")} isn't supported yet${s.reason ? `: ${s.reason}` : ""}`;
}

export const NOT_SUPPORTED = / isn't supported yet\b/;
