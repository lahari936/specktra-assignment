# Decisions

## Data model

One record per lab environment, held in memory and seeded from a fixed seed (42) so every run starts from the same snapshot, 72 minutes into a 3-hour session.

- **Identity:** `id` (`lab-001`…), learner, region, SKU and its `ratePerHour`.
- **Lifecycle:** `state` (`provisioning | ready | in_use | failed | deprovisioned`), `stateSince`, `attempts`, `failure {code, message}`.
- **Progress:** `step` (1–8), `stepStartedAt`, `stepDurations[]` (time spent on each finished step), `completedAt`.
- **Billing:** `billedMs` (closed billable segments), `billingSince` (open segment), `failedBilledMs` (time billed while failed).

The session holds 8 steps with an expected duration each. Pace is derived from that, never stored: **slow** at 1.5× expected time on the step, **stuck** at 2×. Every derived field (pace, spend, progress, triage score, time here) is computed per request from timestamps, so nothing can drift out of sync.

An activity log records every transition, whether the simulator or an instructor action caused it.

## Why the logic is on the server

- **One source of truth for money.** Spend is `rate × billable runtime`, where billable means provisioning, ready, in_use and failed (Azure keeps charging a failed deployment until it is deleted). Burn rate, idle burn (ready + failed), money wasted on failed environments and projected end-of-session spend all come from the same segments. If the browser did this math, two open tabs could show two totals.
- **Filtering and sorting stay correct as the data grows.** The client never receives rows it then hides. The triage sort (failed, then stuck, then slow provisioning, then slow, then idle ready) is a server rule that can be tested.
- **One validator for every filter.** The query string, the UI controls and the AI compiler all pass through `sanitizeFilter()`. Unknown fields are dropped and values are clamped or checked against fixed vocabularies.
- **Mutations are checked where the state lives.** Reprovision only moves `failed` to `provisioning`, increments `attempts`, opens a new billing segment and writes an event. Other states are reported back per id. The next poll shows the change.
- **Drift is real.** A 2-second timer applies per-minute hazard rates (provisioning to ready or failed, ready to in_use, step advances based on a hidden per-learner pace, completion, teardown). Rates are per minute, so the behaviour doesn't depend on the tick length.

## How the AI feature fails safely

The feature is a plain-language filter. The model only translates the question into a filter object. It never sees learner data and never returns rows.

1. The prompt lists the real fields, steps, failure codes and regions. The request uses structured output (a JSON schema with `additionalProperties: false` and enums).
2. Whatever comes back still goes through `sanitizeFilter()`, the same function the query string uses. A hallucinated state, step 99 or an unknown field is dropped (there is a test for this).
3. With no key, a timeout (8 s, no retries), auth or rate-limit errors, a refusal or malformed JSON, the server falls back to a deterministic keyword parser and says so in the UI (for example "Model timed out: used keyword rules"). The response marks `source: "model"` or `"rules"`.
4. The result is shown as removable chips, the same chips the manual controls create, so the instructor can see and correct what the question turned into.
5. It is never the only way in. State bar, funnel, pace, step and region selectors, search, sort headers and keyboard shortcuts cover everything the Ask box can express.

## Interface choices

- **The room as the signature.** 120 seats in a 15 × 8 grid in fixed lab-number order. A sorted list reshuffles every poll; a seat map doesn't, so the instructor learns positions and spots new trouble by place. Each seat shows state by fill and border style plus a glyph (step number, ×, ✓), never by colour alone.
- **Type and palette.** Cool fog paper and navy ink, nothing warm or neon. Big Shoulders Display (a wallboard face) only for the title, section titles, headline numbers and seat glyphs. Atkinson Hyperlegible for everything else because it was designed for fast, low-error reading. Spline Sans Mono for lab ids and error codes.
- **No stat-card grid.** The summary is one ledger row with hairline dividers, and the two numbers that need action (failed, need help) are buttons that filter the table.
- **Colour means status.** In-use and on-pace rows are neutral. Red is failed, amber is stuck or slow, blue is provisioning, green is ready. Every status also has a shape (filled square with a cross, dashed ring, ring, dot, dash) and a text label, and stuck or slow rows also carry a `STUCK`/`SLOW` tag.
- **Numbers align.** Tabular figures throughout, right-aligned time and money columns, and time shown against the expected time (`43m /12m`).
- **Motion only for change.** A row flashes once when its state or step changes, and a summary count flashes when it changes. Spend ticks every poll, so it does not flash. `prefers-reduced-motion` turns all of it off.
- **Failure states are honest.** Before the first load: skeleton rows. Error before any data: a full error panel with retry. Error after data: the data stays on screen with a banner saying how old it is, and polling backs off from 3 s up to 30 s.

## What's next

- Persist to SQLite or Postgres and push changes over SSE instead of polling every 3 s.
- A real Azure adapter (Resource Graph for state, Cost Management for spend) behind the same `workshop.js` interface.
- An undo window and an audit trail per instructor for bulk reprovision.
- Per-step stuck thresholds learned from earlier cohorts instead of fixed 1.5× and 2× multipliers.
- An "at-risk" summary as a second AI feature, built on the same validate-then-fallback pattern.
- Virtualise the table if a session goes beyond about 500 rows.
