# Spendbook — agent conventions

Spendbook is a standalone, public, MIT SillyTavern extension that keeps a usage
ledger for chat-completion traffic. This file is the working agreement for
sessions in this repository: it says where things live, what the invariants are,
and which commands prove a change. It is public — keep it free of any private
workspace, host, port, service or seeded-data detail.

## Architecture in one paragraph

`index.js` wires the extension: it reads settings with defaults merged, opens the
chat's ledger, installs the read-only observer while tracking is on, mounts the
drawer and binds SillyTavern's events and slash commands. `src/` holds the model
and is where behavior belongs — ledger, observer, origin, stats, prices, prefix,
configuration, export, importer, estimator, message, ids, settings, host surface.
`ui/` is the DOM layer and adapts `ui/view.js` (pure view models) onto the drawer
and the price editor. There is no build step, no bundler and no runtime
dependency: the repository contents are what SillyTavern loads.

| Path              | Role                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `manifest.json`   | ST manifest: entry `index.js`, CSS, version, `auto_update: true`     |
| `index.js`        | Entry: settings, ledger, observer, drawer, events, commands, host API |
| `src/ledger.js`   | The only owner of persisted usage state                               |
| `src/observer.js` | The `fetch` tap; read-only, JSON and SSE-tail usage                   |
| `src/origin.js`   | Origin attribution and the internal mark                              |
| `src/host.js`     | `globalThis.Spendbook`, the only published host surface               |
| `src/configuration.js` | The configuration label's shape and page-lifetime value          |
| `src/export.js`   | The published export projection — the privacy boundary               |
| `src/importer.js` | Explicit, idempotent import of this chat's old VectFox usage          |
| `src/stats.js`, `src/prices.js` | Pure summaries and the price table's shape and cost resolution |
| `src/prefix.js`, `src/estimator.js`, `src/message.js`, `src/ids.js` | Pure helpers: fingerprint, tokenizer estimates, text extraction, ids |
| `src/settings.js`, `src/commands.js` | Settings read/write with merged defaults; the slash commands  |
| `ui/`             | DOM panel, price editor, download, pure view models                   |
| `settings.html`   | Drawer template rendered with ST's `renderExtensionTemplateAsync`     |
| `styles/`         | The extension's CSS, `spendbook-` prefixed                             |
| `tests/`          | Vitest suites: per module, pipeline, drawer (jsdom) and manifest       |
| `docs/adr/`       | Decisions; `docs/agents/` is this directory                           |

## Invariants

Breaking one of these is a bug, not a style choice.

- **No runtime dependency, no build step.** Dev dependencies only (vitest,
  jsdom). Anything shipped is committed.
- **Never store prompt text.** Records carry counts, ids and hashes; the chat
  stores the prefix baseline as per-message hashes and token counts, never text,
  and a row keeps only the shared count and the breaker flag. No request bodies,
  headers or keys are stored.
- **No provider calls and no network of our own.** The observer reads responses
  the browser already received; it must return the caller's response untouched
  and never modify a request.
- **Cost only from the user's price table**, plus a cost or discount the provider
  reported. No seeded prices, no lookups, no currency conversion.
- **The export is a projection.** `src/export.js` owns the field list, so a new
  record field cannot leak into a bug-report file by default. No chat id, prompt
  text, request body or key has a field there.
- **Namespaces name the extension.** `spendbook_usage` in chat metadata,
  `spendbook_usage_*` in local storage, `extension_settings.spendbook`. A rename
  is a breaking change; `chat_metadata` is shared with every other extension.
- **One-way host coupling.** Other extensions reach Spendbook only through
  `globalThis.Spendbook` — the internal mark and the configuration label. There
  is no import in either direction, and Spendbook never reads another
  extension's settings.
- **Confirm SillyTavern APIs against its source**, not memory: `public/script.js`,
  `public/scripts/extensions.js`, `src/`. The extension targets ST 1.19+.
- **English strings inline.** No `i18n` map and no translation indirection.

## Checks

```bash
npm ci          # dev dependencies only
npm run check   # parse-check every shipped JS file
npm test        # vitest, whole suite
npx vitest run tests/ledger.test.js   # one file while working
```

CI runs `npm run check` and `npm test` on every push and pull request
(`.github/workflows/ci.yml`). The suite must pass before a version bump. There is
no browser end-to-end test in the repo — jsdom stops at the panel's DOM. A real
turn is proven in a SillyTavern sandbox, and that evidence belongs in the pull
request, not in a committed fixture.

## Tests

- One suite per module that has behavior of its own, named after it
  (`src/export.js` → `tests/export.test.js`). `tests/pipeline.test.js` covers the
  entry wiring, `tests/drawer.test.js` the panel under jsdom, and
  `tests/manifest.test.js` the manifest and the release number. The observer has
  no suite of its own: its capture paths are proven end to end in
  `tests/pipeline.test.js`. A pure helper without its own suite (`src/ids.js`) is
  exercised through its callers.
- Prefer testing the module seam: modules take their host dependencies injected
  (clock, storage, fetch target, metadata) so a test needs no SillyTavern.
- A privacy or persistence rule in `## Invariants` gets a test that would fail if
  someone relaxed it.

## Issue tracker

Issues and specs live as local markdown under `.scratch/`, which is gitignored
and kept out of the published repository. See `docs/agents/issue-tracker.md`.

## Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

## Domain docs

Read `docs/adr/` for decisions that touch the area you change, and use the
vocabulary in `docs/agents/domain.md`. See that file for layout and the
conflict rule.

## Commits and releases

- Conventional Commits subjects (`feat:`, `fix:`, `docs:`, `test:`, `chore:`),
  scoped by module where it helps (`feat(export): …`). The subject says what
  changed; the body is for the non-obvious why. This history is public.
- One behavior change per commit; a version bump and its `CHANGELOG.md` entry go
  in the same commit as the last change of the release.
- Semver in `manifest.json` and `package.json` agrees, and `CHANGELOG.md` records
  every released version. SillyTavern updates git-based (`auto_update: true`
  pulls the default branch), so the number is for humans and changelogs, not the
  update mechanism.
