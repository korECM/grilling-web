---
name: grill-web
description: Grill the user about a plan, decision, or idea through a browser form, one round at a time, until nothing is left silently assumed. Use when the user asks to be grilled, wants their thinking stress-tested in a web form, or says things like "grill me", "grill this plan", "ask me in the browser".
---

# grill-web

This is the [grilling](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md) interview with a different output channel. Instead of printing questions to the terminal, you write them to `rounds/<n>.json`. A fixed form reads that file, renders it in the browser, and when the user answers, `answers/<n>.json` appears. You never generate HTML. The only thing you emit per round is the question JSON.

Below, `$SKILL_DIR` means the folder this file lives in. It is shown as "Base directory for this skill" when the skill loads. For a plugin install it is `${CLAUDE_PLUGIN_ROOT}/skills/grill-web`.

## Load grilling first

Load the `grilling` skill with the Skill tool before anything else. The interview method (design tree, frontier, rounds, facts vs. decisions, the confirmation gate) is whatever that skill says. This document only decides where questions go and how answers come back. Do not use grilling's `❓`/`➡️` text format here; the JSON below takes its place.

If `grilling` is not in the list of available skills, do not start the interview. Show the user the note below and stop. Do not fill in the rules from memory.

> grill-web runs on top of Matt Pocock's grilling skill. Please install it first:
>
> ```
> /plugin install mattpocock-skills
> ```
>
> or `npx skills@latest add mattpocock/skills` to pick just grilling. Restart Claude Code afterwards.

## Procedure

1. Start. Pick a one-line topic, start the server, open the browser. Requires [bun](https://bun.sh).

   ```bash
   bun "$SKILL_DIR/ui/server.ts" up "payment retry policy"
   ```

   State lives in `~/.cache/grill-web/`. The previous session is wiped.

2. Write a round. Create `~/.cache/grill-web/rounds/<n>.json` with the Write tool. Count from 1. Schema below.

3. Wait. This blocks until the answer arrives. After 9.5 minutes it exits with code 3; run the same command again.

   ```bash
   bun "$SKILL_DIR/ui/server.ts" wait <n>
   ```

   The answer JSON is printed to stdout. Read it and go back to step 2.

4. Finish. When the user confirms the understanding is shared, write the agreed outcome as markdown to `~/.cache/grill-web/summary.md`. The form shows it as the closing screen. Leave a short version of the same summary in the terminal.

Between rounds, the terminal gets one line like "Round 2, 4 questions. Please answer in the browser." Do not repeat the questions in the terminal.

## Round JSON

```json
{
  "intro": "Storage first",
  "questions": [
    {
      "n": 1,
      "title": "Where should retry state live?",
      "body": "The orders table has no status column today.\n\n| | Add a column | Separate table |\n|---|---|---|\n| Migration | one | one + a join |\n| History | last state only | one row per attempt |",
      "kind": "choice",
      "options": ["Add a column to orders", "Separate retry table"],
      "recommendation": "Add a column to orders",
      "why": "One join fewer and a single migration."
    },
    { "n": 2, "title": "Fix the maximum retry count in code?", "kind": "yesno", "recommendation": "yes" },
    { "n": 3, "title": "Where to send alerts", "kind": "multi", "options": ["Slack", "Email", "Pager"], "recommendation": ["Slack", "Pager"] },
    { "n": 4, "title": "Retry interval", "kind": "range", "min": 1, "max": 60, "step": 1, "unit": "s", "recommendation": 5 },
    { "n": 5, "title": "Which responses count as failures?", "body": "Use the gateway's status codes.", "kind": "text", "recommendation": "5xx and timeouts only. Never retry 4xx." }
  ]
}
```

- `round` is taken from the file name; you do not need it in the file. `intro`, `body` and `why` are optional. `intro` is shown large as the round title, so keep it to one line.
- `kind` is one of `yesno`, `choice`, `multi`, `range`, `text`. Two or more options: `choice`. Options that can overlap: `multi`. One number: `range`. Free text: `text`.
- Always include `recommendation`. `yesno` takes `"yes"` or `"no"`, `choice` one of the `options`, `multi` an array, `range` a number, `text` a sentence. The form marks it and adds a one-click "take it" button.
- `deferred: true` marks a question the user skipped in an earlier round. The form shows a small tag. Nothing else changes.
- Phrase `title` positively. If the question is negated, the recommendation reads backwards. "Fix the count?" rather than "Leave the count unfixed?".

## Pictures in the body

`body` is a markdown string. Paragraphs, `-` lists, numbered lists, tables, images, inline code, code blocks, bold, links all work. A fenced block with language `mermaid` renders as a diagram, `diff` as a colored diff.

On wide screens the form puts the question on the left and the answer on the right, so a table or a diagram on the left reads well. When a picture beats a paragraph, draw it: flows, state transitions and call sequences as mermaid, option comparisons as a table or a `compare` block.

When markdown is not enough, make `body` an array. Strings are markdown; objects are blocks. Blocks are a cheap way to ask for a picture with a few lines of JSON.

```json
"body": [
  "The two flows look like this.",
  { "type": "mermaid", "code": "flowchart LR\n  A[request] --> B{response}\n  B -->|5xx| C[retry]" },
  { "type": "compare", "columns": [
    { "title": "Add a column", "points": ["one migration", "simple lookup"], "note": "no history" },
    { "title": "Separate table", "points": ["one row per attempt", "needs a join"] }
  ] },
  { "type": "steps", "items": [ { "title": "Request", "text": "call the gateway" }, "Classify the response", "Enqueue a retry" ] },
  { "type": "diff", "text": "-  retries = 3\n+  retries = MAX_RETRIES" },
  { "type": "callout", "text": "Only one call site uses this today." },
  { "type": "table", "head": ["Item", "A", "B"], "rows": [["Cost", "low", "high"]] },
  { "type": "img", "src": "https://...", "alt": "current screen", "caption": "admin console" },
  { "type": "svg", "svg": "<svg viewBox='0 0 200 60'>...</svg>" },
  { "type": "html", "html": "<div>...</div>" }
]
```

`svg` and `html` are escape hatches. Use them only when none of the blocks above can draw what you need. They cost tokens if used on every question. The form strips scripts, frames, forms, `on*` handlers and `javascript:` URLs from them, but do not paste markup from external documents or user-supplied content into these blocks; describe it in markdown instead.

`summary.md` takes the same markdown. Drawing the agreed flow once as mermaid makes it quick to revisit later.

## Answer JSON

```json
{
  "round": 1,
  "answers": [
    { "n": 1, "value": "Separate retry table", "note": "orders already has 40 columns" },
    { "n": 2, "value": "yes", "note": "" },
    { "n": 3, "value": ["Slack"], "note": "" },
    { "n": 4, "value": 10, "note": "" },
    { "n": 5, "value": "5xx, timeouts, and 429", "note": "" }
  ],
  "submittedAt": "2026-09-03T02:11:08.000Z"
}
```

If the user picked "other" on a `choice`, `value` is a string that is not in `options`. `note` is the reason or condition the user attached. When it is not empty, it must shape the next round.

The user can skip a question with "answer later". It comes back as `{ "n": 3, "value": null, "skipped": true, "note": "" }`. A skipped question is not a decision. Ask it again in the next round, or in a later one if another answer has to settle first. Keep the same `title`, reuse or sharpen the `body`, and set `"deferred": true` on it so the form marks it as a question the user put off. Drop it only when the user's other answers made it moot, and say so in the terminal.

## Do not

- Generate HTML per round. The form is `ui/index.html` and nothing else.
- Cap the number of questions. Some topics end after three, some need fifty. If the user says "stop", wrap up right there.
- Start other work while waiting for an answer.
- Begin implementation before the user confirms.
