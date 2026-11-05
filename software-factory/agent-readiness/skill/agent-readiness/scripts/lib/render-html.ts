import { describeRate } from "./outcomes.ts";
import { EXPERIMENTAL_NOTE, groupedSteps, isExperimental, levelDefinition, markedLevel, nextMove, pageNumbers, shortReason, stepOf } from "./render.ts";
import type { Level, ReportJson } from "./types.ts";
import { fmtDate, fmtShortDate } from "./util.ts";

// report.html: the same sealed report.json as report.md, as one self-contained page. Inline CSS and
// SVG only, no scripts and nothing fetched, so it opens offline, prints, and follows the reader's
// light or dark setting. Every word on it comes from report.json; the page adds only layout.

const esc = (s: string | number) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Backticks in report text mark code, as in report.md.
const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/https?:\/\/[^\s<)]+[^\s<).,;]/g, (u) => `<a href="${u}">${u}</a>`);

const levelText = (l: Level | null | undefined) => (l === null || l === undefined ? "no level" : `Level ${l}`);

const anchor = (itemId: string) => `step-${itemId.replace(/[^a-z0-9-]/gi, "-")}`;

function list(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// Tokens. One accent carries links, reached levels and the next move; status hues appear only next to
// a word that says the same thing. Every text pair meets WCAG AA and every mark 3:1, in both modes.
const LIGHT = `color-scheme:light;--bg:#f4f5f7;--surface:#fff;--sunken:#f0f2f5;--ink:#1b2230;--muted:#545d6b;--rule:#dde2e9;--mark:#8a93a1;
--accent:#1f5fd1;--accent-tint:#eef3fd;--ok:#17703e;--bad:#b3261e;--warn:#8a5300;--bad-tint:#fbefee;--warn-tint:#fbf4e9;--on-accent:#fff`;
const DARK = `color-scheme:dark;--bg:#0e1117;--surface:#161b23;--sunken:#1c222c;--ink:#e7eaf0;--muted:#a3acba;--rule:#2a313d;--mark:#6f7a8b;
--accent:#84b0ff;--accent-tint:#1a2435;--ok:#5fd08c;--bad:#ff8a80;--warn:#f2b44f;--bad-tint:#2a1a1b;--warn-tint:#2a2316;--on-accent:#0e1117`;

// Light whatever the OS setting; the header's checkbox switches the wrapper to dark without script.
const CSS = `
:root{--fs-1:12px;--fs-2:13px;--fs-3:15px;--fs-4:17px;--fs-5:20px;--fs-6:28px;--r:4px;
--s-1:4px;--s-2:8px;--s-3:12px;--s-4:16px;--s-5:24px;--s-6:40px}
.theme{${LIGHT}}
#theme:checked+.theme{${DARK}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0}
.theme{min-height:100vh;background:var(--bg);color:var(--ink);font:var(--fs-3)/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-variant-numeric:tabular-nums}
.page{max-width:960px;margin:0 auto;padding:var(--s-6) var(--s-5) 64px}
h1,h2,h3{text-wrap:balance;margin:0}
p,li,dd{text-wrap:pretty}
header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:var(--s-2);padding-bottom:var(--s-3);border-bottom:1px solid var(--rule)}
header h1{font-size:var(--fs-3);font-weight:600}
header .when{font-size:var(--fs-2);color:var(--muted)}
header .meta{display:flex;align-items:center;gap:var(--s-4)}
.theme-switch{position:absolute;top:0;left:0;width:1px;height:1px;margin:0;opacity:0}
.toggle{display:inline-flex;align-items:center;gap:var(--s-2);font-size:var(--fs-2);color:var(--muted);cursor:pointer;user-select:none}
.toggle:hover{color:var(--ink)}
.knob{position:relative;width:26px;height:14px;border:1px solid var(--mark);border-radius:7px;background:var(--surface)}
.knob::after{content:"";position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%;background:var(--mark)}
#theme:checked+.theme .knob{background:var(--accent);border-color:var(--accent)}
#theme:checked+.theme .knob::after{left:14px;background:var(--on-accent)}
#theme:focus-visible+.theme .toggle{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}
.notice{margin:var(--s-4) 0 0;padding:var(--s-3) var(--s-4);background:var(--warn-tint);border:1px solid var(--warn);border-radius:var(--r);font-size:var(--fs-3)}
.notice strong{color:var(--warn)}
main>section{padding:var(--s-6) 0 0}
main>section+section{margin-top:var(--s-6);border-top:1px solid var(--rule)}
h2{font-size:var(--fs-5);font-weight:650;letter-spacing:-.01em;margin-bottom:var(--s-4)}
h3{font-size:var(--fs-4);font-weight:600;margin:var(--s-5) 0 var(--s-2)}
.level{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s-2) var(--s-4);margin:0}
.level b{font-size:var(--fs-6);font-weight:700;letter-spacing:-.02em;line-height:1.15}
.level span{font-size:var(--fs-2);color:var(--muted)}
.headline{font-size:var(--fs-4);font-weight:500;max-width:68ch;margin:var(--s-3) 0 var(--s-5)}
.def{font-size:var(--fs-2);color:var(--muted);max-width:80ch;margin:var(--s-1) 0 0}
.muted{color:var(--muted)}.small{font-size:var(--fs-2)}
.move{margin:var(--s-5) 0;padding:var(--s-4) var(--s-5);background:var(--accent-tint);border:1px solid var(--accent);border-radius:var(--r)}
.move .what{font-size:var(--fs-2);color:var(--muted);margin:0 0 var(--s-1)}
.move h3{margin:0 0 var(--s-2)}
.move p{margin:0 0 var(--s-3);max-width:75ch}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:var(--s-1) var(--s-4);margin:0;font-size:var(--fs-2)}
.facts dt{color:var(--muted)}.facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
.numbers{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin:var(--s-5) 0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
.numbers>div{padding:var(--s-3) var(--s-4) var(--s-3) 0}
.numbers>div+div{padding-left:var(--s-4);border-left:1px solid var(--rule)}
.numbers .label{font-size:var(--fs-2);color:var(--muted)}
.numbers .value{font-size:var(--fs-5);font-weight:650;margin:var(--s-1) 0}
.numbers .cmp{font-size:var(--fs-2);color:var(--muted)}
.note{margin:var(--s-4) 0;padding:var(--s-3) var(--s-4);border:1px solid var(--rule);border-radius:var(--r);background:var(--sunken);font-size:var(--fs-2)}
.exp{font-size:var(--fs-1);font-weight:600;color:var(--muted);border:1px dashed var(--mark);border-radius:var(--r);padding:0 5px;margin-left:var(--s-2);vertical-align:2px;white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:var(--fs-2);margin:var(--s-2) 0 var(--s-4)}
th,td{border-bottom:1px solid var(--rule);padding:var(--s-2) var(--s-3) var(--s-2) 0;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{color:var(--muted);font-weight:600;font-size:var(--fs-1)}
td.num,th.num{text-align:right;white-space:nowrap}
.comps td{vertical-align:middle}.comps th{white-space:nowrap}
.comps .name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--fs-2);font-weight:600}
.share{display:inline-block;width:64px;height:6px;background:var(--sunken);border:1px solid var(--rule);border-radius:2px;vertical-align:middle;margin-right:var(--s-2);overflow:hidden}.share>i{display:block;height:100%;background:var(--mark)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:var(--sunken);padding:0 4px;border-radius:3px}
code.id{white-space:nowrap}
a{color:var(--accent);text-underline-offset:2px}
a:hover{text-decoration-thickness:2px}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.none{color:var(--muted)}
ul.changes{list-style:none;padding:0;margin:0;max-width:80ch}ul.changes li{padding:var(--s-1) 0}
.steps{list-style:none;padding:0;margin:0}
.step{display:grid;grid-template-columns:96px 1fr;gap:var(--s-1) var(--s-4);padding:var(--s-4) 0;border-top:1px solid var(--rule)}
.step:first-child{border-top:0}
.step .n{font-size:var(--fs-2);color:var(--muted);line-height:1.3}
.step .n b{display:block;font-size:var(--fs-3);color:var(--ink);font-weight:600}
.step h3{margin:0 0 var(--s-1)}
.step .unlocks{font-weight:600;margin:var(--s-1) 0 var(--s-2);max-width:75ch}
.ask{margin:0 0 var(--s-4);padding:var(--s-3) var(--s-4);border:1px solid var(--rule);border-radius:var(--r);max-width:80ch}
.lvl{display:grid;grid-template-columns:130px 1fr;gap:var(--s-1) var(--s-4);padding:var(--s-3) 0;border-top:1px solid var(--rule)}
.lvl .tag{font-size:var(--fs-2);color:var(--muted)}
.lvl.reached .tag{color:var(--ok)}.lvl.next .tag{color:var(--accent)}
.lvl h3{margin:0;font-size:var(--fs-3)}
.lvl ul{margin:var(--s-2) 0 0;padding-left:var(--s-4)}.lvl li{margin:var(--s-1) 0}
.status{color:var(--muted)}
svg text{fill:var(--ink);font-family:inherit}svg .m{fill:var(--muted)}
.legend{font-size:var(--fs-1);color:var(--muted)}
footer{margin-top:var(--s-6);padding-top:var(--s-3);border-top:1px solid var(--rule);color:var(--muted);font-size:var(--fs-2)}
.ladder-text{display:none;margin:0 0 var(--s-2)}
@media (max-width:640px){.page{padding:var(--s-5) var(--s-4) 48px}.step,.lvl{grid-template-columns:1fr}.numbers>div+div{padding-left:0;border-left:0;border-top:1px solid var(--rule)}.hide-narrow{display:none}.ladder{display:none}.ladder-text{display:block}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media print{.theme,#theme:checked+.theme{${LIGHT};--bg:#fff;--sunken:#f3f4f6}.theme{min-height:0;font-size:10.5pt}.toggle{display:none}.page{max-width:none;padding:0}
main>section{break-inside:auto}.step,.lvl,.move,.numbers,tr{break-inside:avoid}h2,h3{break-after:avoid}a{color:inherit;text-decoration:none}}
`;

// The scale as five stops. Reached stops fill with the accent; Levels 3 and 4 are dashed, because
// this version doesn't validate them end to end. Nothing is marked when the audit couldn't give a level.
// The SVG labels get too small to read on a phone, so narrow screens get the ladder as text.
function ladderText(r: ReportJson): string {
  const here = markedLevel(r);
  const stops = ([0, 1, 2, 3, 4] as Level[]).map((l) => {
    const t = `${l} ${esc(r.scale[l].plain)}${isExperimental(l) ? " (experimental)" : ""}`;
    return l === here ? `<b>${t}</b>` : t;
  });
  return `<p class="ladder-text small">Level ladder: ${stops.join(" → ")}${here === null ? " (no level marked)" : ""}</p>`;
}

function ladderSvg(r: ReportJson, width = 900): string {
  const here = markedLevel(r);
  const h = 74;
  const pad = 48;
  const step = (width - pad * 2) / 4;
  const x = (l: number) => pad + l * step;
  const y = 22;
  const parts: string[] = [];
  parts.push(`<line x1="${x(0)}" y1="${y}" x2="${x(2)}" y2="${y}" stroke="var(--mark)" stroke-width="2"/>`);
  parts.push(`<line x1="${x(2)}" y1="${y}" x2="${x(4)}" y2="${y}" stroke="var(--mark)" stroke-width="2" stroke-dasharray="4 5"/>`);
  if (here !== null && here > 0) parts.push(`<line x1="${x(0)}" y1="${y}" x2="${x(here)}" y2="${y}" stroke="var(--accent)" stroke-width="4"/>`);
  for (const s of r.scale) {
    const on = here !== null && s.level <= here;
    const cur = s.level === here;
    const exp = isExperimental(s.level);
    parts.push(`<g><title>${esc(`Level ${s.level}, ${s.name}${exp ? " (experimental)" : ""}: ${s.meaning}`)}</title><circle cx="${x(s.level)}" cy="${y}" r="${cur ? 12 : 8}" fill="${on ? "var(--accent)" : "var(--surface)"}" stroke="${on ? "var(--accent)" : "var(--mark)"}" stroke-width="2"${exp && !on ? ' stroke-dasharray="3 3"' : ""}/>`);
    parts.push(`<text x="${x(s.level)}" y="${y + 4}" text-anchor="middle" font-size="${cur ? 12 : 10}" font-weight="700" ${on ? 'style="fill:var(--on-accent)"' : 'class="m"'}>${s.level}</text></g>`);
    parts.push(`<text x="${x(s.level)}" y="${y + 32}" text-anchor="middle" font-size="12" ${cur ? 'font-weight="700"' : 'class="m"'}>${esc(s.name)}</text>`);
    if (exp) parts.push(`<text x="${x(s.level)}" y="${y + 47}" text-anchor="middle" font-size="10" class="m">experimental</text>`);
  }
  return `<svg role="img" aria-label="${esc(here === null ? "No level marked on the scale" : `Level ${here} of 4, ${r.scale[here].name}`)}" viewBox="0 0 ${width} ${h}" width="100%" style="max-width:${width}px;display:block">${parts.join("")}</svg>`;
}

// A step chart of the repo level at each audit and recheck. A failed recheck is a cross, labelled in
// place, so its meaning doesn't depend on color or a tooltip.
function trendSvg(points: { date: string; level: Level | null | undefined; kind: string; result: string }[], width = 900, height = 104): string {
  const left = 28;
  const right = 28;
  const top = 18;
  const bottom = 24;
  const iw = width - left - right;
  const ih = height - top - bottom;
  const x = (i: number) => left + (i * iw) / (points.length - 1);
  const y = (l: number) => top + ih - (l / 4) * ih;
  const parts: string[] = [];
  for (const l of [0, 2, 4]) parts.push(`<line x1="${left}" x2="${width - right}" y1="${y(l)}" y2="${y(l)}" stroke="var(--rule)"/><text x="${left - 8}" y="${y(l) + 4}" text-anchor="end" font-size="10" class="m">${l}</text>`);
  let d = "";
  points.forEach((p, i) => {
    if (p.level === null || p.level === undefined) return;
    const prev = points.slice(0, i).reverse().find((q) => q.level !== null && q.level !== undefined);
    d += prev ? ` H${x(i)} V${y(p.level)}` : ` M${x(i)} ${y(p.level)}`;
  });
  if (d) parts.push(`<path d="${d.trim()}" fill="none" stroke="var(--accent)" stroke-width="2"/>`);
  points.forEach((p, i) => {
    const has = p.level !== null && p.level !== undefined;
    const failed = p.kind === "recheck" && p.result === "failed";
    const cy = has ? y(p.level as number) : y(0);
    const tip = `<title>${esc(`${fmtShortDate(p.date)}: ${p.kind}${failed ? ", failed" : ""}, ${levelText(p.level)}`)}</title>`;
    if (failed) parts.push(`<g>${tip}<path d="M${x(i) - 5} ${cy - 5} L${x(i) + 5} ${cy + 5} M${x(i) + 5} ${cy - 5} L${x(i) - 5} ${cy + 5}" stroke="var(--bad)" stroke-width="2.5"/></g><text x="${x(i)}" y="${cy - 9}" text-anchor="middle" font-size="10" style="fill:var(--bad)">recheck failed</text>`);
    else parts.push(`<circle cx="${x(i)}" cy="${cy}" r="4" fill="${has ? "var(--accent)" : "var(--surface)"}" stroke="var(--accent)" stroke-width="2">${tip}</circle>`);
    const show = points.length <= 7 || i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 6) === 0;
    if (show) parts.push(`<text x="${x(i)}" y="${height - 6}" text-anchor="middle" font-size="10" class="m">${esc(fmtShortDate(p.date))}</text>`);
  });
  return `<svg role="img" aria-label="Repo level at each audit and recheck" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px;display:block">${parts.join("")}</svg>`;
}

function miniLadderSvg(level: Level | null): string {
  const dots = [0, 1, 2, 3, 4].map((l) => {
    const on = level !== null && l <= level;
    return `<circle cx="${6 + l * 14}" cy="7" r="${l === level ? 5 : 3.5}" fill="${on ? "var(--accent)" : "var(--surface)"}" stroke="${on ? "var(--accent)" : "var(--mark)"}" stroke-width="1.5"${l >= 3 && !on ? ' stroke-dasharray="2 2"' : ""}/>`;
  });
  return `<svg viewBox="0 0 68 14" width="68" height="14" aria-hidden="true" style="vertical-align:middle"><line x1="6" x2="62" y1="7" y2="7" stroke="var(--mark)" stroke-width="1"/>${dots.join("")}</svg>`;
}

function sparkSvg(levels: (Level | null | undefined)[]): string {
  const w = 84;
  const h = 20;
  const x = (i: number) => 3 + (i * (w - 6)) / (levels.length - 1);
  const y = (l: number) => h - 3 - (l / 4) * (h - 6);
  let d = "";
  levels.forEach((l, i) => {
    if (l === null || l === undefined) return;
    d += d ? ` H${x(i)} V${y(l)}` : `M${x(i)} ${y(l)}`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(levels.map((l) => levelText(l)).join(", "))}" style="vertical-align:middle"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5"/></svg>`;
}

function supportHref(doc: string | null): string {
  if (!doc) return "";
  // report.html sits in .agent-readiness/latest/, two folders below the repo root.
  return doc.startsWith("references/") ? ` What the audit supports: <code>${esc(doc)}</code> in the agent-readiness skill.` : ` What the audit supports: <a href="../../${esc(doc)}">supported.md</a>.`;
}

function evLinks(ids: string[]): string {
  return ids.map((id) => `<a href="#${esc(id)}"><code class="id">${esc(id)}</code></a>`).join(", ");
}

// One line on what changed, for the top of the page; part 2 and the history carry the rest.
function changeLine(r: ReportJson): string | null {
  const ch = r.progress?.changes;
  if (!ch) return null;
  const since = fmtShortDate(ch.since.date);
  const from = ch.repo.from;
  const to = ch.repo.to;
  const move = from === to ? `Unchanged since ${since}` : from !== null && to !== null && to > from ? `Up from Level ${from} since ${since}` : from !== null && to !== null ? `Down from Level ${from} since ${since}` : `Changed since ${since}`;
  const closed = r.progress!.closed.length;
  return `${move}${closed ? ` · ${closed} ${closed === 1 ? "step" : "steps"} closed` : ""}`;
}

// What holds a component where it is, and the step that moves it.
function holds(r: ReportJson, c: ReportJson["components"]["included"][number]): string {
  if (c.level !== null && c.level >= 2) return `<span class="ok">Ready for agents</span>`;
  const cap = c.capReasons.find((k) => k.state !== "met");
  const item = r.roadmap.items.find((i) => i.status !== "done" && new RegExp(`(^|, )${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} to Level`).test(i.unlocks));
  const why = cap ? `${cap.label}: ${shortReason(cap.reason)}` : "";
  return `${esc(why)}${item ? ` · <a href="#${anchor(item.id)}">step ${item.order}</a>` : ""}`;
}

function summary(r: ReportJson): string {
  const ex = r.executive;
  const history = r.progress?.history ?? [];
  const out: string[] = [`<section id="where" aria-labelledby="where-h"><h2 id="where-h" class="sr">Where am I now</h2>`];
  const change = changeLine(r);
  out.push(`<p class="level"><b>${esc(ex.heading)}</b>${change ? `<span>${esc(change)}</span>` : ""}</p>`);
  out.push(`<p class="headline">${esc(ex.headline)}</p>`);
  out.push(`<div class="ladder">${ladderSvg(r)}</div>`, ladderText(r));
  const def = levelDefinition(r);
  out.push(`<p class="def">${def ? `${esc(def)} ` : "No level is marked: this audit couldn't give one. "}${esc(EXPERIMENTAL_NOTE)}</p>`);
  const move = nextMove(r);
  if (move) {
    out.push(`<div class="move" id="next-move"><p class="what">Next move${move.step !== null ? ` · step ${move.step}` : ""}${move.experimental ? ' <span class="exp">experimental</span>' : ""}</p><h3>${inline(move.title)}</h3><p>${inline(move.unlocks)}</p><dl class="facts"><dt>Effort and owner</dt><dd>${inline(move.effort)}</dd>${move.decision ? `<dt>Decision</dt><dd>${inline(move.decision)}.</dd>` : ""}</dl><p class="small" style="margin:var(--s-3) 0 0"><a href="#${anchor(move.itemId)}">How to do it, and the evidence</a></p></div>`);
  } else out.push(`<div class="move" id="next-move"><p class="what">Next move</p><p>${esc(ex.ask)}</p></div>`);
  out.push(`<div class="numbers">${pageNumbers(r).map((n) => `<div><div class="label">${esc(n.label)}</div><div class="value">${esc(n.value)}</div><div class="cmp">${esc(n.comparison)}.</div></div>`).join("")}</div>`);
  const comps = r.components;
  const listed = comps.excluded.filter((c) => !c.reason.startsWith("not a component"));
  if (comps.included.length + listed.length > 1) {
    const rows = [...comps.included].sort((a, b) => b.changeShare - a.changeShare);
    const trend = history.length > 1;
    out.push(`<table class="comps"><thead><tr><th>Component</th><th>Level</th><th class="num">Share of changes</th>${trend ? '<th class="hide-narrow">Trend</th>' : ""}<th>What holds it</th></tr></thead><tbody>`);
    for (const c of rows) {
      const level = c.unproven ? "Level 1 unproven here" : levelText(c.level);
      out.push(`<tr><td class="name">${esc(c.id)}${c.active ? "" : ' <span class="muted small">(under 10%)</span>'}</td><td>${miniLadderSvg(c.unproven ? null : c.level)} ${esc(level)}</td><td class="num"><span class="share" aria-hidden="true"><i style="width:${Math.round(c.changeShare * 100)}%"></i></span>${Math.round(c.changeShare * 100)}%</td>${trend ? `<td class="hide-narrow">${sparkSvg(history.map((h) => h.levels[c.id]))}</td>` : ""}<td>${holds(r, c)}</td></tr>`);
    }
    for (const c of listed) {
      const unsupported = /isn't supported yet/.test(c.reason);
      out.push(`<tr><td class="name">${esc(c.id)}</td><td class="none">not assessed</td><td class="num">${Math.round(c.changeShare * 100)}%</td>${trend ? '<td class="hide-narrow"></td>' : ""}<td>${esc(c.reason)}${unsupported ? `.${supportHref(ex.unassessed?.supportDoc ?? null)}` : ""}</td></tr>`);
    }
    out.push(`</tbody></table><p class="legend">Share of changes: the component's share of changed files over the last 90 days.</p>`);
  } else if (ex.unassessed) out.push(`<p class="note"><strong>Not assessed:</strong> ${esc(ex.unassessed.text)}.${supportHref(ex.unassessed.supportDoc)}</p>`);
  if (history.length > 2) out.push(`<div style="margin-top:var(--s-5)">${trendSvg(history.map((h) => ({ date: h.date, level: h.repoLevel, kind: h.kind, result: h.result })))}<p class="legend">Repo level at each audit and recheck, ${esc(fmtShortDate(history[0].date))} to ${esc(fmtShortDate(history[history.length - 1].date))}. A cross marks a failed recheck.</p></div>`);
  out.push(`</section>`);
  return out.join("");
}

function improved(r: ReportJson): string {
  if (!r.progress) return `<section id="improved" class="small"><p class="muted" style="margin:0">This is the first audit, so there is nothing to compare yet. Rerun the audit after your first fix to see what changed here.</p></section>`;
  const out: string[] = [`<section id="improved"><h2>What changed</h2>`];
  const ch = r.progress.changes;
  const dir = (from: Level | null, to: Level | null) => (from === to ? `<span class="none">no change</span>` : from !== null && to !== null && to > from ? `<span class="ok">up</span>` : from !== null && to !== null ? `<span class="bad">down</span>` : `<span class="none">changed</span>`);
  if (ch) {
    out.push(`<ul class="changes">`);
    out.push(`<li><strong>Repo:</strong> ${esc(levelText(ch.repo.from))} to ${esc(levelText(ch.repo.to))}, ${dir(ch.repo.from, ch.repo.to)}, since ${esc(fmtDate(ch.since.date))}</li>`);
    for (const c of ch.components) out.push(`<li><code>${esc(c.id)}</code>: ${esc(levelText(c.from))} to ${esc(levelText(c.to))}, ${dir(c.from, c.to)}</li>`);
    for (const m of ch.nowMet) out.push(`<li><span class="ok">Now met:</span> <code>${esc(m.component)}</code> ${esc(m.label)}</li>`);
    for (const m of ch.nowFailing) out.push(`<li><span class="bad">Now failing:</span> <code>${esc(m.component)}</code> ${esc(m.label)} (${esc(m.reason)})</li>`);
    const word = (ok: boolean | null) => (ok === true ? "passed" : ok === false ? "failed" : "not proven");
    for (const c of ch.checks) out.push(`<li>${esc(c.name)}: ${word(c.from)}, now <span class="${c.to === true ? "ok" : c.to === false ? "bad" : "none"}">${word(c.to)}</span></li>`);
    if (!ch.components.length && !ch.nowMet.length && !ch.nowFailing.length && !ch.checks.length) out.push(`<li class="muted">No component level, condition or check changed.</li>`);
    if (r.progress.closed.length) out.push(`<li><strong>Steps closed:</strong> ${esc(r.progress.closed.map((c) => `${c.title} (${fmtShortDate(c.closed)})`).join("; "))}. <a href="#history">What moved after them</a></li>`);
    out.push(`</ul>`);
  } else out.push(`<p class="muted">The previous audit's sealed report isn't readable here, so only the <a href="#history">levels over time</a> are compared.</p>`);
  return out.concat("</section>").join("");
}

function needle(r: ReportJson): string {
  const ex = r.executive;
  const out: string[] = [`<section id="next"><h2>Next steps</h2><p class="ask"><strong>Recommendation:</strong> ${esc(ex.ask)}</p><p style="max-width:80ch">${esc(ex.nextLine)}</p>`];
  if (r.actions.length) out.push(`<ol class="steps">`);
  r.actions.forEach((a, i) => {
    const gap = ex.gaps.find((g) => g.itemId === a.itemId);
    const n = stepOf(r, a.itemId);
    const item = r.roadmap.items.find((x) => x.id === a.itemId);
    const order = a.startNow ? "can start now" : i === 0 ? "do first" : "then";
    out.push(`<li class="step" id="${anchor(a.itemId)}"><div class="n"><b>Step ${n ?? a.rank}</b>${order}</div><div><h3>${inline(a.title)}${isExperimental(item?.level) ? '<span class="exp">experimental</span>' : ""}</h3>`);
    // A narrated gap can say more than the title; when it is the title, only what it blocks is new.
    if (gap) out.push(`<div class="small muted">${gap.text === a.title.replace(/`/g, "") ? "" : `${esc(gap.text)}. `}${esc(gap.blocks)}.</div>`);
    out.push(`<p class="unlocks">${inline(a.movesTheNeedle)}</p><dl class="facts"><dt>Effort and owner</dt><dd>${inline(a.effortAndOwner)}</dd><dt>Why it matters</dt><dd>${inline(a.why)}</dd>`);
    if (a.decision) out.push(`<dt>Decision</dt><dd>${inline(a.decision)}.</dd>`);
    if (a.dependsOn.length) out.push(`<dt>Depends on</dt><dd>${inline(list(a.dependsOn))}</dd>`);
    if (a.evidence?.length) out.push(`<dt>Evidence</dt><dd>${evLinks(a.evidence)}</dd>`);
    out.push(`<dt>Done when</dt><dd>${inline(a.doneWhen)} <a href="#how-${anchor(a.itemId)}">How to do it</a></dd></dl></div></li>`);
  });
  if (r.actions.length) out.push(`</ol>`);
  const noResults = r.maturity.outcome === "not_assessed";
  if (r.actions.length === 0) out.push(`<p>${esc(r.maturity.assessedComponents === 0 ? "No actions can be planned yet: no component could be assessed, so nothing was checked." : noResults ? "No actions can be planned yet: this audit has no real check results to plan from." : r.maturity.outcome === "blocked" ? `No actions are open: nothing in the repo blocks Level ${r.maturity.level + 1}. Proving it needs a rerun where this machine's limits don't apply, such as CI with Docker or Podman.` : "No actions are open.")}</p>`);
  out.push(`</section>`);
  return out.join("");
}

function roadmap(r: ReportJson): string {
  const here = markedLevel(r);
  const out: string[] = [`<section id="roadmap"><h2>Roadmap to Level 4</h2>`];
  const noResults = r.maturity.outcome === "not_assessed";
  if (noResults && r.roadmap.items.every((i) => i.level === null || i.level === undefined)) {
    out.push(`<p class="muted">No level steps yet: this audit had no real check results to plan from. The steps appear once a component can be assessed.</p>`);
  } else {
    out.push(`<p class="small muted">${r.roadmap.doneCount} of ${r.roadmap.total} steps done. Kept in <code>.agent-readiness/roadmap.json</code>.${r.roadmap.owner ? ` Owner: ${esc(r.roadmap.owner)}.` : ""}</p>`);
    for (const L of [1, 2, 3, 4] as Level[]) {
      const s = r.scale[L];
      const state = here !== null && here >= L ? "reached" : (here ?? -1) + 1 === L ? "next" : "later";
      const needs = L === 1 ? r.details.levelRules.level1 : L === 2 ? r.details.levelRules.level2 : `Level ${L} means: ${s.meaning.charAt(0).toLowerCase()}${s.meaning.slice(1).replace(/\.$/, "")}`;
      const items = groupedSteps(r.roadmap.items.filter((i) => i.level === L));
      out.push(`<div class="lvl ${state}"><div class="tag">${state}${isExperimental(L) ? '<br><span class="exp" style="margin:0">experimental</span>' : ""}</div><div><h3>Level ${L}, ${esc(s.plain)}</h3><div class="small muted">${esc(needs)}.</div>`);
      if (items.length) out.push(`<ul>${items.map((g) => `<li><strong>Step ${g.orders.length > 1 ? `${g.orders[0]} to ${g.orders[g.orders.length - 1]}` : g.orders[0]}${g.done ? ", done" : ""}:</strong> ${inline(g.title)} <span class="status">· unlocks ${inline(g.unlocks)} · ${esc(g.statusText)}</span></li>`).join("")}</ul>`);
      else if (state !== "reached") out.push(`<p class="small muted" style="margin:var(--s-1) 0 0">${state === "next" ? "No step is open for it in the roadmap yet." : "Its steps are added once the level below it is reached."}</p>`);
      out.push(`</div></div>`);
    }
    const every = groupedSteps(r.roadmap.items.filter((i) => i.level === null || i.level === undefined));
    if (every.length) out.push(`<div class="lvl"><div class="tag">every level</div><div><h3>For every level</h3><ul>${every.map((g) => `<li><strong>Step ${g.orders.join(", ")}${g.done ? ", done" : ""}:</strong> ${inline(g.title)} <span class="status">· unlocks ${inline(g.unlocks)} · ${esc(g.statusText)}</span></li>`).join("")}</ul></div></div>`);
  }
  return out.concat("</section>").join("");
}

// Measures, coverage and history: real numbers, but none of them is a next step on its own.
function measures(r: ReportJson): string {
  const ex = r.executive;
  const conf = r.maturity.confidence;
  const out: string[] = [`<h3>Measures</h3><table><tbody>${ex.numbers.map((n) => `<tr><th scope="row" style="width:34%">${esc(n.label)}</th><td style="width:18%"><strong>${esc(n.value)}</strong></td><td>${esc(n.comparison)}.</td></tr>`).join("")}</tbody></table>`];
  out.push(`<p class="small">Confidence: ${esc(conf.level)} (${esc(conf.reasons.join("; "))}).</p><p class="small muted" style="max-width:85ch">${esc(ex.coverage)}</p>`);
  if (r.progress) {
    const hist = r.progress.history;
    const keys = Object.keys(hist[hist.length - 1].levels);
    const cell = (v: Level | null | undefined) => (v === undefined ? "-" : v === null ? "not assessed" : String(v));
    out.push(`<h3 id="history">Levels over time</h3><table><thead><tr><th>Date</th><th>Record</th><th class="num">Repo</th>${keys.map((k) => `<th class="num">${esc(k)}</th>`).join("")}</tr></thead><tbody>`);
    for (const h of hist) out.push(`<tr><td>${esc(fmtShortDate(h.date))}</td><td>${esc(`${h.kind}${h.result === "failed" ? " failed" : ""}${h.note ? `, ${h.note}` : ""}`)}</td><td class="num">${cell(h.repoLevel)}</td>${keys.map((k) => `<td class="num">${cell(h.levels[k])}</td>`).join("")}</tr>`);
    out.push(`</tbody></table><p class="small muted">A failed recheck lowers a level and a later passing recheck restores it. Only an audit can raise a level above the last audit.</p>`);
    if (r.progress.rubricChanges.length) out.push(`<p class="small">Rubric changes: ${esc(r.progress.rubricChanges.map((c) => `${fmtShortDate(c.date)} ${c.from} to ${c.to}`).join("; "))}. A level change at a rubric change can come from the rubric, not the repo.</p>`);
    if (r.progress.closed.length) {
      out.push(`<h3>What each closed step was expected to move, and what moved after it</h3><table><thead><tr><th>Step</th><th style="width:72px">Closed</th><th>Expected</th><th>Observed after</th></tr></thead><tbody>`);
      for (const c of r.progress.closed) out.push(`<tr><td>${esc(c.title)}</td><td>${esc(fmtShortDate(c.closed))}</td><td>${esc(c.expected)}</td><td>${esc(c.observed)}</td></tr>`);
      out.push(`</tbody></table><p class="small muted">Movement after a step closed, not proof that the step caused it. Each step shows its own measure; steps closed in the same audit share the window after it, so a change can't be credited to one of them.</p>`);
    }
    if (r.progress.weakening) out.push(`<p class="small">${esc(r.progress.weakening)}</p>`);
  }
  return out.join("");
}

function details(r: ReportJson): string {
  const out: string[] = [`<section id="details"><h2>Audit details</h2>`, measures(r)];
  for (const s of r.details.steps) {
    const a = r.actions.find((x) => x.itemId === s.itemId);
    out.push(`<h3 id="how-${anchor(s.itemId)}">How to do step ${stepOf(r, s.itemId) ?? ""}: ${inline(s.title)}</h3>`);
    if (a) out.push(`<dl class="facts"><dt>What to watch</dt><dd>${inline(a.watch)}</dd><dt>Done when</dt><dd>${inline(a.doneWhen)}</dd></dl>`);
    out.push(`<ol class="small">${s.steps.map((st) => `<li><strong>${inline(st.title)}.</strong> ${inline(st.detail)}</li>`).join("")}</ol>`);
  }
  out.push(`<h3>Everything we checked, and why</h3><table><thead><tr><th style="width:24%">Check</th><th style="width:38%">Why we check it</th><th style="width:24%">Result</th><th>Evidence</th></tr></thead><tbody>`);
  for (const c of r.details.checks) {
    // A pass over zero items is nothing to check, not a green result.
    const empty = c.counts.passed + c.counts.failed + c.counts.notRun === 0 && /\b0 of 0\b/.test(c.result);
    const cls = empty ? "none" : c.ok === true ? "ok" : c.ok === false ? "bad" : "warn";
    const word = empty ? "nothing to check" : c.ok === true ? "passed" : c.ok === false ? "failed" : "not proven";
    const src = c.sources.map((s) => ` ${esc(s.claim)} ${esc(s.caveat)} (<a href="${esc(s.url)}">source</a>)`).join("");
    out.push(`<tr><td>${esc(c.name)}<br><code class="id">${esc(c.id)}</code></td><td>${esc(c.why)}<span class="small muted">${src}</span></td><td><span class="${cls}"><strong>${word}</strong></span>${empty ? "" : `: ${esc(c.result)}`}</td><td>${evLinks(c.evidence)}</td></tr>`);
  }
  out.push(`</tbody></table><p class="small muted">Not assessed by this rubric version, which is different from unknown: ${esc(list(r.details.notAssessed.map((n) => n.charAt(0).toLowerCase() + n.slice(1))))}.</p>`);
  const comps = r.components;
  const cellLevel = (level: Level | null, couldBe: Level | null, unproven = false) => (level === null ? "not assessed" : unproven ? "Level 1 unproven on this machine (could be 1)" : `${level} ${r.scale[level].name}${couldBe !== null ? ` (could be ${couldBe})` : ""}`);
  out.push(`<h3>Levels by component</h3><p class="small">Repo shape: ${esc(comps.shape === "sampled_monorepo" ? "monorepo, sampled (only the most active supported components are assessed)" : comps.shape)}.</p><table><thead><tr><th>Component</th><th>Path</th><th>Toolchain</th><th class="num" style="width:70px">Share</th><th>Level</th></tr></thead><tbody>`);
  for (const c of comps.included) {
    out.push(`<tr><td><code>${esc(c.id)}</code>${c.active ? "" : " (under 10%)"}</td><td><code>${esc(c.path)}</code></td><td>${esc(c.toolchain)}</td><td class="num">${Math.round(c.changeShare * 100)}%</td><td>${esc(cellLevel(c.level, c.couldBe, c.unproven))}</td></tr>`);
    for (const s of c.scenarios) out.push(`<tr><td><code>${esc(c.id)}</code> › ${esc(s.label)}</td><td></td><td></td><td></td><td>${esc(cellLevel(s.level, s.couldBe, s.unproven))}</td></tr>`);
  }
  for (const c of comps.excluded) out.push(`<tr><td><code>${esc(c.id)}</code></td><td><code>${esc(c.path)}</code></td><td>${esc(c.toolchain)}</td><td class="num">${c.reason.startsWith("not a component") ? "n/a" : `${Math.round(c.changeShare * 100)}%`}</td><td>not assessed: ${esc(c.reason)}</td></tr>`);
  const noResults = r.maturity.outcome === "not_assessed";
  out.push(`</tbody></table><p class="small">Repo level: ${esc(noResults ? "not assessed" : r.maturity.unproven ? "Level 1 unproven on this machine (could be 1)" : `${r.maturity.level} ${r.scale[r.maturity.level].name}`)}. ${esc(r.maturity.rule)}</p>`);
  if (r.maturity.capReasons.length) out.push(`<p class="small">${esc(r.maturity.unproven ? "What keeps Level 1 unproven on this machine:" : `What holds the repo at Level ${r.maturity.level}:`)}</p><ul class="small">${r.maturity.capReasons.map((c) => `<li>${c.component === "*" ? "Repo" : `<code>${esc(c.component)}</code>`}: ${esc(c.label)}, ${esc(c.state === "blocked" ? "blocked on this machine" : c.state === "unknown" ? "not proven" : "not met")} (${esc(c.reason)}).</li>`).join("")}</ul>`);
  out.push(`<p class="small"><strong>Standard level:</strong> ${esc(r.details.levelRules.level1)}. ${esc(r.details.levelRules.level2)}.${r.details.levelRules.scenarios.map((s) => ` <strong>${esc(s.label)} scenario:</strong> ${esc(s.bar)}.`).join("")}</p>`);
  const oc = r.details.outcomes;
  out.push(`<h3>Agent PR outcomes</h3>`);
  if (oc) {
    out.push(`<p class="small">${esc(oc.window)}. Agent PRs are matched by ${esc(oc.filter)}. Source: ${esc(oc.source)}.</p><table><thead><tr><th>Measure</th>${oc.series.map((s) => `<th class="num">${esc(s.label)}</th>`).join("")}</tr></thead><tbody>`);
    const rate = (v: Parameters<typeof describeRate>[0]) => esc(describeRate(v));
    out.push(`<tr><td>Opened</td>${oc.series.map((s) => `<td class="num">${s.opened}</td>`).join("")}</tr>`);
    out.push(`<tr><td>Merged</td>${oc.series.map((s) => `<td class="num">${rate(s.merged)}</td>`).join("")}</tr>`);
    out.push(`<tr><td>Passed CI the first time</td>${oc.series.map((s) => `<td class="num">${rate(s.firstTimeCi)}</td>`).join("")}</tr>`);
    out.push(`<tr><td>Reviewer requested changes</td>${oc.series.map((s) => `<td class="num">${rate(s.changesRequested)}</td>`).join("")}</tr>`);
    out.push(`<tr><td>Median days to merge</td>${oc.series.map((s) => `<td class="num">${s.medianDaysToMerge ?? "n/a"}</td>`).join("")}</tr></tbody></table>`);
    out.push(`<p class="small muted">${esc(oc.multiComponentNote)} ${esc(oc.caveat)} Matched PRs: ${esc(oc.matchedPrs.map((n) => `#${n}`).join(", ") || "none")}.</p>`);
  } else out.push(`<p class="small muted">Not measured: give the audit read access to pull requests (the external-systems tier) and run <code>readiness outcomes</code>.</p>`);
  out.push(`<h3>Agent assets already in the repo</h3>`);
  if (r.details.assets.length) out.push(`<table><thead><tr><th style="width:110px">Asset</th><th>Path</th><th>Authors</th><th style="width:90px">Last changed</th><th>Status</th></tr></thead><tbody>${r.details.assets.map((a) => `<tr><td>${esc(a.kind)}</td><td><code>${esc(a.path)}</code></td><td>${esc(a.authors.join(", ") || "unknown")}</td><td>${esc(a.lastChanged ? fmtShortDate(a.lastChanged) : "n/a")}</td><td>${esc(a.status)}</td></tr>`).join("")}</tbody></table>`);
  if (r.details.missingAssets.length) out.push(`<p class="small">Missing: ${esc(list(r.details.missingAssets))}.</p>`);
  if (r.details.signals.length) out.push(`<h3>Other signals (informational, not scored)</h3><table><thead><tr><th>Signal</th><th style="width:70px">Found</th><th>Detail</th></tr></thead><tbody>${r.details.signals.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.found === null ? "n/a" : s.found ? "yes" : "no"}</td><td>${esc(s.detail)}</td></tr>`).join("")}</tbody></table><p class="small muted">These don't set a level or add a roadmap step.</p>`);
  out.push(`<h3>Evidence log</h3><table><thead><tr><th style="width:64px">ID</th><th style="width:24%">Check</th><th style="width:12%">Component</th><th style="width:24%">What ran</th><th>Result</th></tr></thead><tbody>`);
  for (const e of r.details.evidence) {
    const cls = e.result === "pass" ? "ok" : e.result === "fail" ? "bad" : "warn";
    const ran = e.ran === e.summary ? `<span class="muted">${esc(e.where)}</span>` : `<code>${esc(e.ran)}</code><br><span class="small muted">${esc(e.where)}</span>`;
    out.push(`<tr id="${esc(e.id)}"><td><code class="id">${esc(e.id)}</code></td><td><code class="id">${esc(e.check)}</code></td><td>${esc(e.component ?? "repo")}</td><td>${ran}</td><td><span class="${cls}"><strong>${esc(e.result)}</strong></span>: ${esc(e.summary)}</td></tr>`);
  }
  out.push(`</tbody></table><p class="small muted">Evidence strength, weakest to strongest: stated in docs, read from files, ran on host, ran in a clean container, confirmed by outcomes. A check passes only at its required strength.</p></section>`);
  return out.join("");
}

// Provenance, integrity and eval-mode notes: complete, but nothing here asks the reader to act.
function about(r: ReportJson): string {
  const fromFile = r.details.outcomes !== null && r.details.outcomes.source !== "GitHub through gh";
  const lines: string[] = [];
  if (r.audit.seedPinned) lines.push("Eval run with a pinned seed; not a production result.");
  if (fromFile) lines.push("Outcomes come from a recorded PR file, not GitHub; not a production result.");
  lines.push(`${r.audit.sealStatus}.`);
  if (r.audit.staleCopy) lines.push(r.audit.staleCopy);
  return `<section id="about"><h2>About this report</h2><p class="small" style="max-width:85ch">Audited ${esc(fmtDate(r.audit.date))} at <code>${esc(r.audit.commit)}</code>, audit <code class="id">${esc(r.audit.id)}</code>, rubric ${esc(r.audit.rubric)}, ${esc(r.audit.tier)} tier. ${esc(lines.join(" "))}</p><dl class="facts">${r.details.record.map((x) => `<dt>${esc(x.label)}</dt><dd>${esc(x.value)}</dd>`).join("")}</dl></section>`;
}

export function renderHtml(r: ReportJson): string {
  const notices = (r.notices ?? []).map((n) => `<p class="notice" role="alert"><strong>Action needed:</strong> ${esc(n.text)}</p>`).join("");
  const keyed = !/unkeyed/.test(r.audit.sealStatus);
  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Agent readiness: ${esc(r.repo)}</title><style>${CSS}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style></head>`,
    `<body><input type="checkbox" id="theme" class="theme-switch"><div class="theme"><div class="page"><header><h1>Agent readiness: ${esc(r.repo)}</h1><div class="meta"><span class="when">${esc(fmtDate(r.audit.date))}</span><label for="theme" class="toggle"><span class="knob" aria-hidden="true"></span>Dark mode</label></div></header>${notices}<main>`,
    summary(r),
    improved(r),
    needle(r),
    roadmap(r),
    details(r),
    about(r),
    `</main><footer>Generated from <code>report.json</code> by the agent-readiness skill; <code>report.md</code> holds the same report.${keyed ? "" : " For signed reports, set <code>SA_READINESS_SEAL_KEY</code> from a CI secret where the audit runs."}</footer></div></div></body></html>`,
    "",
  ].join("\n");
}
