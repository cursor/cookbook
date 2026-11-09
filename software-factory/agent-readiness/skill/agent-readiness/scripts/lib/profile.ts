import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Rubric } from "./rubric.ts";
import { STACKS, notSupportedReason, stack, supported } from "./support.ts";
import type { Component, Language, PackageManager, Profile } from "./types.ts";
import { addDays, containedPath, exists, git, listFiles, readJson, readText, today } from "./util.ts";

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  engines?: Record<string, string>;
  packageManager?: string;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  volta?: Record<string, string>;
}

export function readPackageJson(dir: string): PackageJson | null {
  const p = join(dir, "package.json");
  if (!exists(p)) return null;
  try {
    return readJson<PackageJson>(p);
  } catch {
    return null;
  }
}

export function detectPackageManager(tree: string): PackageManager | null {
  if (exists(join(tree, "bun.lock")) || exists(join(tree, "bun.lockb"))) return "bun";
  if (exists(join(tree, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(join(tree, "yarn.lock"))) return "yarn";
  if (exists(join(tree, "package-lock.json"))) return "npm";
  if (exists(join(tree, "package.json"))) {
    const pm = readPackageJson(tree)?.packageManager ?? "";
    if (pm.startsWith("bun")) return "bun";
    if (pm.startsWith("pnpm")) return "pnpm";
    if (pm.startsWith("yarn")) return "yarn";
    return "npm";
  }
  if (exists(join(tree, "uv.lock")) || UV_WORKSPACE.test(pyproject(tree))) return "uv";
  if (exists(join(tree, "poetry.lock")) || /^\[tool\.poetry\]/m.test(pyproject(tree))) return "poetry";
  if (exists(join(tree, "pyproject.toml")) || exists(join(tree, "requirements.txt")) || exists(join(tree, "setup.py"))) return "pip";
  return null;
}

export function pyproject(dir: string): string {
  return exists(join(dir, "pyproject.toml")) ? readText(join(dir, "pyproject.toml")) : "";
}

const UV_WORKSPACE = /^\[tool\.uv\.workspace\]/m;

// The folders a root pyproject.toml's [tool.uv.workspace] lists, less its excludes, each with its
// own pyproject.toml. They share the root's uv.lock and .venv.
export function uvWorkspaceMembers(tree: string): string[] {
  const section = pyproject(tree).match(/^\[tool\.uv\.workspace\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1];
  if (section === undefined) return [];
  const list = (key: string) => [...(section.match(new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m"))?.[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  const excluded = new Set(list("exclude").flatMap((p) => expandPattern(tree, p)));
  return [...new Set(list("members").flatMap((p) => expandPattern(tree, p)))].filter((d) => d !== "." && !excluded.has(d) && exists(join(tree, d, "pyproject.toml"))).sort();
}

// The folders whose package.json or .yarnrc.yml decide a component's Yarn: its own, then the root's.
function yarnDirs(dir: string): string[] {
  return dir === "." ? ["."] : [dir, "."];
}

function yarnPath(tree: string, dir: string): string | null {
  for (const d of yarnDirs(dir)) {
    const f = join(tree, d, ".yarnrc.yml");
    const path = exists(f) ? readText(f).match(/^yarnPath:\s*["']?([^"'\s#]+)/m)?.[1] : undefined;
    if (path) return d === "." ? ".yarnrc.yml" : `${d}/.yarnrc.yml`;
  }
  return null;
}

// Yarn 2 and later: a packageManager pin of yarn@2 or above, a .yarnrc.yml, or a Berry lockfile.
export function yarnBerry(tree: string, dir: string): boolean {
  for (const d of yarnDirs(dir)) {
    const major = Number(readPackageJson(join(tree, d))?.packageManager?.match(/^yarn@(\d+)/)?.[1] ?? 0);
    if (major >= 2 || exists(join(tree, d, ".yarnrc.yml"))) return true;
    if (exists(join(tree, d, "yarn.lock")) && /^__metadata:/m.test(readText(join(tree, d, "yarn.lock")))) return true;
  }
  return false;
}

// Corepack runs the Yarn a packageManager pin names, and Yarn 1 hands over to a yarnPath release.
// With neither, Corepack would run Yarn 1 against a Berry project.
function yarnPinned(tree: string, dir: string): boolean {
  return yarnDirs(dir).some((d) => /^yarn@/.test(readPackageJson(join(tree, d))?.packageManager ?? "")) || yarnPath(tree, dir) !== null;
}

const PACKAGE_STACKS = ["npm", "npm-workspaces", "pnpm", "yarn", "yarn-berry", "yarn-berry-unpinned", "bun", "pip", "uv", "uv-workspace", "poetry"] as const;

// The support entry a Node or Python component falls under, from its own package manager or the root's.
function stackOf(tree: string, c: Component, rootPm: PackageManager | null, workspaceMember: boolean): (typeof PACKAGE_STACKS)[number] {
  const pm = c.packageManager ?? rootPm;
  if (c.language === "py") {
    if (pm === "poetry") return "poetry";
    if ((UV_WORKSPACE.test(pyproject(tree)) && (c.path === "." || workspaceMember)) || UV_WORKSPACE.test(pyproject(join(tree, c.path)))) return "uv-workspace";
    return pm === "uv" ? "uv" : "pip";
  }
  if (pm === "bun") return "bun";
  if (pm === "yarn") return !yarnBerry(tree, c.path) ? "yarn" : yarnPinned(tree, c.path) ? "yarn-berry" : "yarn-berry-unpinned";
  if (pm === "pnpm") return "pnpm";
  return workspaceMember ? "npm-workspaces" : "npm";
}

function workspacePatterns(tree: string): string[] {
  const pkg = readPackageJson(tree);
  const ws = pkg?.workspaces;
  const fromPkg = Array.isArray(ws) ? ws : ws?.packages ?? [];
  const pnpmFile = join(tree, "pnpm-workspace.yaml");
  const fromPnpm: string[] = [];
  if (exists(pnpmFile)) {
    let inPackages = false;
    for (const line of readText(pnpmFile).split("\n")) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/);
        if (m) fromPnpm.push(m[1]);
        else if (/^\S/.test(line)) inPackages = false;
      }
    }
  }
  return [...fromPkg, ...fromPnpm].filter((p) => !p.startsWith("!"));
}

function expandPattern(tree: string, pattern: string): string[] {
  const clean = pattern.replace(/\/+$/, "");
  if (clean.endsWith("/*") || clean.endsWith("/**")) {
    const base = clean.replace(/\/\*\*?$/, "");
    const dir = join(tree, base);
    if (!exists(dir)) return [];
    return readdirSync(dir)
      .filter((n) => statSync(join(dir, n)).isDirectory())
      .map((n) => `${base}/${n}`);
  }
  return exists(join(tree, clean)) ? [clean] : [];
}

function languageOf(tree: string, path: string, files: string[]): Language {
  const inside = files.filter((f) => path === "." || f.startsWith(path + "/"));
  if (inside.some((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith(".d.ts"))) return "ts";
  if (exists(join(tree, path, "package.json"))) return "js";
  if (inside.some((f) => f.endsWith(".py"))) return "py";
  return "other";
}

// Source with no manifest, listed by the top-level folder that holds it.
const UNSUPPORTED: { ext: RegExp; stack: string }[] = [
  { ext: /\.tf$/, stack: "terraform" },
  { ext: /\.go$/, stack: "go" },
  { ext: /\.rs$/, stack: "rust" },
  { ext: /\.(java|kt|scala)$/, stack: "jvm" },
  { ext: /\.(cs|fs)$/, stack: "dotnet" },
  { ext: /\.rb$/, stack: "ruby" },
  { ext: /\.php$/, stack: "php" },
  { ext: /\.swift$/, stack: "swift" },
  { ext: /\.dart$/, stack: "dart" },
];

function sanitizeId(name: string): string {
  return name.replace(/^@[^/]+\//, "").replace(/[^A-Za-z0-9._-]/g, "-") || "root";
}

const NODE_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const PY_LOCKFILES = ["uv.lock", "poetry.lock", "Pipfile.lock", "pdm.lock"];
const LOCKFILES = [...NODE_LOCKFILES, ...PY_LOCKFILES, "packages.lock.json", "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock", "gradle.lockfile", "mix.lock", "pubspec.lock", "Podfile.lock", ".terraform.lock.hcl", "Package.resolved"];
const SKIP_SEGMENT = /^(\..+|node_modules|fixtures?|__fixtures__|testdata|vendor|dist|build|bin|obj|target)$/;

// A solution file comes first so it groups the projects under it into one component. A folder of
// .tf files is a Terraform module, so a root module and nested root modules are found at any depth.
const UNSUPPORTED_MANIFESTS: { match: RegExp; stack: string }[] = [
  { match: /\.sln$/, stack: "dotnet" },
  { match: /\.(csproj|fsproj|vbproj)$/, stack: "dotnet" },
  { match: /^go\.mod$/, stack: "go" },
  { match: /^Cargo\.toml$/, stack: "rust" },
  { match: /^(pom\.xml|build\.gradle(\.kts)?)$/, stack: "jvm" },
  { match: /^Gemfile$/, stack: "ruby" },
  { match: /^composer\.json$/, stack: "php" },
  { match: /^Package\.swift$/, stack: "swift" },
  { match: /^pubspec\.yaml$/, stack: "dart" },
  { match: /\.tf$/, stack: "terraform" },
];

interface FoundManifest {
  dir: string;
  kind: "js" | "py" | "other";
  manifest: string;
  stack?: string;
}

const within = (dir: string, parent: string) => parent === "." || dir === parent || dir.startsWith(parent + "/");

// Folders that usually hold tests, samples or tooling next to the product. A manifest there is a
// satellite: it becomes a component only when the repo has nothing else to assess.
const SATELLITE_SEGMENT = /^(tests?|__tests__|specs?|e2e|samples?|examples?|demos?|bench|benchmarks?|plugins?|utils?|configs?|tooling)$/;
const EXAMPLE_SEGMENT = /^(samples?|examples?|demos?|bench|benchmarks?)$/;
// Packaging and mobile platform folders, such as a Homebrew formula next to a Rust CLI or the
// android/ shell of a Flutter app, hold another toolchain's files without being another product.
const PACKAGING_SEGMENT = /^(HomebrewFormula|Formula|pkg|packaging|android|ios|debian|rpm|snap)$/;
const CONFIG_PACKAGE = /^(@[^/]+\/)?((eslint|prettier|stylelint|babel|jest|vitest|tsconfig|typescript)-config(-[\w.-]+)?|eslint-config|tsconfig|config)$/;

const SATELLITE_HOLDS = "tests, samples or tooling";
const PACKAGING_HOLDS = "packaging or a mobile platform shell";

function satelliteReason(tree: string, m: FoundManifest): string | null {
  const segment = m.dir.split("/").find((s) => SATELLITE_SEGMENT.test(s));
  if (segment) return `it sits under ${segment}/, which usually holds ${SATELLITE_HOLDS} rather than the product`;
  const packaging = m.kind === "other" ? m.dir.split("/").find((s) => PACKAGING_SEGMENT.test(s)) : undefined;
  if (packaging) return `it sits under ${packaging}/, which usually holds ${PACKAGING_HOLDS} rather than the product`;
  const name = m.kind === "js" ? readPackageJson(join(tree, m.dir))?.name : undefined;
  if (name && CONFIG_PACKAGE.test(name)) return `${name} is a shared config package, not a product`;
  return null;
}

// A Dart workspace's root pubspec only lists its packages; each package is the project.
function workspaceOnly(tree: string, dir: string, stackId: string): boolean {
  return stackId === "dart" && /^workspace:/m.test(readText(join(tree, dir, "pubspec.yaml")));
}

// Several solution or project files in one folder: the one named after the folder or repo, else the
// shortest name, so ShareX isn't named after ShareX.ImageEditor.sln.
function pickManifest(names: string[], preferred: string): string {
  const stem = (n: string) => n.replace(/\.\w+$/, "").toLowerCase();
  const sorted = [...names].sort((a, b) => (a === "main.tf" ? -1 : b === "main.tf" ? 1 : a.length - b.length || a.localeCompare(b)));
  return sorted.find((n) => stem(n) === preferred.toLowerCase()) ?? sorted[0];
}

// Every manifest in the tree, at any depth, outside workspace members. A supported package owns
// the folders under it; one nested in an unsupported project (a web client inside a .NET project)
// is still its own component. Next to a root package, only nested packages with their own lockfile count.
function discoverManifests(tree: string, files: string[], claimed: string[], hasRoot: boolean, repoName: string): { found: FoundManifest[]; satellites: (FoundManifest & { reason: string })[] } {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const dir = dirname(f);
    if (dir !== "." && dir.split("/").some((s) => SKIP_SEGMENT.test(s))) continue;
    byDir.set(dir, [...(byDir.get(dir) ?? []), basename(f)]);
  }
  const found: FoundManifest[] = [];
  const satellites: (FoundManifest & { reason: string })[] = [];
  const add = (m: FoundManifest) => {
    const reason = m.dir === "." ? null : satelliteReason(tree, m);
    if (reason) satellites.push({ ...m, reason });
    else found.push(m);
  };
  for (const dir of [...byDir.keys()].sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a.split("/").length - b.split("/").length || a.localeCompare(b)))) {
    if (claimed.some((c) => within(dir, c))) continue;
    const names = byDir.get(dir)!;
    const has = (n: string) => names.includes(n);
    const insideSupported = [...found, ...satellites].some((f) => f.kind !== "other" && within(dir, f.dir));
    if (dir !== "." && !insideSupported && has("package.json") && (!hasRoot || NODE_LOCKFILES.some(has))) {
      add({ dir, kind: "js", manifest: `${dir}/package.json` });
      continue;
    }
    const py = has("pyproject.toml") ? "pyproject.toml" : has("setup.py") ? "setup.py" : has("requirements.txt") && names.some((n) => n.endsWith(".py")) ? "requirements.txt" : null;
    if (dir !== "." && !insideSupported && py && (!hasRoot || PY_LOCKFILES.some(has))) {
      add({ dir, kind: "py", manifest: `${dir}/${py}` });
      continue;
    }
    const rule = UNSUPPORTED_MANIFESTS.find((u) => names.some((n) => u.match.test(n)));
    if (rule && !(dir === "." && hasRoot) && !workspaceOnly(tree, dir, rule.stack) && ![...found, ...satellites].some((f) => within(dir, f.dir))) {
      const project = pickManifest(names.filter((n) => rule.match.test(n)), dir === "." ? repoName : basename(dir));
      add({ dir, kind: "other", manifest: dir === "." ? project : `${dir}/${project}`, stack: rule.stack });
    }
  }
  return { found, satellites };
}

// The name a root-level project gives itself, so a Go module isn't called "go". A root with no
// name of its own, such as a Terraform module, takes the repo's.
function projectName(tree: string, manifest: string, repoName: string): string {
  const text = exists(join(tree, manifest)) ? readText(join(tree, manifest)) : "";
  const stem = basename(manifest).replace(/\.\w+$/, "");
  const named =
    manifest === "go.mod" ? text.match(/^module\s+(\S+)/m)?.[1]?.split("/").pop()
    : manifest === "Cargo.toml" || manifest === "pyproject.toml" ? text.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1]
    : manifest === "pom.xml" ? text.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]
    : manifest === "composer.json" ? text.match(/"name"\s*:\s*"(?:[^"/]+\/)?([^"]+)"/)?.[1]
    : manifest === "Package.swift" ? text.match(/\bname:\s*"([^"]+)"/)?.[1]
    : manifest === "pubspec.yaml" ? text.match(/^name:\s*['"]?([\w-]+)/m)?.[1]
    : /\.(sln|csproj|fsproj|vbproj)$/.test(manifest) ? (soleProject(tree, manifest) || stem.toLowerCase() === repoName.toLowerCase() ? stem : undefined)
    : undefined;
  return named ?? repoName;
}

function soleProject(tree: string, manifest: string): boolean {
  const ext = manifest.match(/\.\w+$/)![0];
  return readdirSync(join(tree, dirname(manifest))).filter((n) => n.endsWith(ext)).length === 1;
}

function lockfileIn(tree: string, dir: string): string | null {
  const name = LOCKFILES.find((l) => exists(join(tree, dir, l)));
  return name ? (dir === "." ? name : `${dir}/${name}`) : null;
}

export function discoverComponents(tree: string, files: string[], repoName?: string): Component[] {
  return discoverLayout(tree, files, repoName).components;
}

const ROOT_APP_MANIFESTS: { names: string[]; stack: string; toolchain: string; suffix: string }[] = [
  { names: ["pyproject.toml", "setup.py", "requirements.txt"], stack: "python-behind-root-package", toolchain: "Python", suffix: "python" },
  { names: ["composer.json"], stack: "php", toolchain: "PHP", suffix: "php" },
  { names: ["Gemfile"], stack: "ruby", toolchain: "Ruby", suffix: "ruby" },
  { names: ["go.mod"], stack: "go", toolchain: "Go", suffix: "go" },
  { names: ["Cargo.toml"], stack: "rust", toolchain: "Rust", suffix: "rust" },
  { names: ["pom.xml", "build.gradle", "build.gradle.kts"], stack: "jvm", toolchain: "JVM", suffix: "jvm" },
];

// A root package.json often holds only release tooling or a frontend bundle for the real app at the
// root, such as Django, Laravel or Rails. That app is listed with its own share of changes.
function rootApps(tree: string, files: string[], repoName: string): Component[] {
  const out: Component[] = [];
  const hasPy = files.some((f) => f.endsWith(".py") && !f.split("/").some((s) => SKIP_SEGMENT.test(s)));
  for (const r of ROOT_APP_MANIFESTS) {
    const manifest = r.names.find((n) => exists(join(tree, n)));
    if (!manifest || (r.suffix === "python" && !hasPy)) continue;
    const s = stack(r.stack);
    out.push({ id: sanitizeId(projectName(tree, manifest, repoName)), path: ".", language: r.suffix === "python" ? "py" : "other", manifest, scripts: {}, changes: 0, changeShare: 0, assessed: false, toolchain: r.toolchain, stack: s.id, notAssessedReason: notSupportedReason(s.id) });
  }
  return out;
}

export function discoverLayout(tree: string, files: string[], repoName = basename(tree)): { components: Component[]; satellites: Profile["satellites"] } {
  const comps: Component[] = [];
  const memberSatellites: Profile["satellites"] = [];
  const members = new Set<string>();
  const patterns = workspacePatterns(tree);
  if (patterns.length > 0) {
    const all = [...new Set(patterns.flatMap((p) => expandPattern(tree, p)))].filter((d) => exists(join(tree, d, "package.json"))).sort();
    // Workspace members under tooling/ or examples/ are satellites too, unless nothing else exists.
    const reasons = new Map(all.map((d) => [d, d === "." ? null : satelliteReason(tree, { dir: d, kind: "js", manifest: `${d}/package.json` })]));
    const product = all.filter((d) => !reasons.get(d));
    const dirs = product.length ? product : all;
    if (product.length) for (const d of all.filter((x) => reasons.get(x))) memberSatellites.push({ path: d, manifest: `${d}/package.json`, toolchain: "Node", reason: reasons.get(d)! });
    for (const dir of dirs) {
      const pkg = readPackageJson(join(tree, dir));
      members.add(dir);
      comps.push({
        id: dir === "." ? sanitizeId(pkg?.name ?? "root") : sanitizeId(basename(dir)),
        path: dir,
        language: languageOf(tree, dir, files),
        manifest: dir === "." ? "package.json" : `${dir}/package.json`,
        scripts: pkg?.scripts ?? {},
        changes: 0,
        changeShare: 0,
        assessed: false,
      });
    }
  } else if (exists(join(tree, "package.json"))) {
    const pkg = readPackageJson(tree);
    comps.push({ id: sanitizeId(pkg?.name ?? "root"), path: ".", language: languageOf(tree, ".", files), manifest: "package.json", scripts: pkg?.scripts ?? {}, changes: 0, changeShare: 0, assessed: false });
  } else if (exists(join(tree, "pyproject.toml")) || exists(join(tree, "setup.py")) || exists(join(tree, "requirements.txt"))) {
    const manifest = exists(join(tree, "pyproject.toml")) ? "pyproject.toml" : exists(join(tree, "setup.py")) ? "setup.py" : "requirements.txt";
    const pyName = exists(join(tree, "pyproject.toml")) ? readText(join(tree, "pyproject.toml")).match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] : undefined;
    comps.push({ id: sanitizeId(pyName ?? "app"), path: ".", language: "py", manifest, scripts: {}, changes: 0, changeShare: 0, assessed: false });
    const uvMembers = uvWorkspaceMembers(tree);
    // A workspace root with no [project] of its own is virtual: only its members are projects.
    if (uvMembers.length && !/^\[project\]/m.test(pyproject(tree))) comps.pop();
    for (const dir of uvMembers) {
      members.add(dir);
      const name = pyproject(join(tree, dir)).match(/^name\s*=\s*["']([^"']+)["']/m)?.[1];
      comps.push({ id: sanitizeId(name ?? basename(dir)), path: dir, language: "py", manifest: `${dir}/pyproject.toml`, scripts: {}, changes: 0, changeShare: 0, assessed: false });
    }
  }
  const hasRoot = comps.some((c) => c.path === ".");
  if (exists(join(tree, "package.json"))) {
    const apps = rootApps(tree, files, repoName);
    const jsRoot = comps.find((c) => c.path === "." && c.manifest === "package.json");
    // A root package without a test script of its own goes with the app at the root, such as Django or
    // Laravel: it isn't assessed apart from that app, so its missing tests never read as the repo's.
    if (jsRoot && apps.length && !(jsRoot.scripts.test && !/no test specified/.test(jsRoot.scripts.test))) {
      jsRoot.notAssessedReason = `it goes with the ${apps[0].toolchain} app at the root, which isn't supported yet, so it isn't assessed on its own`;
    }
    for (const app of apps) {
      if (comps.some((c) => c.id === app.id)) app.id = sanitizeId(`${app.id}-${ROOT_APP_MANIFESTS.find((r) => r.stack === app.stack)!.suffix}`);
      comps.push(app);
    }
  }
  const { found, satellites } = discoverManifests(tree, files, [...comps.filter((c) => c.path !== ".").map((c) => c.path), ...memberSatellites.map((s) => s.path)], hasRoot, repoName);
  const deferred = comps.length === 0 && found.length === 0;
  for (const m of deferred ? satellites : found) {
    const pkg = m.kind === "js" ? readPackageJson(join(tree, m.dir)) : null;
    let id = sanitizeId(m.dir === "." ? projectName(tree, m.manifest, repoName) : basename(m.dir));
    if (comps.some((c) => c.id === id)) id = sanitizeId(m.dir.replace(/\//g, "-"));
    if (m.kind === "other") {
      comps.push({ id, path: m.dir, language: "other", manifest: m.manifest, scripts: {}, changes: 0, changeShare: 0, assessed: false, toolchain: stack(m.stack!).label, stack: m.stack, notAssessedReason: notSupportedReason(m.stack!) });
    } else {
      comps.push({ id, path: m.dir, language: m.kind === "js" ? languageOf(tree, m.dir, files) : "py", manifest: m.manifest, scripts: pkg?.scripts ?? {}, changes: 0, changeShare: 0, assessed: false, packageManager: detectPackageManager(join(tree, m.dir)) });
    }
  }
  const rootPm = detectPackageManager(tree);
  for (const c of comps) {
    c.lockfile = lockfileIn(tree, c.path);
    if (c.stack || c.language === "other") continue;
    c.stack = stackOf(tree, c, rootPm, members.has(c.path) && c.path !== ".");
    if (!supported(c.stack) && !c.notAssessedReason) c.notAssessedReason = notSupportedReason(c.stack);
  }
  const satelliteList = [...memberSatellites, ...(deferred ? [] : satellites.map((s) => ({ path: s.dir, manifest: s.manifest, toolchain: s.kind === "js" ? "Node" : s.kind === "py" ? "Python" : stack(s.stack!).label, reason: s.reason })))];
  // Unsupported source with no manifest, such as infra/*.tf, is listed by its top-level folder,
  // next to a root package too, so the root doesn't take its share of changes.
  const rootOnly = comps.length > 0 && comps.every((c) => c.path === ".");
  const rootStacks = new Set(comps.filter((c) => c.path === ".").map((c) => c.stack));
  const claimed = new Set([...comps.map((c) => c.path), ...satelliteList.map((s) => s.path)].map((p) => p.split("/")[0]));
  const topDirs = [...new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]))].filter((d) => !d.startsWith(".") && !claimed.has(d));
  for (const dir of topDirs.sort()) {
    const inside = files.filter((f) => f.startsWith(dir + "/"));
    const hit = UNSUPPORTED.find((u) => inside.some((f) => u.ext.test(f)));
    if (!hit) continue;
    // A root project's own folders, such as a Go root's packages or a PHP app's tests/, are part of
    // it; only its examples are listed apart.
    if (rootStacks.has(hit.stack) && !EXAMPLE_SEGMENT.test(dir)) continue;
    const holds = SATELLITE_SEGMENT.test(dir) ? SATELLITE_HOLDS : PACKAGING_SEGMENT.test(dir) ? PACKAGING_HOLDS : null;
    if (holds && comps.length > 0) {
      satelliteList.push({ path: dir, manifest: inside.find((f) => hit.ext.test(f))!, toolchain: stack(hit.stack).label, reason: `it sits under ${dir}/, which usually holds ${holds} rather than the product` });
      continue;
    }
    if (rootOnly && NOT_A_PROJECT.test(dir)) continue;
    comps.push({ id: sanitizeId(dir), path: dir, language: "other", manifest: null, scripts: {}, changes: 0, changeShare: 0, assessed: false, toolchain: stack(hit.stack).label, stack: hit.stack, lockfile: null, notAssessedReason: notSupportedReason(hit.stack) });
  }
  return { components: uniqueIds(comps), satellites: satelliteList };
}

// Every support entry the scan can put a component in; tests/supported.test.ts checks each is listed.
export const DETECTED_STACKS: string[] = [...new Set([...PACKAGE_STACKS, ...UNSUPPORTED.map((u) => u.stack), ...UNSUPPORTED_MANIFESTS.map((u) => u.stack), ...ROOT_APP_MANIFESTS.map((r) => r.stack)])];

// Folders that hold a root package's own tests, docs and samples rather than another project.
const NOT_A_PROJECT = /^(tests?|spec|__tests__|examples?|samples?|docs?|fixtures?|vendor|third_party|node_modules|scripts|tools|tooling|bin)$/;

// Two folders with one name, such as apps/api and services/api, would merge into one component.
function uniqueIds(comps: Component[]): Component[] {
  const count = new Map<string, number>();
  for (const c of comps) count.set(c.id, (count.get(c.id) ?? 0) + 1);
  const taken = new Set<string>();
  for (const c of comps) {
    if ((count.get(c.id) ?? 0) > 1 && c.path !== ".") c.id = sanitizeId(c.path.replace(/\//g, "-"));
    let id = c.id;
    for (let i = 2; taken.has(id); i++) id = `${c.id}-${i}`;
    c.id = id;
    taken.add(id);
  }
  return comps;
}

// Two components at the root split its files: the root package keeps the Node files, and the app
// next to it, such as Django or Laravel, takes its own files and the rest of the root.
function ownsByType(c: Component, file: string): boolean {
  return Boolean(c.stack && STACKS.find((s) => s.id === c.stack)?.files?.test(file));
}

const NODE_FILE = /\.(c|m)?[jt]sx?$|\.(vue|svelte|astro|css|scss|sass|less|html?)$|(^|\/)(package(-lock)?\.json|pnpm-(lock|workspace)\.yaml|yarn\.lock|bun\.lockb?|\.nvmrc|\.npmrc|tsconfig[^/]*\.json)$/;

function owningComponent(file: string, comps: Component[]): Component | null {
  let best: Component | null = null;
  let bestLen = -1;
  for (const c of comps) {
    const matches = c.path === "." || file === c.path || file.startsWith(c.path + "/");
    const len = c.path === "." ? 0 : c.path.length;
    if (matches && len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  const roots = comps.filter((c) => c.path === ".");
  if (best?.path !== "." || roots.length < 2) return best;
  const app = roots.find((c) => c !== best && STACKS.find((s) => s.id === c.stack)?.files);
  return roots.find((c) => ownsByType(c, file)) ?? (NODE_FILE.test(file) || !app ? best : app);
}

// Counted up to the audited commit, so a commit made after `init` can't move the shares.
export function computeChangeShares(repo: string, comps: Component[], rubric: Rubric, commit = "HEAD"): number {
  const since = addDays(today(), -rubric.components.historyDays);
  const r = git(["log", commit, `--since=${since}`, "--no-merges", "--name-status", "--no-renames", "--format=@@%an%x09%ae"], repo);
  const counts = new Map<string, number>();
  let author = "";
  let commitFiles: string[] = [];
  const flush = () => {
    const isBot = rubric.components.botAuthorPatterns.some((p) => author.toLowerCase().includes(p.toLowerCase()));
    const lockOnly = commitFiles.length > 0 && commitFiles.every((f) => rubric.components.lockfiles.includes(basename(f)));
    if (!isBot && !lockOnly) {
      for (const f of commitFiles) {
        // Installing this skill, or committing its records, isn't work in the repo's components.
        if (f.startsWith(".cursor/skills/agent-readiness/") || f.startsWith(".agent-readiness/")) continue;
        if (rubric.components.generatedPatterns.some((g) => f.includes(g))) continue;
        if (rubric.components.lockfiles.includes(basename(f))) continue;
        const owner = owningComponent(f, comps);
        if (owner) counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1);
      }
    }
    commitFiles = [];
  };
  if (r.ok) {
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("@@")) {
        flush();
        author = line.slice(2);
      } else if (/^[AMD]\t/.test(line)) {
        commitFiles.push(line.slice(2));
      }
    }
    flush();
  }
  let total = 0;
  for (const c of comps) {
    c.changes = counts.get(c.id) ?? 0;
    total += c.changes;
  }
  for (const c of comps) c.changeShare = total > 0 ? Math.round((c.changes / total) * 1000) / 1000 : Math.round((1 / comps.length) * 1000) / 1000;
  return total;
}

function nodePins(tree: string, dir: string, pm: PackageManager | null, label: string, found: string[], missing: string[]): void {
  const pkg = readPackageJson(join(tree, dir));
  const prefix = dir === "." ? "" : `${dir}/`;
  // A Bun project runs on Bun, so the Bun version is the pin that matters.
  if (pm === "bun") {
    const bunPin = [".bun-version", ".tool-versions"].find((f) => exists(join(tree, dir, f)) || exists(join(tree, f)));
    if (/^bun@/.test(pkg?.packageManager ?? "")) found.push(`${prefix}package.json packageManager`);
    else if (pkg?.engines?.bun) found.push(`${prefix}package.json engines.bun`);
    else if (bunPin) found.push(exists(join(tree, dir, bunPin)) ? `${prefix}${bunPin}` : bunPin);
    else missing.push(`the Bun version${label} (packageManager or engines.bun in package.json)`);
    return;
  }
  const nodePin = [".nvmrc", ".node-version", ".tool-versions"].find((f) => exists(join(tree, dir, f)) || exists(join(tree, f)));
  if (nodePin) found.push(exists(join(tree, dir, nodePin)) ? `${prefix}${nodePin}` : nodePin);
  else if (pkg?.engines?.node) found.push(`${prefix}package.json engines.node`);
  else if (pkg?.volta?.node) found.push(`${prefix}package.json volta`);
  else missing.push(`the Node version${label} (.nvmrc or engines.node)`);
  if (pm === "pnpm" || pm === "yarn") {
    const path = pm === "yarn" ? yarnPath(tree, dir) : null;
    if (pkg?.packageManager) found.push(`${prefix}package.json packageManager`);
    else if (path) found.push(`${path} yarnPath`);
    else missing.push(`the ${pm} version${label} (packageManager in package.json)`);
  }
}

// Versions the repo's declared image pins, which count the same as a pin file.
function dockerfilePins(tree: string, dockerfile: string | undefined): { node: boolean; pm: Set<string>; python: boolean } {
  const out = { node: false, pm: new Set<string>(), python: false };
  if (!dockerfile || !exists(join(tree, ".cursor", dockerfile))) return out;
  let path: string;
  try {
    path = containedPath(tree, [".cursor", dockerfile], ".cursor/environment.json");
  } catch {
    return out;
  }
  const text = readText(path);
  out.node = /^\s*FROM\s+(?:\S+\/)?node:\d/im.test(text) || /^\s*(ARG|ENV)\s+NODE_(VERSION|MAJOR)[= ]\s*\d/im.test(text);
  out.python = /^\s*FROM\s+(?:\S+\/)?python:\d/im.test(text) || /^\s*(ARG|ENV)\s+PYTHON_(VERSION|MAJOR)[= ]\s*\d/im.test(text);
  for (const m of text.matchAll(/\b(?:corepack\s+(?:prepare|install\s+-g)|npm\s+(?:i|install)\s+-g)\s+(pnpm|yarn)@\d/g)) out.pm.add(m[1]);
  for (const m of text.matchAll(/^\s*(?:ARG|ENV)\s+(PNPM|YARN)_VERSION[= ]\s*\S/gim)) out.pm.add(m[1].toLowerCase());
  return out;
}

function toolchain(tree: string, files: string[], pm: PackageManager | null, components: Component[], dockerfile?: string) {
  const found: string[] = [];
  let missing: string[] = [];
  const isNode = exists(join(tree, "package.json"));
  const isPy = files.some((f) => f.endsWith(".py"));
  if (isNode) nodePins(tree, ".", pm, "", found, missing);
  for (const c of components.filter((x) => x.packageManager && x.path !== ".")) {
    if (c.language !== "py") nodePins(tree, c.path, c.packageManager ?? null, ` for ${c.id}`, found, missing);
  }
  const nodeAnywhere = isNode || components.some((c) => c.packageManager && c.language !== "py");
  if (isPy && !nodeAnywhere) {
    if (exists(join(tree, ".python-version"))) found.push(".python-version");
    else missing.push("the Python version (.python-version)");
  }
  const pins = dockerfilePins(tree, dockerfile);
  const image = `.cursor/${dockerfile}`;
  missing = missing.filter((m) => !(pins.node && /the Node version/.test(m)) && !(pins.python && /the Python version/.test(m)) && ![...pins.pm].some((p) => m.startsWith(`the ${p} version`)));
  if (pins.node) found.push(`${image} (Node)`);
  if (pins.python) found.push(`${image} (Python)`);
  for (const p of pins.pm) found.push(`${image} (${p})`);
  if (found.length === 0 && missing.length === 0) missing.push("a toolchain version this rubric can read (.nvmrc, engines.node, .python-version or the declared image)");
  return { pinned: missing.length === 0 && found.length > 0, files: [...new Set(found)], missing };
}

const INSTRUCTION_PATTERNS: RegExp[] = [
  /(^|\/)AGENTS\.md$/,
  /(^|\/)CLAUDE\.md$/,
  /^\.cursorrules$/,
  /^\.cursor\/rules\/.+\.(mdc|md)$/,
  /^\.github\/copilot-instructions\.md$/,
  /^\.github\/instructions\/.+\.instructions\.md$/,
  /^\.(cursor|claude|agents)\/skills\/[^/]+\/SKILL\.md$/,
  /^README\.md$/i,
];

export function instructionFiles(files: string[]): string[] {
  return files.filter((f) => INSTRUCTION_PATTERNS.some((p) => p.test(f)) && !f.startsWith(".cursor/skills/agent-readiness/"));
}

// Lockfiles of package managers supported after a rubric's list was written. A frozen install has
// to reproduce them too; the rubric's list still decides which commits count toward shares.
const LATER_LOCKFILES = ["bun.lock", "bun.lockb"];

export function buildProfile(repo: string, tree: string, rubric: Rubric, commit = "HEAD"): Profile {
  const files = listFiles(tree, { includeHidden: true });
  const pm = detectPackageManager(tree);
  const { components, satellites } = discoverLayout(tree, files, basename(repo));
  const totalChanges = computeChangeShares(repo, components, rubric, commit);
  const supported = components.filter((c) => !c.notAssessedReason && rubric.mutation.languages.includes(c.language === "other" ? "x" : c.language));
  for (const c of components) {
    if (!c.notAssessedReason && c.language === "other") c.notAssessedReason = "no supported toolchain found";
  }
  supported.sort((a, b) => b.changeShare - a.changeShare);
  supported.slice(0, rubric.components.maxAssessed).forEach((c) => (c.assessed = true));
  supported.slice(rubric.components.maxAssessed).forEach((c) => (c.notAssessedReason = `outside the ${rubric.components.maxAssessed} most active components`));
  const envPath = join(tree, ".cursor", "environment.json");
  let environmentJson: Profile["environmentJson"] = null;
  if (exists(envPath)) {
    try {
      const env = readJson<{ install?: string; start?: string; build?: { dockerfile?: string; context?: string } }>(envPath);
      environmentJson = { path: ".cursor/environment.json", install: env.install, start: env.start, build: env.build?.dockerfile ? { dockerfile: env.build.dockerfile, context: env.build.context } : undefined };
    } catch {
      environmentJson = { path: ".cursor/environment.json" };
    }
  }
  return {
    repoType: components.filter((c) => c.manifest).length > 1 ? "monorepo" : "single",
    packageManager: pm,
    manifests: files.filter((f) => /(^|\/)(package\.json|pyproject\.toml|setup\.py|requirements[^/]*\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|Package\.swift|pubspec\.yaml|[^/]+\.(csproj|fsproj|vbproj|sln))$/.test(f) && !f.split("/").slice(0, -1).some((s) => SKIP_SEGMENT.test(s))),
    lockfiles: files.filter((f) => [...rubric.components.lockfiles, ...LATER_LOCKFILES].includes(basename(f)) && (dirname(f) === "." || components.some((c) => c.packageManager && c.path === dirname(f)))),
    ciFiles: files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f) || f === ".gitlab-ci.yml" || f === ".circleci/config.yml" || f.startsWith(".buildkite/")),
    instructionFiles: instructionFiles(files),
    toolchain: toolchain(tree, files, pm, components, environmentJson?.build?.dockerfile),
    environmentJson,
    components,
    satellites,
    historyDays: rubric.components.historyDays,
    totalChanges,
  };
}
