# Spendbook

Token, cost and cache accounting for SillyTavern chats. Spendbook watches the
chat-completion requests this browser sends, keeps a usage ledger per chat and
across chats, and shows it in one drawer in the Extensions settings panel — so
you can see what a chat costs, and whether prompt caching is doing what you
expect.

It is a standalone extension: no vector backend, no other extension, no server
plugin, no build step and no runtime dependency. Tracking is **off by default**;
nothing is observed until you turn it on.

**Version 1.0.0** — changes are recorded in [CHANGELOG.md](CHANGELOG.md). The
decision to ship usage accounting on its own is in
[docs/adr/0001](docs/adr/0001-usage-accounting-leaves-vectfox.md).

## Install

Requires SillyTavern 1.19 or newer.

1. SillyTavern → **Extensions** → **Install extension**.
2. Paste this repository's URL.
3. Open the drawer under **Extensions settings → Spendbook** and tick **Track
   token usage**.

There is no package manager, no build output and nothing to configure on the
server. Uninstalling is SillyTavern's usual uninstall; your recorded usage stays
in the chat files and browser storage described below.

## What it does

- **Per-chat and all-time ledger.** One row per provider request: prompt, cached
  and completion tokens, reasoning tokens where the provider reports them, cost,
  latency, and the outcome. The all-time line counts tokens across chats; cost is
  per chat.
- **Streamed replies too.** The usage carried in the tail of an SSE reply is
  parsed, as well as the usage object of a non-streamed JSON response.
- **Measured, estimated, unavailable.** A number the provider reported is
  *measured*. When a provider reports no usage, the prompt is counted with
  SillyTavern's tokenizer and marked with a tilde. Where neither is available the
  figure is shown as `—`, never as `0`, so a request that reported nothing cannot
  look free. A cache hit is never estimated.
- **Cost only where you priced it.** Prices are per million tokens and apply only
  to a provider and model you entered. A cost or cache discount the provider
  itself reported is shown as reported and never recomputed; OpenRouter credits
  are not converted. There are no seeded prices: until you add a row, cost is
  blank.
- **Hit rate and coverage.** The hit rate is token-weighted — cached prompt tokens
  over the prompt tokens reported for those same requests — and coverage is the
  share of prompt tokens the provider actually reported. A request with no cache
  count is left out of the ratio instead of being counted as a miss.
- **Measurement runs.** Start a run before you change a setting, then filter to
  it: requests sent inside the window are bucketed under its label, and requests
  sent before the first run stay under all runs.
- **Configuration comparison.** A host extension can label the requests it drives;
  a table compares requests, tokens, cost and hit rate per label. Rows sent with
  no label are compared as `default`.
- **Prefix-breaker flag.** A request that shares at least 2,048 estimated tokens
  with the previous comparable request yet reports zero cached tokens is flagged:
  something before the cache boundary changed the prompt, or the provider dropped
  the cache. It is a suspicion, not a measurement of the cause.
- **Export and import.** One versioned JSON file for a bug report, and an
  explicit one-shot import of this chat's VectFox usage.
- **Slash commands.** `/spendbook` (tracking state, health, summaries, current
  run), `/spendbook-run` (start a run in the open chat), `/spendbook-export` (the
  same download as the button, always without the chat name).

The newest 500 rows per chat are kept. Older rows are folded into counters that
keep the tokens, request counts and dollars, so totals stay honest while the
table stays fast; the drawer says when rows have been folded.

## What is recorded, and where

Per successful request the record holds counts and identifiers only: timestamp,
chat id, run id, origin and its label, configuration label, provider, model,
response id, whether it streamed, outcome and HTTP status, latency, message
count, the token counts above, cost and cache discount, whether the numbers were
measured or estimated, the shared-prefix token count, and the prefix-breaker
flag. A rejected or non-2xx request keeps a row with its status and latency, and
no token numbers.

Records stay on your machine, in your own files:

- **The chat file** — this chat's ledger is stored in the chat's own metadata
  under `spendbook_usage`, so it travels with the chat and is removed when the
  chat is deleted. Renaming the chat keeps it.
- **Browser local storage** — the all-time totals under `spendbook_usage_*`.
- **Extension settings** — `extension_settings.spendbook`: the tracking toggle,
  your price table and the export opt-in. Nothing else is stored as a setting.

Nothing leaves the browser. Spendbook makes no requests of its own: it reads the
responses your SillyTavern already fetches.

## What it deliberately does not record

- **Prompt text.** For the prefix comparison the request messages are reduced, in
  memory, to one hash and one token count per message, and the text is dropped;
  the fingerprint is never stored. No record, export or drawer shows prompt
  content.
- **Request bodies, headers, API keys or response bodies.** The observer reads
  the usage numbers out of a response and leaves your response untouched.
- **Chat identifiers in exports.** The exported field list has no chat id, no
  prompt text, no request body and no key. The one chat-shaped value it can carry
  is the name SillyTavern shows for the open chat — a character or group name —
  and only when you tick **Include this chat's name in the export**. The chat
  file name is never included, not in the file and not in its name.
- **Your provider cost if the provider doesn't report it.** Spendbook does not
  look prices up over the network and does not guess.
- **Anything on a server.** There is no server plugin, no telemetry and no remote
  endpoint; deleting the extension deletes the code that could send any.

## What it does not observe

- **`XMLHttpRequest`.** The tap is on `window.fetch` only.
- **Embeddings and other endpoints.** Only
  `/api/backends/chat-completions/generate` is observed.
- **Calls that do not pass through this browser.** Server-side work, background
  jobs that run elsewhere, and other tabs or devices are invisible.
- **Non-SSE provider handlers.** The Anthropic- and Gemini-native handlers do not
  produce the SSE tail this parser reads, so those responses are not counted.
- **Requests sent while tracking is off.** Nothing is wrapped, so nothing is
  recorded; rows from before you turned it on do not appear retroactively.

## For extension authors

Two one-way calls let another extension describe its own traffic. Spendbook never
calls into your extension and never reads its settings. The one exception is the
import you click in the drawer, and only it: it reads this chat's VectFox usage,
writes nothing there, and never runs on its own.

Both calls are on `globalThis.Spendbook`, published when Spendbook loads. If that
object is absent, Spendbook is not installed — the guarded call keeps your
extension working on its own.

### The internal mark

Put a non-enumerable `Symbol.for('spendbook.internal-request')` property on the
request `init` you pass to `fetch`. Its value is an object `{ label: string |
null }`:

```js
const init = { method: 'POST', body: JSON.stringify(body) };
Object.defineProperty(init, Symbol.for('spendbook.internal-request'), {
    value: { label: 'MyFeature' },
});
await fetch('/api/backends/chat-completions/generate', init);
```

- **Key:** `Symbol.for('spendbook.internal-request')` — the `Symbol.for` registry,
  so a reloaded module instance still reads a mark written by the previous one.
  The symbol is non-enumerable, so it never reaches the wire and never changes the
  JSON body.
- **Value:** `{ label: string | null }`. A non-empty string becomes the row's
  origin label; `null` means "internal, unnamed". Anything else is recorded as
  `null`.
- **Scope:** one request. The mark belongs to that `init` only, so a story request
  sent while your call is in flight is not stolen by it.

A marked request is recorded with origin `internal` and your label instead of
being taken for the chat's reply, even while a generation is running.

If you would rather call a helper than write the symbol, Spendbook's
`src/origin.js` exports `markInternalRequest(init, label)`, and the same helper is
on the page surface:

```js
const init = globalThis.Spendbook?.markInternalRequest({ method: 'POST', body }, 'MyFeature')
    ?? { method: 'POST', body };
```

### The configuration label

```js
globalThis.Spendbook?.setConfigurationLabel('gpt-4o · temp 0.8');
// ... run the requests you are measuring ...
globalThis.Spendbook?.setConfigurationLabel(null); // clear
```

- **Shape:** a free-form string, or `null`/blank to clear. It is trimmed, inner
  whitespace is collapsed, and it is capped at 64 characters; a value that is not
  text is treated as no label.
- **Lifetime:** page only. It is never saved as a setting and a reload starts
  with none.
- **When it is read:** when a request is sent, so a label set before a run covers
  that run, and a row is never relabelled after it was captured.
- **Unlabelled requests** are shown and compared as `default`, and that name is
  reserved for them — a label spelled `default` joins the unlabelled group.

`globalThis.Spendbook` carries only `markInternalRequest` and
`setConfigurationLabel`. Nothing else about Spendbook is reachable through it.

## Import from VectFox

The drawer has one explicit import: it brings **this chat's** VectFox usage into
Spendbook — records, measurement runs, the counters for folded rows and the old
price table into an empty one — translating the old origins to `story`, `quiet`
and `internal`. A second click adds nothing, and the old data is left exactly as
it is, so switching back to VectFox still finds its ledger. Other chats are not
scanned: each chat is imported while it is open and you ask for it. Tracking stays
off after an import; turn it on when you want new rows.

## Updates

Updates are git-based, not a versioned release download. SillyTavern's
**Update extension** button (and its startup update check, with
`auto_update: true` in the manifest) pulls this repository's default branch. The
`version` in `manifest.json` is for humans and for the changelog — SillyTavern
only displays it — so a release is a version bump plus a `CHANGELOG.md` entry.

There is no marketplace and no registry, and the extension has no build step: the
repository contents are what runs. Updates do not clear your ledger or price
table; the storage namespaces (`spendbook_usage` in chat metadata,
`spendbook_usage_*` in local storage, `extension_settings.spendbook`) are stable
and a rename is a breaking change.

## License

MIT — see [LICENSE](LICENSE).
