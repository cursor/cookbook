# Product

## Register

product

## Users

Engineering directors, leads and platform owners who decide whether to hand a repository's work to coding agents, and the developers who fix what blocks them. They read the readiness report after an audit, often to share it in planning. A director gives it about 30 seconds; a developer drills into the evidence behind each finding.

## Product Purpose

The agent-readiness report is a lighthouse. In 30 seconds a customer should know where the repository stands, whether it has improved since the last audit, and the single next proven step with what it unlocks. Everything after that first screen exists so a developer can check each claim against the evidence the audit recorded and act on it. Success is a reader who acts on the next step without having to reread the page.

## Brand Personality

Precise, candid, calm. The report says exactly what the audit proved and what it couldn't, in plain words, without hedging stacked on hedging. It is quiet by default so the one important thing stands out.

References, and patterns inspired by each:

- Stripe's docs and dashboard: dense information that still feels calm, exact tables, and restrained color used only for meaning.
- Linear: a confident type hierarchy, generous but deliberate spacing, and a quiet interface that lets the one important thing stand out.
- GitHub's Primer, as the developer-familiar baseline: accessible contrast and clear status semantics.

## Anti-references

- Generic gradients, emoji, uniform card grids, filler copy and over-rounded everything.
- SaaS hero-metric dashboards: a big number, a small label and a gradient accent.
- Badge soup, "AI sparkle" iconography, pastel chart junk and decorative illustrations.
- Anything that implies more precision than the data has, such as a big percentage with no n.

## Design Principles

1. Lead with the next proven step. The first screen answers where am I, have I improved, and what do I do next, before any method or provenance.
2. Say only what the evidence holds. Every number carries its n and window, every claim links to its evidence, and what isn't proven is stated as plainly as what is.
3. Color means something or it isn't there. Status is carried by words and shape first; color only reinforces it.
4. One report, layered by reader. The director stops after the first screen, the lead reads the steps and the roadmap, and the developer opens the evidence.
5. Quiet by default. Restraint in type, color and chrome, so hierarchy does the work.

## No emoji

No emoji anywhere: not in `report.html`, `report.md`, the agent's narration and replies, the CLI output or the examples. Status is a word ("passed", "blocked on this machine", "recheck failed") or an SVG shape (a filled or hollow ladder stop, a cross on the trend). The seal refuses narration that contains an emoji, and a unit test fails if any rendered report, example or skill file contains an emoji codepoint.

## Accessibility & Inclusion

WCAG 2.2 AA in both light and dark mode, with no signal carried by color alone. The report opens in light mode whatever the OS setting; a small CSS-only switch in the header (no script) turns on dark mode, and the report always prints in light. It prints cleanly, respects reduced motion, and stays readable as a single offline HTML file that uses system fonts only.
