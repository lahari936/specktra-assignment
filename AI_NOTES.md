# Notes on AI assistance

> Edit this file so it describes your own process before you submit. The entries below record what happened while the project was built with Claude Code.

## Where an AI assistant was used

- **Scaffolding and first drafts** of the server (`node:http` routes, seeded generator, drift simulator), the client renderer and the CSS tokens.
- **The keyword fallback parser** and its test cases.
- **Copy for the README and DECISIONS** from bullet-point notes.
- **Running the app in a browser** to check each UI state (loading, error, empty, dense, dark mode) and taking the screenshots.

## Where the generic output was rejected or changed

- **Layout.** The default suggestion for "dashboard" is a row of KPI cards plus a chart. Replaced with a single ledger row, a state bar and a per-step funnel, because the instructor's question is "where are people piling up", not "what is the trend".
- **Status colour.** An early pass coloured every state, including in-use. Changed so normal rows are neutral grey and colour only marks something to act on.
- **A striped (gradient) pattern on the provisioning segment** was removed. The brief rules out gradients, and the legend already carries the label.
- **A pulsing "live" dot** that animated on every poll was removed. Motion is kept for changes only.
- **The spend number flashed on every poll** because it changes continuously. Flashing is now limited to discrete counts (active, failed, need help).
- **Seed data** first came out with 70 of 120 learners already finished and almost nobody stuck, which made the dashboard look calm and useless. Step times and session elapsed time were re-tuned, and a realistic tail of slow learners was added, so the first screen has failures, stuck learners and a visible bottleneck.
- **"Time on step" was empty for failed and provisioning rows**, so a filter like "provisioning longer than 10 min" matched nothing. Replaced with a single "time here" timer (time on step while working, time in state otherwise) used by both the filter and the sort.
- **The detail panel went stale** after reprovisioning a row that the current filter then hid. It now fetches that row separately so the panel keeps updating.
- **The AI feature was kept narrow on purpose.** The model only compiles a filter, its output is validated by the same code as the query string, and a deterministic parser takes over when the model is unavailable.
