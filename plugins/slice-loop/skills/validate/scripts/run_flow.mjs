#!/usr/bin/env node
// Run one end-to-end flow module with Playwright and write reviewable artifacts.
//
//   node run_flow.mjs <flow.mjs> --base-url <url> --out <dir> [--mobile] [--headed]
//                     [--scratch <dir>] [--timeout <ms>] [--slow-mo <ms>]
//
// A flow module default-exports: async ({ page, step, capture, baseURL, expect }) => {}
// Output: <out>/steps.json, <out>/shots/<name>.png, <out>/video/<flow>.webm
// Exit code: 0 when every step passed, 1 on flow failure, 2 on usage/setup errors.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = { mobile: false, headed: false, timeout: 15000, slowMo: 0 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mobile") args.mobile = true;
    else if (a === "--headed") args.headed = true;
    else if (a === "--base-url") args.baseURL = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--scratch") args.scratch = argv[++i];
    else if (a === "--timeout") args.timeout = Number(argv[++i]);
    else if (a === "--slow-mo") args.slowMo = Number(argv[++i]);
    else rest.push(a);
  }
  args.flow = rest[0];
  return args;
}

function loadPlaywright(scratch) {
  const roots = [process.cwd(), scratch, process.env.SLICE_LOOP_SCRATCH].filter(Boolean);
  for (const root of roots) {
    const req = createRequire(join(resolve(root), "noop.js"));
    for (const name of ["playwright", "@playwright/test"]) {
      try {
        const mod = req(name);
        let expect = null;
        try {
          expect = req("@playwright/test").expect;
        } catch {}
        return { chromium: mod.chromium, expect };
      } catch {}
    }
  }
  return null;
}

const SYSTEM_CHROMES = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

async function launch(chromium, { headed, slowMo }) {
  const options = { headless: !headed, slowMo };
  try {
    return await chromium.launch(options);
  } catch (err) {
    const exe = SYSTEM_CHROMES.find((p) => existsSync(p));
    if (!exe) throw err;
    return chromium.launch({ ...options, executablePath: exe });
  }
}

// Used only when @playwright/test is not installed; covers the assertions flows typically need.
function fallbackExpect(timeout) {
  return (locator) => ({
    toBeVisible: () => locator.first().waitFor({ state: "visible", timeout }),
    toBeHidden: () => locator.first().waitFor({ state: "hidden", timeout }),
    async toHaveText(expected) {
      await locator.first().waitFor({ state: "visible", timeout });
      const deadline = Date.now() + timeout;
      let text = "";
      while (Date.now() < deadline) {
        text = (await locator.first().textContent()) ?? "";
        if (expected instanceof RegExp ? expected.test(text) : text.includes(expected)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`expected text ${expected} but got "${text}"`);
    },
    async toHaveCount(n) {
      const deadline = Date.now() + timeout;
      let count = -1;
      while (Date.now() < deadline) {
        count = await locator.count();
        if (count === n) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`expected count ${n} but got ${count}`);
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.flow || !args.baseURL || !args.out) {
    console.error("usage: run_flow.mjs <flow.mjs> --base-url <url> --out <dir> [--mobile] [--headed] [--scratch <dir>]");
    process.exit(2);
  }
  const pw = loadPlaywright(args.scratch);
  if (!pw) {
    console.error("run_flow: playwright not found in the project or scratch dir. Install it into scratch: npm i --prefix <scratch> playwright");
    process.exit(2);
  }

  const flowName = basename(args.flow).replace(/\.[cm]?js$/, "");
  const out = resolve(args.out);
  const shotsDir = join(out, "shots");
  const videoDir = join(out, "video");
  mkdirSync(shotsDir, { recursive: true });
  mkdirSync(videoDir, { recursive: true });

  const viewport = args.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const report = {
    flow: flowName,
    baseURL: args.baseURL,
    viewport,
    ok: true,
    steps: [],
    captures: [],
    console_errors: [],
    resource_errors: [],
    failed_requests: [],
    video: null,
    warnings: [],
  };

  const browser = await launch(pw.chromium, args);
  const contextOptions = { viewport, isMobile: args.mobile, hasTouch: args.mobile };
  let context;
  let page;
  try {
    context = await browser.newContext({ ...contextOptions, recordVideo: { dir: videoDir, size: viewport } });
    page = await context.newPage();
  } catch (err) {
    // Video needs Playwright's own ffmpeg build even when launching system Chrome.
    report.warnings.push(`video disabled: ${String(err.message).split("\n")[0]} (fix: npx playwright install ffmpeg)`);
    await context?.close().catch(() => {});
    context = await browser.newContext(contextOptions);
    page = await context.newPage();
  }
  context.setDefaultTimeout(args.timeout);

  page.on("console", (msg) => {
    if (msg.type() !== "error" || msg.location().url?.endsWith("/favicon.ico")) return;
    // Browsers log every 4xx/5xx response as a console error; those can be intended, so keep them apart.
    const bucket = msg.text().startsWith("Failed to load resource") ? report.resource_errors : report.console_errors;
    bucket.push(msg.text());
  });
  page.on("pageerror", (err) => report.console_errors.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) =>
    report.failed_requests.push({ url: req.url(), error: req.failure()?.errorText ?? "failed" }),
  );
  page.on("response", (res) => {
    if (res.status() >= 400 && !res.url().endsWith("/favicon.ico")) {
      report.failed_requests.push({ url: res.url(), status: res.status() });
    }
  });

  const capture = async (name) => {
    const file = join(shotsDir, `${name}.png`);
    await page.screenshot({ path: file });
    report.captures.push({ name, file: `shots/${name}.png` });
    return file;
  };

  const step = async (name, fn) => {
    const started = Date.now();
    try {
      const result = await fn();
      report.steps.push({ name, status: "pass", ms: Date.now() - started });
      return result;
    } catch (err) {
      report.steps.push({ name, status: "fail", ms: Date.now() - started, error: String(err?.message ?? err) });
      await capture(`fail-${report.steps.length}`).catch(() => {});
      throw err;
    }
  };

  const expect = pw.expect ?? fallbackExpect(args.timeout);

  try {
    const mod = await import(pathToFileURL(resolve(args.flow)).href);
    await mod.default({ page, step, capture, baseURL: args.baseURL.replace(/\/$/, ""), expect });
  } catch (err) {
    report.ok = false;
    report.error = String(err?.stack ?? err).split("\n").slice(0, 6).join("\n");
    if (!report.steps.some((s) => s.status === "fail")) {
      await capture("fail-final").catch(() => {});
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const recorded = readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
  if (recorded.length) {
    const target = join(videoDir, `${flowName}.webm`);
    renameSync(join(videoDir, recorded[0]), target);
    report.video = `video/${flowName}.webm`;
  }

  writeFileSync(join(out, "steps.json"), JSON.stringify(report, null, 2));
  const passed = report.steps.filter((s) => s.status === "pass").length;
  console.log(
    `${report.ok ? "PASS" : "FAIL"} ${flowName}: ${passed}/${report.steps.length} steps, ` +
      `${report.captures.length} captures, ${report.console_errors.length} console errors -> ${out}`,
  );
  for (const warning of report.warnings) console.warn(`run_flow: ${warning}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
