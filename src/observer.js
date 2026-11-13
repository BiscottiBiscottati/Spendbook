/**
 * Spendbook observer.
 *
 * One page-lifetime `fetch` wrapper for chat-completion traffic. Read-only: it
 * clones the response and returns the caller's own response untouched, and it
 * never changes the request. Three capture paths share it: a non-streamed JSON
 * body, the usage carried in an SSE reply's tail, and a request that was
 * rejected or answered with a non-2xx status, which leaves a row carrying the
 * status and no token numbers. A provider that omits usage gets an estimated
 * prompt count when the injected estimator can supply one, never a zero.
 *
 * Off by default: while tracking is off nothing is installed, and a wrapper that
 * is already installed passes requests through untouched.
 */

import { resolveUsageOrigin, USAGE_ORIGINS } from './origin.js';

export const USAGE_CHAT_COMPLETION_PATH = '/api/backends/chat-completions/generate';
export const USAGE_OBSERVER_MARKER = '__spendbook_usage_observer__';
export const USAGE_SINK_KEY = '__spendbook_usage_sink__';

let _recordSequence = 0;

/**
 * Installs (once) the observer over target.fetch and publishes the sink the
 * wrapper reads. A second install in a reloaded module instance replaces the
 * sink instead of wrapping fetch twice.
 *
 * @param {object} [options]
 * @param {object} [options.target] Object owning fetch (window in production, a
 *   plain object in tests).
 * @param {() => boolean} [options.isEnabled] Read at install time and at request
 *   time. Tracking off at install time leaves fetch unwrapped.
 * @param {() => (string|null)} [options.getChatId] Chat active when the request
 *   was sent.
 * @param {() => (string|null)} [options.getRunId] Measurement run open when the
 *   request was sent.
 * @param {(record: object) => void} [options.handleRecord] Sink that receives
 *   one normalized record per captured request.
 * @param {(messages: object[]) => (number|Promise<number|null>|null)} [options.estimatePromptTokens]
 *   Optional prompt-token estimate from the request messages, used only when
 *   the provider reported no usage. Runs after the response, never on its path.
 * @param {() => void} [options.onSettle] Called after every capture attempt,
 *   including a failed one, so the health line can refresh.
 * @param {() => number} [options.now] Clock, injected for tests.
 * @returns {Function|null} The installed fetch wrapper, or null when tracking is
 *   off or the target has no fetch to wrap.
 */
export function installUsageObserver({
    target = globalThis,
    isEnabled = () => false,
    getChatId = () => null,
    getRunId = () => null,
    handleRecord = () => {},
    estimatePromptTokens = null,
    getOrigin = resolveUsageOrigin,
    onSettle = () => {},
    now = () => Date.now(),
} = {}) {
    if (!target || typeof target.fetch !== 'function') return null;
    if (!readSwitch(isEnabled)) return null;

    // Health belongs to the sink, so a re-enable starts from a clean baseline
    // while a reloaded module instance replaces it without wrapping fetch twice.
    target[USAGE_SINK_KEY] = {
        isEnabled,
        getChatId,
        getRunId,
        handleRecord,
        estimatePromptTokens,
        getOrigin,
        onSettle,
        now,
        health: { matched: 0, captured: 0, skipped: 0, errors: 0 },
    };

    if (target[USAGE_OBSERVER_MARKER]) return target.fetch;

    const originalFetch = target.fetch;
    target.fetch = async function observedUsageFetch(input, init) {
        const sink = target[USAGE_SINK_KEY];
        if (!readSwitch(sink?.isEnabled)) return originalFetch(input, init);

        // Only chat-completion requests are observed; leaving every other fetch
        // on the original path keeps the wrapper invisible to the extension.
        if (!isChatCompletionRequest(input)) return originalFetch(input, init);

        // Origin is decided when the request is sent, not when its deferred
        // capture runs: a generation can end in between.
        const origin = readOrigin(sink, init);
        noteHealth(sink, 'matched');
        const startedAt = sink.now();
        // Chat ownership is decided when the request is sent, not when its
        // response lands — a chat switch mid-flight must not move the record.
        const chatId = readIdentifier(sink, 'getChatId');
        const runId = readIdentifier(sink, 'getRunId');

        // The capture context is built once; only the response-specific
        // fields differ between the paths.
        const captureContext = { sink, init, chatId, runId, origin, startedAt };

        let response;
        try {
            response = await originalFetch(input, init);
        } catch (error) {
            // Latency is measured at the rejection, not when the deferred
            // capture happens to run.
            const latencyMs = Math.max(0, sink.now() - startedAt);
            startCapture(sink, () => captureFailedRecord({
                ...captureContext,
                httpStatus: null,
                status: recordStatus({ aborted: isAbortError(error, init?.signal), error: true }),
                latencyMs,
            }));
            throw error;
        }
        const latencyMs = Math.max(0, sink.now() - startedAt);

        try {
            if (!response.ok) {
                startCapture(sink, () => captureFailedRecord({
                    ...captureContext,
                    httpStatus: response.status,
                    status: recordStatus({ error: true }),
                    latencyMs,
                }));
                return response;
            }
            // Clone before returning: the caller's body must stay untouched.
            // Everything else (including parsing the request body) runs in the
            // floating continuation, after the caller has its response.
            const clone = response.clone();
            const responseContext = {
                ...captureContext,
                clone,
                latencyMs,
                httpStatus: response.status,
            };
            if (isEventStream(response, init)) {
                startCapture(sink, () => captureStreamedRecord(responseContext));
            } else {
                startCapture(sink, () => captureJsonRecord(responseContext));
            }
        } catch {
            noteHealth(sink, 'errors');
            /* the observer must never replace or delay the caller's response */
        }

        return response;
    };
    target[USAGE_OBSERVER_MARKER] = true;

    return target.fetch;
}

/**
 * Health of the installed observer, or null when none is installed.
 *
 * @param {object} [target] Object owning fetch (window in production).
 * @returns {{matched: number, captured: number, skipped: number, errors: number}|null}
 */
export function getUsageObserverHealth(target = globalThis) {
    try {
        const health = target?.[USAGE_SINK_KEY]?.health;
        return health ? { ...health } : null;
    } catch {
        return null;
    }
}

function readSwitch(isEnabled) {
    try {
        return !!(isEnabled && isEnabled());
    } catch {
        return false;
    }
}

function noteHealth(sink, field) {
    try {
        if (sink?.health && typeof sink.health[field] === 'number') sink.health[field] += 1;
    } catch {
        /* health reporting must never affect capture */
    }
}

/**
 * Where the request body carries no JSON string, the request is uncapturable.
 * Counted in the health line rather than guessed at.
 */
function readBodyOrCountSkipped(sink, init) {
    const body = readChatCompletionBody(init);
    if (!body) noteHealth(sink, 'skipped');
    return body;
}

function readIdentifier(sink, getter) {
    try {
        return sink?.[getter]?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * Attribution is read through the sink so the wrapper installed by an earlier
 * module instance uses the reloaded instance's generation state.
 */
function readOrigin(sink, init) {
    try {
        const origin = sink.getOrigin?.(init) ?? resolveUsageOrigin(init);
        if (origin && typeof origin === 'object') return origin;
    } catch {
        /* attribution must never break capture */
    }
    return { origin: USAGE_ORIGINS.INTERNAL, label: null };
}

/**
 * Defers capture to the next macrotask: the caller's response continuation
 * must run before any capture work, including parsing the request body.
 * Capture errors are swallowed — the observer never surfaces them.
 */
function startCapture(sink, run) {
    const start = () => {
        let pending;
        try {
            pending = Promise.resolve(run());
        } catch {
            noteHealth(sink, 'errors');
            notifySettled(sink);
            return;
        }
        pending
            .catch(() => noteHealth(sink, 'errors'))
            .finally(() => notifySettled(sink));
    };
    try {
        setTimeout(start, 0);
    } catch {
        start();
    }
}

function notifySettled(sink) {
    try {
        sink.onSettle?.();
    } catch {
        /* a UI refresh must never affect capture */
    }
}

/**
 * Records a request that produced no usable reply — a rejected fetch or a
 * non-2xx response. Either way the row carries the status and no token
 * numbers, and the caller's rejection or error response is left untouched.
 */
async function captureFailedRecord(context) {
    const { sink, init, chatId, runId, origin, httpStatus, status, startedAt, latencyMs } = context;
    const body = readBodyOrCountSkipped(sink, init);
    if (!body) return;

    emitRecord(sink, buildRecord({
        body,
        chatId,
        runId,
        origin,
        httpStatus,
        usage: null,
        status,
        startedAt,
        latencyMs,
    }));
}

/**
 * Reads a non-streamed response's JSON usage. Runs after the caller has the
 * response; a parse failure or provider error is a status, never a throw.
 */
async function captureJsonRecord(context) {
    const { sink, init, chatId, runId, origin, clone, startedAt, latencyMs, httpStatus } = context;
    const body = readBodyOrCountSkipped(sink, init);
    if (!body) return;

    let data = null;
    try {
        data = await clone.json();
    } catch {
        data = null;
    }

    // A body the observer could not read as a chat-completion object is a
    // failed turn, not a usage-less reply: an estimate there would invent a
    // number for a response nobody understood.
    const readable = !!data && typeof data === 'object' && !Array.isArray(data);
    const usage = readable ? data.usage : null;
    const status = readable ? recordStatus({ error: !!data.error, usage }) : 'error';
    const estimatedPromptTokens = status === 'no-usage'
        ? await estimatePrompt(sink, body)
        : null;
    emitRecord(sink, buildRecord({
        body,
        chatId,
        runId,
        origin,
        httpStatus,
        responseModel: data?.model ?? null,
        responseId: data?.id ?? null,
        usage,
        status,
        estimatedPromptTokens,
        startedAt,
        latencyMs,
    }));
}

function emitRecord(sink, record) {
    try {
        sink.handleRecord(record);
        noteHealth(sink, 'captured');
    } catch {
        noteHealth(sink, 'errors');
    }
}

/**
 * Decodes a cloned SSE body incrementally, keeping only the last non-null
 * usage and stopping at `[DONE]`. The caller's branch of the cloned stream is
 * never awaited here.
 */
async function captureStreamedRecord(context) {
    const { sink, init, chatId, runId, origin, clone, startedAt, latencyMs, httpStatus } = context;
    const body = readBodyOrCountSkipped(sink, init);
    if (!body) {
        // Nothing to attribute: release the cloned branch instead of letting
        // the tee buffer the rest of the stream for an unread reader.
        cancelReader(clone?.body?.getReader?.());
        return;
    }

    const { reader, ...result } = await readSseCapture(clone, init?.signal);
    try {
        const status = recordStatus(result);
        const estimatedPromptTokens = status === 'no-usage'
            ? await estimatePrompt(sink, body)
            : null;
        emitRecord(sink, buildRecord({
            body,
            chatId,
            runId,
            origin,
            httpStatus,
            responseId: result.responseId,
            usage: result.usage,
            status,
            estimatedPromptTokens,
            startedAt,
            latencyMs,
        }));
    } finally {
        // Record first, then cancel: cancelling is fire-and-forget because a
        // tee-branch cancel can stay pending until the caller's branch drains.
        if (reader) cancelReader(reader);
    }
}

const MAX_SSE_CARRY = 1_000_000;

/**
 * Reads the cloned SSE stream to its terminal marker. Frames can be split
 * across reads, so an incomplete line stays in the carry until the rest of it
 * arrives.
 */
async function readSseCapture(clone, signal) {
    const result = { usage: null, responseId: null, sawDone: false, aborted: false, error: false, reader: null };
    const streamedBody = clone?.body;
    if (!streamedBody || typeof streamedBody.getReader !== 'function') {
        result.error = true;
        return result;
    }

    const reader = streamedBody.getReader();
    const decoder = new TextDecoder();
    let carry = '';

    try {
        while (!result.sawDone) {
            const { done, value } = await reader.read();
            if (done) break;
            carry += decoder.decode(value, { stream: true });
            carry = drainSseLines(carry, result);
            if (carry.length > MAX_SSE_CARRY) carry = '';
        }
    } catch (error) {
        if (isAbortError(error, signal)) result.aborted = true;
        else result.error = true;
    }

    // A stream that ends without its terminal marker and without usage was
    // cut off; do not let it pass as a completed request with no usage.
    if (!result.sawDone && !result.usage && !result.aborted) result.error = true;

    if (result.sawDone) result.reader = reader;

    return result;
}

function cancelReader(reader) {
    try {
        reader.cancel().catch(() => {});
    } catch {
        /* already closed */
    }
}

/**
 * Consumes every complete `data:` line in the carry and returns the unfinished
 * tail. A malformed payload is a status, never a throw: the rest of the stream
 * may still carry usage.
 */
function drainSseLines(carry, result) {
    // Providers behind SillyTavern emit one JSON payload per `data:` line. An
    // event whose data spans several `data:` lines is legal SSE but is not
    // reassembled here; such a frame is counted as a malformed payload.

    let newline;
    while ((newline = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newline).replace(/\r$/, '');
        carry = carry.slice(newline + 1);
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
            result.sawDone = true;
            break;
        }
        if (!payload) continue;

        let chunk;
        try {
            chunk = JSON.parse(payload);
        } catch {
            result.error = true;
            continue;
        }
        if (!chunk || typeof chunk !== 'object') continue;

        if (chunk.error) result.error = true;
        if (chunk.usage && typeof chunk.usage === 'object') result.usage = chunk.usage;
        if (typeof chunk.id === 'string') result.responseId = chunk.id;
    }
    return carry;
}

function isAbortError(error, signal) {
    try {
        if (signal?.aborted) return true;
    } catch {
        /* an unreadable signal is treated as not aborted */
    }
    return error?.name === 'AbortError';
}

function recordStatus({ aborted = false, error = false, usage = null } = {}) {
    if (aborted) return 'aborted';
    if (error) return 'error';
    return reportedUsage(usage) ? 'ok' : 'no-usage';
}

/**
 * A usage object counts as reported only when it carries a number. An empty
 * `usage: {}` reports nothing, so it must not be labelled measured: the row
 * stays usage-less and can still be estimated.
 */
function reportedUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const reported = ['prompt_tokens', 'completion_tokens', 'total_tokens']
        .some(key => Number.isFinite(usage[key]));
    return reported ? usage : null;
}

function isChatCompletionRequest(input) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input ?? '');
    if (!url) return false;

    try {
        return new URL(url, 'http://spendbook.test').pathname === USAGE_CHAT_COMPLETION_PATH;
    } catch {
        return false;
    }
}

function isEventStream(response, init) {
    try {
        const contentType = String(response?.headers?.get?.('content-type') ?? '').toLowerCase();
        if (contentType.includes('text/event-stream')) return true;
        if (contentType) return false;
        // SillyTavern's chat-completion proxy pipes provider SSE without a
        // content-type header. When the header is absent, the request's stream
        // flag is the only reliable signal.
        return requestWantsStream(init);
    } catch {
        return false;
    }
}

function requestWantsStream(init) {
    const rawBody = init?.body;
    if (typeof rawBody !== 'string') return false;
    try {
        return JSON.parse(rawBody)?.stream === true;
    } catch {
        return false;
    }
}

/**
 * Reads the request shape the observer needs, without keeping the prompt.
 * Only a JSON string body; a Request object or a non-string body is skipped.
 */
function readChatCompletionBody(init) {
    const rawBody = init?.body;
    if (typeof rawBody !== 'string') return null;

    let body;
    try {
        body = JSON.parse(rawBody);
    } catch {
        return null;
    }
    if (!body || typeof body !== 'object') return null;

    return body;
}

/**
 * Runs the injected estimator after a usage-less response. A missing or
 * failing estimator leaves the prompt count unavailable rather than inventing
 * a number; the observer still records the request.
 */
async function estimatePrompt(sink, body) {
    const estimator = sink?.estimatePromptTokens;
    if (typeof estimator !== 'function' || !Array.isArray(body?.messages)) return null;
    try {
        const value = await estimator(body.messages);
        return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
    } catch {
        return null;
    }
}

function buildRecord({
    body,
    chatId,
    runId,
    origin,
    httpStatus,
    responseModel = null,
    responseId = null,
    usage = null,
    status,
    estimatedPromptTokens = null,
    startedAt,
    latencyMs,
}) {
    const reported = reportedUsage(usage);
    const promptTokens = toCount(reported?.prompt_tokens);
    const completionTokens = toCount(reported?.completion_tokens);
    const reportedTotal = toCount(reported?.total_tokens);
    const totalTokens = reportedTotal ?? (
        promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null
    );

    return {
        recordId: createRecordId(),
        timestamp: startedAt,
        chatId,
        runId: typeof runId === 'string' ? runId : null,
        origin: origin?.origin ?? USAGE_ORIGINS.INTERNAL,
        label: origin?.label ?? null,
        provider: body.chat_completion_source || 'unknown',
        model: body.model || responseModel || 'unknown',
        responseId,
        stream: body.stream === true,
        status,
        httpStatus,
        latencyMs,
        messageCount: Array.isArray(body.messages) ? body.messages.length : null,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedPromptTokens,
        usageSource: reported ? 'measured' : (estimatedPromptTokens != null ? 'estimated' : 'unavailable'),
    };
}

function toCount(value) {
    return Number.isFinite(value) ? value : null;
}

function createRecordId() {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch {
        /* fall through to the sequence */
    }
    _recordSequence += 1;
    return `spendbook-${Date.now().toString(36)}-${_recordSequence}`;
}
