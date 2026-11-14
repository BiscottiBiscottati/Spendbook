# Changelog

All notable changes to Spendbook are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version in this
file and the version in `manifest.json` are kept in step: SillyTavern displays the
manifest version, and updates are git-based, so a release is a bump plus an entry
here.

## [Unreleased]

## [1.0.0] - 2026-11-14

First release: usage accounting as a standalone extension, no vector backend and
no other extension required.

### Added

- A drawer in SillyTavern's Extensions settings panel with the per-chat ledger,
  the all-time line, and a privacy note. Tracking is off until you turn it on.
- A read-only observer on the chat-completions endpoint: one usage record per
  provider request, from the JSON usage object, from the usage carried in an SSE
  reply's tail, and a row for a request that failed or answered non-2xx.
- Measured, estimated and unavailable numbers, kept distinct: provider-reported
  counts as measured, SillyTavern's tokenizer as a tilde-marked estimate when the
  provider reports nothing, and `—` when neither exists. A cache hit is never
  estimated.
- Origin attribution for every row — `story`, `quiet`, or `internal` with a
  caller-supplied label — resolved when the request is sent.
- A token-weighted cache-hit rate and a coverage figure, plus summary cards
  overall and per origin.
- Retention: the newest 500 rows per chat, with older rows folded into counters
  that keep tokens, request counts and dollars.
- A price table you fill in yourself (per million tokens, per provider and
  model), with provider-reported cost and cache discounts shown as reported.
  Cost is blank until you enter a price; no table ships seeded.
- Measurement runs: start one, label it, filter the table to it, and compare.
- Configuration comparison: a table per configuration label a host set, with
  requests, tokens, cost and hit rate. Unlabelled requests compare as `default`.
- Prefix-breaker detection: a flag for a request that shared at least 2,048
  estimated tokens with its comparable predecessor yet reported zero cached
  tokens.
- A versioned JSON export for a bug report — records, runs, folded-row counters
  and all-time totals — carrying no chat identifier, prompt text or request body.
  The open chat's name is added only when you opt in, and never the chat file
  name.
- An explicit, idempotent import of this chat's VectFox usage and price table,
  leaving the original data untouched.
- Slash commands: `/spendbook`, `/spendbook-run` and `/spendbook-export`.
- A documented host surface for other extensions: the
  `Symbol.for('spendbook.internal-request')` mark and the configuration label,
  both reachable through `globalThis.Spendbook`, with no import in either
  direction.
- CI running the vitest suite and a parse check on every push and pull request.

[Unreleased]: https://github.com/BiscottiBiscottati/Spendbook/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/BiscottiBiscottati/Spendbook/releases/tag/v1.0.0
