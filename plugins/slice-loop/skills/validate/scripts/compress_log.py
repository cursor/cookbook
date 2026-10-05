#!/usr/bin/env python3
"""Compress a build/test/run log into a reviewable excerpt.

Keeps the head, the tail, and windows around lines that look like failures;
strips ANSI codes, collapses repeated lines, and marks every omission so the
reader knows the excerpt is partial.

Usage: compress_log.py [FILE|-] [--max-lines N] [--context N] [--head N] [--tail N]
"""

from __future__ import annotations

import argparse
import re
import sys

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
SIGNAL = re.compile(
    r"(error|fail(ed|ure)?|exception|traceback|assert|panic|fatal|"
    r"expected|received|not ok|timed? ?out|segfault|denied|refused|"
    r"cannot|unable to|undefined|✗|✘|×|\bE\d{3,}\b)",
    re.IGNORECASE,
)
# Lines kept regardless of budget windows: run summaries and the names of failing tests.
SUMMARY = re.compile(
    r"((?i:\b\d+ (passed|failed|skipped|errors?|warnings?|tests?)\b)|"
    r"^\s*(Tests?:|Test Suites:|Test Files|Ran \d+ tests?|FAILED \(|OK$|OK \()|"
    r"^\s*(not ok \d+|FAIL |FAILED |--- FAIL:|✗|✘|×|●) ?)"
)


def collapse_repeats(lines: list[str]) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(lines):
        j = i
        while j + 1 < len(lines) and lines[j + 1] == lines[i]:
            j += 1
        out.append(lines[i])
        if j > i:
            out.append(f"    [previous line repeated {j - i} more times]")
        i = j + 1
    return out


def pick(lines: list[str], max_lines: int, context: int, head: int, tail: int) -> list[int]:
    n = len(lines)
    must = [i for i, line in enumerate(lines) if SUMMARY.search(line)]
    if len(must) > max_lines // 2:
        must = must[: max_lines // 3] + must[-(max_lines // 6) :]
    keep: set[int] = set(must)

    # Head and tail shrink to fit whatever budget the must-keep lines leave.
    room = max(0, max_lines - len(keep))
    keep |= set(range(min(head, room // 6, n)))
    tail_n = min(tail, room // 3)
    keep |= set(range(n - tail_n, n)) if tail_n else set()

    # Earliest failures are usually the root cause; later ones are often fallout.
    for idx, line in enumerate(lines):
        if idx in keep or not SIGNAL.search(line):
            continue
        window = set(range(max(0, idx - context), min(n, idx + context + 1)))
        if len(keep | window) > max_lines:
            break
        keep |= window
    return sorted(keep)


def render(lines: list[str], kept: list[int]) -> list[str]:
    out: list[str] = []
    prev = -1
    for idx in kept:
        if idx != prev + 1:
            out.append(f"… {idx - prev - 1} lines omitted …")
        out.append(lines[idx])
        prev = idx
    if kept and kept[-1] != len(lines) - 1:
        out.append(f"… {len(lines) - 1 - kept[-1]} lines omitted …")
    return out


def compress(text: str, max_lines: int = 120, context: int = 3, head: int = 10, tail: int = 25) -> str:
    raw = ANSI.sub("", text).replace("\r\n", "\n").replace("\r", "\n").splitlines()
    lines = collapse_repeats([line.rstrip() for line in raw])
    if len(lines) <= max_lines:
        body = lines
    else:
        body = render(lines, pick(lines, max_lines, context, head, tail))
    signals = sum(1 for line in lines if SIGNAL.search(line))
    header = f"# compressed log: {len(raw)} lines in, {len(body)} lines out, {signals} failure-like lines"
    return "\n".join([header, *body]) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("file", nargs="?", default="-")
    parser.add_argument("--max-lines", type=int, default=120)
    parser.add_argument("--context", type=int, default=3)
    parser.add_argument("--head", type=int, default=10)
    parser.add_argument("--tail", type=int, default=25)
    args = parser.parse_args()

    if args.file == "-":
        text = sys.stdin.read()
    else:
        with open(args.file, encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    sys.stdout.write(compress(text, args.max_lines, args.context, args.head, args.tail))
    return 0


if __name__ == "__main__":
    sys.exit(main())
