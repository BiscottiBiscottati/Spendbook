# Spendbook

A SillyTavern extension that keeps a ledger of your model calls: tokens in and
out, cached prompt tokens, cost, latency, origin, coverage, measurement runs,
configuration comparison, and prefix-breaker detection — so you can see what a
chat actually costs and whether prompt caching is doing what you expect.

**Status: pre-implementation.** The ledger is being extracted from
[VectFox](https://github.com/KritBlade/VectFox); install instructions land with
the first release. The decision and its reasoning are in
[`docs/adr/0001`](docs/adr/0001-usage-accounting-leaves-vectfox.md).

## What it will do

- Observe chat-completion traffic through SillyTavern's backend — non-streamed
  and streamed (SSE-tail usage).
- Record per call: provider-reported prompt/cached/completion/reasoning tokens,
  cost from prices you enter, latency, and an origin — `story`, `quiet`, or
  `internal` for calls an extension labels as its own.
- Aggregate per chat and all-time: token-weighted cache-hit rate, coverage,
  comparison runs, and a flag for requests that break the prompt prefix.
- Compare labelled configurations side by side — requests, tokens, cost and
  hit rate per configuration label a host extension set.
- Export the ledger as JSON, with **no chat identifiers** unless you ask for chat
  names.

## What it will not do

- Store prompt text. Records hold hashes and counts only.
- Need a vector backend or any other extension. It works on a plain chat.
- See embeddings or server-side calls: it observes browser-side chat-completion
  requests only, and parses `data:` SSE frames (Anthropic/Gemini native handlers
  are not covered).

## For extension authors

Two one-way calls let another extension describe its own traffic. Spendbook never
calls into your extension and never reads its settings, so neither side imports
the other.

### Mark your own request as internal

A marked request is recorded as `internal` with your label instead of being taken
for the chat's reply. The mark is a `Symbol.for('spendbook.internal-request')`
property on the request `init` whose value is `{ label: string | null }`:

```js
const init = { method: 'POST', body: JSON.stringify(body) };
Object.defineProperty(init, Symbol.for('spendbook.internal-request'), {
    value: { label: 'MyFeature' },
});
await fetch('/api/backends/chat-completions/generate', init);
```

The symbol is non-enumerable, so the mark never reaches the wire and never changes
the JSON body. It belongs to that one request: a story request sent while your
call is in flight is not stolen by it. If Spendbook is loaded, the same call is
also available as a helper:

```js
const init = globalThis.Spendbook?.markInternalRequest(init, 'MyFeature') ?? init;
```

### Label a configuration

```js
globalThis.Spendbook?.setConfigurationLabel('gpt-4o · temp 0.8');
// ... run what you are measuring ...
globalThis.Spendbook?.setConfigurationLabel(null); // clear
```

The label is page-lifetime and is never saved as a setting. Spendbook reads it
when a request is sent, so a label set before a run covers that run, and a row is
never relabelled after it was captured. It is trimmed, inner whitespace is
collapsed and it is capped at 64 characters; `null` or a blank value clears it.
Requests sent with no label are shown and compared as `default`, and that name is
reserved for them — a label spelled `default` joins the unlabelled group.

`globalThis.Spendbook` carries only those two calls. If it is absent, Spendbook is
not installed — the guarded call keeps your extension working on its own.

## Install (once released)

SillyTavern → Extensions → Install extension → paste this repository's URL.

## License

MIT — see [LICENSE](LICENSE).
