import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderHtml } from "../skill/agent-readiness/scripts/lib/render-html.ts";
import { ladderLine, nextMove, pageNumbers, renderMarkdown, scaleLine, shortReason, trendLine, validatePart1 } from "../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { validateAgainst } from "../skill/agent-readiness/scripts/lib/schema.ts";
import type { HistoryLine } from "../skill/agent-readiness/scripts/lib/types.ts";
import type { AuditSpec } from "./helpers.ts";
import { makeAudit, reportFor } from "./helpers.ts";

const rubric = loadRubric("2026-10-alpha");

const mixed: AuditSpec = {
  components: [
    { id: "api", share: 0.56, test: "fail", diagnosis: { cause: "service", detail: "connection refused on port 5432", service: "Postgres" }, faults: "not_run" },
    { id: "worker", share: 0.27, faults: "fail" },
    { id: "shared", share: 0.15, faults: "pass" },
    { id: "infra", share: 0.02, assessed: false },
  ],
};

const line = (id: string, date: string, levels: Record<string, 0 | 1 | 2>, repoLevel: 0 | 1 | 2): HistoryLine => ({ id, kind: "audit", date, commit: "abc", rubric: "2026-10-alpha", scriptsDigest: "x", result: "sealed", levels, repoLevel, scenarioLevels: {}, shares: { api: 0.56, worker: 0.27, shared: 0.15 }, active: ["api", "worker", "shared"], seedPinned: false });

describe("the cascade in report.md", () => {
  test("the ladder line marks the level with arrows between steps, and the judge's scale line is unchanged", () => {
    const r = reportFor(makeAudit(mixed));
    assert.equal(ladderLine(r), "Level ladder: **[0 Not bootable]** → 1 Bootable → 2 Verifiable → 3 Delegable → 4 Scalable");
    assert.match(scaleLine(r), /^\[Level 0 Not bootable\] > Level 1 Bootable > /);
    const none = reportFor(makeAudit({ components: [{ id: "infra", share: 1, assessed: false }] }));
    assert.doesNotMatch(ladderLine(none), /\[/);
    assert.match(ladderLine(none), /no level marked/);
  });

  test("a first audit says so; later audits show a trend and what changed", () => {
    const first = reportFor(makeAudit(mixed));
    assert.match(trendLine(first), /first audit/);
    assert.match(renderMarkdown(first, rubric), /## 2\. Have I improved\n\nThis is the first audit/);
    const fixed: AuditSpec = { components: mixed.components.map((c) => (c.id === "worker" ? { ...c, faults: "pass" as const } : c)) };
    const later = reportFor(makeAudit({ ...fixed, id: "aud-2026-11-03-abc1234-0002" }), [line("aud-2026-10-27-abc1234-0001", "2026-10-27", { api: 0, worker: 1, shared: 2 }, 0)], null, first);
    assert.deepEqual(validateAgainst("report", later), []);
    const ch = later.progress!.changes!;
    assert.deepEqual(ch.components, [{ id: "worker", from: 1, to: 2 }]);
    assert.ok(ch.nowMet.some((m) => m.component === "worker"), JSON.stringify(ch.nowMet));
    assert.deepEqual(ch.nowFailing, []);
    const md = renderMarkdown(later, rubric);
    assert.match(md, /- \*\*worker:\*\* Level 1 to Level 2\./);
    assert.match(trendLine(later), /^Trend: ▁▁ /);
    assert.match(pageNumbers(later)[0].comparison, /^Level 2 needs \d+ of \d+; last audit: \d+ of \d+$/);
    assert.match(md, /\| `worker` \| Level 2 \| ○○●○○ \| 27% \| ▂▄ \|/);
  });

  test("roadmap steps are grouped by the level they reach, up to Level 4", () => {
    const md = renderMarkdown(reportFor(makeAudit(mixed)), rubric);
    const idx = ["### Level 1, bootable (next)", "### Level 2, verifiable (later)", "### Level 3, delegable (later, experimental)", "### Level 4, scalable (later, experimental)"].map((h) => md.indexOf(h));
    assert.ok(idx.every((i, n) => i >= 0 && (n === 0 || i > idx[n - 1])), String(idx));
    assert.match(md.slice(idx[0], idx[1]), /Set up the service the tests expect on port 5432 for agents in api/);
  });
});

describe("the sign-off fixes", () => {
  test("an unsupported component with no recent changes still gets its own words in part 1", () => {
    const r = reportFor(makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }, { id: "infra", share: 0, assessed: false }] }));
    assert.equal(r.executive.unassessed?.text, "infra (no recent changes), because Terraform isn't supported yet");
    assert.doesNotMatch(renderMarkdown(r, rubric), /\*\*Not assessed:\*\* \./);
  });

  test("the ready count says which assessed components it leaves out", () => {
    const r = reportFor(makeAudit({ components: [{ id: "a", share: 0.5, faults: "pass" }, { id: "b", share: 0.45, faults: "pass" }, { id: "c", share: 0.05, faults: "pass" }] }));
    assert.equal(r.executive.numbers[0].value, "2 of 2");
    assert.match(r.executive.numbers[0].comparison, /; c gets under 10% of changes, so it isn't counted$/);
    assert.deepEqual(validatePart1(r, rubric, null), []);
  });

  test("a sampled-out component reads \"because it's outside\"", () => {
    const audit = makeAudit({ components: [{ id: "a", share: 0.9, faults: "pass" }, { id: "golf", share: 0.1, assessed: false }] });
    audit.profile!.components.find((c) => c.id === "golf")!.notAssessedReason = "outside the 6 most active components";
    assert.match(reportFor(audit).executive.unassessed!.text, /golf \(10%\), because it's outside the 6 most active components/);
  });

  test("with nothing assessable, the heading doesn't repeat itself and the record doesn't claim a missing runtime", () => {
    const r = reportFor(makeAudit({ components: [{ id: "inventory-api", share: 1, assessed: false }] }));
    assert.equal(r.executive.heading, "Not assessed: none of the components found can be assessed yet");
    assert.match(r.executive.numbers[0].comparison, /^1 component found, and it can't be assessed yet$/);
    const env = r.details.record.find((x) => x.label === "Replay environment")!.value;
    assert.doesNotMatch(env, /no container runtime/);
  });

  test("the service step names a service only when the output named it, and otherwise its port", () => {
    const r = reportFor(makeAudit(mixed));
    const fix = r.actions.find((a) => a.itemId === "clean.test:api")!;
    assert.equal(fix.title, "Set up the service the tests expect on port 5432 for agents in api");
    assert.match(fix.why, /nothing starts the service the tests expect on port 5432: the connection was refused\.$/);
    assert.doesNotMatch(renderMarkdown(r, rubric), /Postgres/);
    const named = reportFor(makeAudit({ components: [{ ...mixed.components[0], diagnosis: { cause: "service", detail: "connection refused on port 5432; the output names Postgres", service: "Postgres", serviceNamed: true } }, ...mixed.components.slice(1)] }));
    assert.equal(named.actions.find((a) => a.itemId === "clean.test:api")!.title, "Set up Postgres on port 5432 for agents in api");
  });

  test("only one roadmap step says next, and part 1 says once that agent PRs weren't measured", () => {
    const r = reportFor(makeAudit(mixed));
    assert.ok(r.roadmap.items.filter((i) => i.statusText === "next").length <= 1, JSON.stringify(r.roadmap.items.map((i) => i.statusText)));
    assert.doesNotMatch(r.executive.coverage, /weren't measured/);
    assert.equal(r.executive.numbers[1].value, "not measured");
  });

  test("the support link is relative to the report, and the evidence log has five columns", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 0.8, faults: "pass" }, { id: "core", share: 0.2, assessed: false }] });
    const r = reportFor(audit);
    r.executive.unassessed!.supportDoc = ".cursor/skills/agent-readiness/references/supported.md";
    const md = renderMarkdown(r, rubric);
    assert.match(md, /\[supported\.md\]\(\.\.\/\.\.\/\.cursor\/skills\/agent-readiness\/references\/supported\.md\)/);
    assert.match(md, /\| ID \| Check \| Component \| What ran \| Result \|\n\|---\|---\|---\|---\|---\|/);
  });
});

describe("report.html", () => {
  test("is self-contained: inline CSS and SVG, no scripts or fetched assets, light, dark and print styles", () => {
    const html = renderHtml(reportFor(makeAudit(mixed)));
    assert.doesNotMatch(html, /<script|<link|<img|src=|@import|url\(/i);
    assert.doesNotMatch(html, /prefers-color-scheme/);
    assert.match(html, /<meta name="color-scheme" content="light">/);
    assert.match(html, /<body><input type="checkbox" id="theme" class="theme-switch"><div class="theme">/);
    assert.match(html, /<label for="theme" class="toggle"><span class="knob" aria-hidden="true"><\/span>Dark mode<\/label>/);
    assert.match(html, /\.theme\{color-scheme:light;--bg:#f4f5f7;/);
    assert.match(html, /#theme:checked\+\.theme\{color-scheme:dark;--bg:#0e1117;/);
    assert.match(html, /@media print\{\.theme,#theme:checked\+\.theme\{color-scheme:light;/);
    assert.match(html, /@media print\{[^@]*\.toggle\{display:none\}/);
    assert.match(html, /<svg role="img" aria-label="Level 0 of 4, Not bootable"/);
    assert.match(html, /<p class="ladder-text small">Level ladder: <b>0 not bootable<\/b> → 1 bootable → 2 verifiable → 3 delegable \(experimental\) → 4 scalable \(experimental\)<\/p>/);
  });

  test("page 1 says what holds a component without the missed-fault list", () => {
    const md = renderMarkdown(reportFor(makeAudit(mixed)), rubric);
    const part1 = md.slice(0, md.indexOf("## 2."));
    assert.doesNotMatch(part1, /; missed:/);
    assert.equal(shortReason("caught 0 of 5 planted faults; missed: change_constant at src/retry.js:5"), "caught 0 of 5 planted faults");
  });

  test("page 1 leads with the next move and labels Levels 3 and 4 experimental", () => {
    const r = reportFor(makeAudit(mixed));
    const html = renderHtml(r);
    const md = renderMarkdown(r, rubric);
    const move = nextMove(r)!;
    assert.ok(html.indexOf('id="next-move"') < html.indexOf('id="improved"'));
    assert.match(md.slice(0, md.indexOf("## 2.")), new RegExp(`> \\*\\*Next move, step ${move.step}:\\*\\* `));
    assert.match(md, /### Level 3, delegable \(later, experimental\)/);
    assert.match(md.slice(0, md.indexOf("## 2.")), /Level 2 is the proven top of this version\./);
  });

  test("follows the cascade, shows the sealed headline, and every evidence link has a row to land on", () => {
    const r = reportFor(makeAudit(mixed));
    r.executive.headline = "api sets the level: <its tests> & more";
    const html = renderHtml(r);
    const idx = ['id="where"', 'id="improved"', 'id="next"', 'id="roadmap"', 'id="details"'].map((s) => html.indexOf(s));
    assert.ok(idx.every((i, n) => i >= 0 && (n === 0 || i > idx[n - 1])), String(idx));
    assert.ok(html.includes("api sets the level: &lt;its tests&gt; &amp; more"));
    for (const [, id] of html.matchAll(/href="#(ev-\d+)"/g)) assert.ok(html.includes(`<tr id="${id}">`), id);
    assert.match(html, /This is the first audit/);
  });
});
