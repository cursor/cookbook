import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReportJson } from "../../../skill/agent-readiness/scripts/lib/types.ts";
import { auditFixture, expected } from "../../tools/fixture.ts";
import { availableModels, chooseJudge, family, judge, judgePromptDigest } from "../lib/judge.ts";
import { EVAL_SEED } from "../lib/workspace.ts";
import { FAIL_AT, HERE, LABELS, PASS_AT, agrees, labelPrompt, labelReport, trimReport } from "./labels.ts";
import type { Label } from "./labels.ts";

// npm run labels -- [mode]
//   --snapshot [--golden-dir <kept slugify clone>]  re-audit the base fixtures (needs Docker) and refresh base/
//   --write                                         regenerate labels.json from labels.ts
//   --prompts <dir>                                 write each label's judge prompt, for judging by hand or by subagents
//   --scores <file.json>                            grade scores judged elsewhere: { "<label id>": [0.7, 0.8], ... }
//   (default)                                       judge every label with a model of another family than the driver
//     --driver <model> (default: the baseline's driver)  --judge-model <model>  --runs <n> (default 3)  --out <file>

const FIXTURE_BASES = ["healthy-node", "hidden-service", "tautological-tests", "monorepo-mixed", "nested-apps-dotnet"];

function flag(name: string): string | true | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

function writeBase(name: string, r: ReportJson): void {
  mkdirSync(join(HERE, "base"), { recursive: true });
  writeFileSync(join(HERE, "base", `${name}.json`), JSON.stringify(trimReport(r), null, 1) + "\n");
  process.stdout.write(`base/${name}.json: ${r.executive.heading}\n`);
}

export function labelsJson(): string {
  return JSON.stringify({ passAt: PASS_AT, failAt: FAIL_AT, judgePrompt: judgePromptDigest(), labels: LABELS }, null, 2) + "\n";
}

interface Scored {
  label: Label;
  scores: number[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const r2 = (x: number) => Math.round(x * 100) / 100;

// How well the scores separate the labels: agreement with each label's verdict, the chance a
// known-good label outscores a broken one (AUC), and each label's run-to-run spread.
export function agreement(scored: Scored[]): { agree: number; total: number; auc: number | null; rows: string[] } {
  const rows: string[] = [];
  let agree = 0;
  let total = 0;
  for (const s of scored) {
    if (!s.scores.length) {
      rows.push(`${s.label.id.padEnd(36)} ${s.label.expected.padEnd(5)} no score`);
      continue;
    }
    const m = mean(s.scores);
    const ok = agrees(s.label, m);
    total++;
    if (ok) agree++;
    rows.push(`${s.label.id.padEnd(36)} ${s.label.expected.padEnd(5)} mean ${r2(m).toFixed(2)} range ${r2(Math.max(...s.scores) - Math.min(...s.scores)).toFixed(2)} ${ok ? "agrees" : "DISAGREES"}  [${s.scores.join(", ")}]`);
  }
  const good = scored.filter((s) => s.label.expected === "pass" && s.scores.length).map((s) => mean(s.scores));
  const bad = scored.filter((s) => s.label.expected === "fail" && s.scores.length).map((s) => mean(s.scores));
  let wins = 0;
  for (const g of good) for (const b of bad) wins += g > b ? 1 : g === b ? 0.5 : 0;
  return { agree, total, auc: good.length && bad.length ? r2(wins / (good.length * bad.length)) : null, rows };
}

function report(scored: Scored[], judgeModel: string, out: string | null): void {
  const a = agreement(scored);
  for (const row of a.rows) process.stdout.write(row + "\n");
  process.stdout.write(`Judge ${judgeModel}: agrees with ${a.agree} of ${a.total} labels; good-versus-broken AUC ${a.auc ?? "n/a"}.\n`);
  if (out) writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), judgeModel, judgePrompt: judgePromptDigest(), agree: a.agree, total: a.total, auc: a.auc, labels: scored.map((s) => ({ id: s.label.id, expected: s.label.expected, scores: s.scores })) }, null, 2) + "\n");
}

async function main(): Promise<void> {
  if (flag("snapshot")) {
    for (const f of FIXTURE_BASES) {
      const run = expected(f).runs[0];
      const a = auditFixture(f, run, { seed: EVAL_SEED });
      if (a.code !== 0) throw new Error(`${f}: audit failed: ${a.out.slice(-400)}`);
      if (a.report.maturity.level !== run.level) throw new Error(`${f}: Level ${a.report.maturity.level}, but expected.json says ${run.level}; a base report must match its fixture`);
      writeBase(f, a.report as ReportJson);
    }
    const golden = flag("golden-dir");
    if (typeof golden === "string") writeBase("slugify", JSON.parse(readFileSync(join(resolve(golden), ".agent-readiness/latest/report.json"), "utf8")) as ReportJson);
    return;
  }
  if (flag("write")) {
    writeFileSync(join(HERE, "labels.json"), labelsJson());
    process.stdout.write(`labels.json: ${LABELS.length} labels\n`);
    return;
  }
  const prompts = flag("prompts");
  if (typeof prompts === "string") {
    mkdirSync(resolve(prompts), { recursive: true });
    for (const l of LABELS) writeFileSync(join(resolve(prompts), `${l.id}.txt`), labelPrompt(l));
    process.stdout.write(`Wrote ${LABELS.length} prompts to ${resolve(prompts)}. Judge each one on its own, then pass the scores with --scores.\n`);
    return;
  }
  const out = typeof flag("out") === "string" ? resolve(flag("out") as string) : join(HERE, "last-check.json");
  const scoresFile = flag("scores");
  if (typeof scoresFile === "string") {
    const given = JSON.parse(readFileSync(resolve(scoresFile), "utf8")) as Record<string, number[]>;
    report(LABELS.map((label) => ({ label, scores: given[label.id] ?? [] })), String(flag("judge-model") ?? "external"), null);
    return;
  }
  const key = process.env.CURSOR_API_KEY;
  if (!key) throw new Error("CURSOR_API_KEY isn't set. Use --prompts to judge the labels some other way, then --scores.");
  const baseline = join(HERE, "..", "baseline.json");
  const driver = typeof flag("driver") === "string" ? (flag("driver") as string) : existsSync(baseline) ? ((JSON.parse(readFileSync(baseline, "utf8")) as { instrument?: { driverModel: string }; model?: string }).instrument?.driverModel ?? (JSON.parse(readFileSync(baseline, "utf8")) as { model?: string }).model ?? "claude-opus-5-5") : "claude-opus-5-5";
  const explicit = typeof flag("judge-model") === "string" ? (flag("judge-model") as string) : undefined;
  const choice = chooseJudge(driver, explicit ? [] : await availableModels(key), explicit);
  process.stdout.write(`Judge: ${choice.model} (${choice.why}); driver family ${family(driver)}.\n`);
  const runs = Number(flag("runs") ?? 3);
  const scored: Scored[] = [];
  for (const label of LABELS) {
    const scores: number[] = [];
    for (let i = 0; i < runs; i++) {
      const j = await judge(label.judge, labelReport(label), choice.model, key);
      if (j.score !== null) scores.push(j.score);
      else process.stdout.write(`${label.id}: no score (${j.reasons.join("; ")})\n`);
    }
    scored.push({ label, scores });
  }
  report(scored, choice.model, out);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(HERE, "check.ts")) {
  main().catch((e: Error) => {
    process.stderr.write(`labels: ${e.message}\n`);
    process.exitCode = 1;
  });
}
