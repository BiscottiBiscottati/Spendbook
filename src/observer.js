/**
 * Spendbook observer.
 *
 * One page-lifetime `fetch` wrapper for chat-completion traffic. Read-only: it
 * clones the response and returns the caller's own response untouched, and it
 * never changes the request. This ticket captures non-streamed JSON responses;
 * the SSE tail, rejected requests and HTTP errors arrive with their own ticket.
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
        getOrigin,
        onSettle,
        now,
        health: { matched: 0, captured: 0, errors: 0 },
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

        const response = await originalFetch(input, init);

        try {
            if (!response.ok) return response;
            // A streamed reply is counted by the next ticket; parsing its body
            // as JSON here would only turn a good response into no row.
            if (isEventStream(response, init)) return response;
            // Clone before returning: the caller's body must stay untouched.
            const clone = response.clone();
            startCapture(sink, () => captureJsonRecord({
                sink,
                init,
                chatId,
                runId,
                origin,
                clone,
                startedAt,
                latencyMs: Math.max(0, sink.now() - startedAt),
                httpStatus: response.status,
            }));
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
 * @returns {{matched: number, captured: number, errors: number}|null}
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
 * Reads a non-streamed response's JSON usage. Runs after the caller has the
 * response; a parse failure or provider error is a status, never a throw.
 */
async function captureJsonRecord(context) {
    const { sink, init, chatId, runId, origin, clone, startedAt, latencyMs, httpStatus } = context;
    const body = readChatCompletionBody(init);
    if (!body) return;

    let data = null;
    try {
        data = await clone.json();
    } catch {
        data = null;
    }

    const usage = data && typeof data === 'object' ? data.usage : null;
    const hasUsage = !!usage && typeof usage === 'object';
    emitRecord(sink, buildRecord({
        body,
        chatId,
        runId,
        origin,
        httpStatus,
        responseModel: data?.model ?? null,
        responseId: data?.id ?? null,
        usage,
        status: data?.error ? 'error' : (hasUsage ? 'ok' : 'no-usage'),
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
    startedAt,
    latencyMs,
}) {
    const hasUsage = !!usage && typeof usage === 'object';
    const promptTokens = toCount(usage?.prompt_tokens);
    const completionTokens = toCount(usage?.completion_tokens);
    const reportedTotal = toCount(usage?.total_tokens);
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
        usageSource: hasUsage ? 'measured' : 'unavailable',
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
