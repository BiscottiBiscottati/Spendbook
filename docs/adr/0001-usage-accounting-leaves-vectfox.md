# 1. Usage Accounting Lives in Spendbook, Not in VectFox

Date: 2026-11-13

## Status

Accepted

## Context

VectFox (the retrieval extension this project was extracted from) grew a usage
telemetry feature to **9 core modules and 2 UI files — about 4,551 lines, 5,144
with tests** — inside an extension whose job is retrieval. It accounts for
chat-completion traffic: provider-reported tokens, cached tokens, cost, latency,
origin, coverage, measurement runs and a prefix-breaker heuristic.

It barely touches retrieval. The only observation point is a `window.fetch`
wrapper on `/api/backends/chat-completions/generate`; the ledger, stats, prefix
and export modules are pure and run without storage at all; the panel takes its
file-download and confirm callbacks injected. There is no import from the
vector backends, the vector API or the provider layer anywhere in the feature.
What it did have was reverse coupling — VectFox's own LLM helper called into the
feature to label its requests — plus VectFox vocabulary baked in: a
internal-only origin, a ghost-only configuration snapshot, and a default
price table seeded with VectFox's own model's cost.

Two platform facts decide whether that coupling was worth keeping.
**SillyTavern surfaces no token usage to extensions**: no event carries a usage
object or model id, the only per-message numbers are local tokenizer estimates
behind an off-by-default setting, and ST never sends
`stream_options.include_usage` — so a fetch tap is not a shortcut, it is the only
browser-side place the number exists. And **the host's future
LLM-call-finished event covers only VectFox's own calls**: story
replies, quiet generations and worker jobs are not VectFox's calls, so the
observer stays independent either way. The integration surface would not shrink
by waiting.

Meanwhile the audience is not VectFox's. Any SillyTavern user can use token,
cost and cache-hit accounting whether or not they run a vector backend; shipping
it inside a RAG extension forces each audience to carry the other's manifest,
settings namespace, CSS and tab strip.

## Decision

1. **Usage accounting lives here**, in **Spendbook**, a standalone MIT-licensed
   third-party extension.
2. **Observation stays a `window.fetch` tap** on the chat-completions endpoint,
   parsing JSON and SSE-tail usage. Events cannot replace it: none carry usage.
   The unit stays the call — one usage record per provider request, with
   `story` / `quiet` / `internal` as its origin.
3. **Coupling is a mark, not an import.** A caller labels its own request (an
   `internal` mark travelling with the call); Spendbook honours it and neither
   extension imports the other.
4. **Migration copies, never moves.** Spendbook writes its own namespaces and
   offers an explicit, idempotent import of the host extension's old records and
   settings, leaving the originals in place.
5. **Cut over at parity.** The feature is deleted from the host extension once a
   sandbox run (ordinary, quiet, internal-marked turn) compares ledger rows field
   by field. The host keeps one README pointer; no `dependencies` entry and no
   runtime link in either direction.
6. **v1 stops at the tap.** The host's hosted event, whenever it ships, is a
   documented v2 adapter with the no-double-count rule written down now: when the
   event and a recorded call describe the same request, keep the event's numbers
   and never count both.
7. **Public defaults are honest defaults.** No seeded prices, no chat identifiers
   in exported files unless the user asks, English inline with no stub `i18n`
   map, and `stream_options.include_usage` only behind an opt-in setting because
   it rewrites the provider request.

## Considered Options

- **Keep it inside the host extension.** The status quo, and it keeps one
  settings namespace and one install. Rejected: the audiences diverge, and every
  user of the host would keep carrying ~4.5k lines and a tab for a feature they
  may never open — while every Spendbook user would need a retrieval extension
  installed to measure anything.
- **A sibling mode inside the same folder** (two manifests, one install).
  SillyTavern discovers one extension per manifest and loads one entry module
  per manifest; the platform has no notion of a folder shipping two extensions.
  Rejected as unsupported.
- **Replace the fetch tap with SillyTavern events.** Cleaner in principle, but no
  event carries usage, and quiet generations — which matter for cost — never
  reach `MESSAGE_RECEIVED` at all. Rejected: it would trade measured numbers for
  local estimates.
- **A SillyTavern server plugin** (`src/plugin-loader.js`) to observe upstream
  responses directly. The cleanest seam for true usage, including server-side
  calls. Rejected for v1: server plugins are off by default and require the owner
  to configure ST's server, which removes every user who installs extensions
  through the UI. Revisit if usage accounting ever needs to cover embeddings or
  server-side traffic.
- **Silent automatic import** of the host's old ledger on first start. Rejected:
  a public tool should not rewrite someone's stored data behind their back, and
  explicit import keeps the old data intact for the parity check and for a
  rollback.
- **Ship the current price seed.** Rejected: the host's own model cost would
  print confident, wrong costs on everyone else's install.
- **Write the event adapter now.** Rejected: the event does not exist; designing
  against an imagined payload would invent a contract the host has not promised.

## Consequences

- The host extension loses the usage tab, its settings keys and ~4.5k lines; its
  manifest, panel shell and README shrink with it.
- Spendbook takes over everything the host gave the feature for free: ST-version
  tolerance, update packaging, CI, a public support surface, and the privacy
  stance that records hold hashes and counts but never prompt text.
- The origin vocabulary loses `worker` (routing through a worker profile is a
  connection fact, not an origin) and gains `internal` with a host-supplied
  label.
- Two settings namespaces coexist during the transition, and the old one stays
  readable, so switching back to the host extension's released version does not
  lose its ledger.
- The event adapter stays unwritten until the host event exists; if it never
  ships, nothing breaks and the tap remains the only source.
- Publishing makes compatibility a promise: a broken release is visible in
  strangers' installs, not just the author's sandbox. The mitigation is CI that
  runs the ported test suite, and the parity run before the cutover.

## Provenance

This decision was written while the feature still lived in the host extension,
and is kept here as that repository's ADR-0005; this file is the public-safe
copy, renumbered because this repo's own decisions start at 0001.
