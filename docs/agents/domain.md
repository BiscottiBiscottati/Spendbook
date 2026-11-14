# Domain Docs — Spendbook

How the engineering skills should consume this repository's domain
documentation when exploring the code.

## Before exploring, read these

- **`docs/adr/`** — decisions that touch the area you are about to change. ADR
  0001 is the reason this extension exists on its own.
- **`AGENTS.md`** — the module layout and the invariants. A change that breaks an
  invariant is a bug even if the tests pass.
- **The drawer's "How to read these numbers"** in `settings.html` — the
  user-facing definition of every figure, and the contract the code must keep.

If a referenced file does not exist, proceed silently. Don't flag its absence.

## Layout

Single-context repository:

```
/
├── AGENTS.md
├── docs/
│   ├── adr/            ← decisions that survived an argument
│   └── agents/         ← this directory
├── src/  ui/  styles/  tests/
└── manifest.json
```

There is no `GLOSSARY.md` yet. The vocabulary below is the one the code, the
drawer and the README use; write a glossary when a term needs more than the line
it gets here. A term used in an issue title, a test name or a comment should be
the term below, not a synonym.

## Vocabulary

- **Usage record** — one row, one provider request. The unit of the ledger; never
  a message, never a turn.
- **Origin** — what caused the request: `story` (the chat's reply), `quiet` (a
  generation whose result is handed back to its caller), `internal` (a call an
  extension made for its own work, ideally labelled by its internal mark).
- **Internal mark** — the `Symbol.for('spendbook.internal-request')` property a
  caller puts on its own request `init`; one of the two host contracts.
- **Configuration label** — the free-form label a host sets for the requests it
  drives; page-lifetime, never persisted, `default` when nobody set one. The
  other host contract.
- **Measured / estimated / unavailable** — where a number came from: the
  provider's usage object, SillyTavern's tokenizer, or nowhere. Estimated figures
  render with a tilde; unavailable ones as `—`, never `0`.
- **Coverage** — the share of prompt tokens the provider actually reported.
- **Run** (measurement run) — a marked window with an optional label; rows
  captured inside it can be filtered to it.
- **Hit rate** — cached prompt tokens over reported prompt tokens, token-weighted
  across the selected rows.
- **Retention cap** — the newest 500 rows kept per chat. Older rows are
  **folded**: their tokens, counts and dollars survive as counters (the
  **archive**), their individual rows do not.
- **Prefix fingerprint** — per-message hash and estimated token count, compared
  positionally against the previous comparable request. The last baseline per
  provider, model and origin is persisted beside the chat's ledger as hashes and
  counts only; the request's own fingerprint is transient and no record holds
  it.
- **Prefix breaker** — a request sharing at least 2,048 estimated tokens with its
  comparable predecessor while reporting zero cached tokens. A suspicion, not a
  measured cause.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than
silently overriding:

> _Contradicts ADR-0001 (usage accounting ships on its own), but worth reopening
> because…_

## Confirm platform facts from the source

SillyTavern's extension API is the platform this code runs on, and its behavior
changes between releases. Before claiming what ST does — which event fires, what
`chat_metadata` holds, how settings are loaded — read SillyTavern's own source at
the version the extension targets (1.19+): `public/script.js`,
`public/scripts/extensions.js`, `src/`. Cite the file in the ticket or ADR that
depends on it.
