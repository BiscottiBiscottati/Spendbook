/**
 * Spendbook origin attribution.
 *
 * Answers "what caused this chat-completion request?" for the observer:
 * `story` (the chat's own reply), `quiet` (a generation whose result is handed
 * back to its caller) or `internal` (a call an extension made for its own work).
 *
 * The generation state is fed from SillyTavern's GENERATION_STARTED /
 * GENERATION_ENDED / GENERATION_STOPPED events. A caller that wants its own call
 * attributed can leave the internal mark on the request init; the mark is
 * per-request, so two overlapping calls stay independent, and it lives on the
 * init rather than in shared state so a story request sent during another
 * call's flight is never stolen by it.
 *
 * The origin is resolved synchronously when the request is sent: a generation
 * can end before a deferred capture runs.
 */

export const USAGE_ORIGINS = Object.freeze({
    STORY: 'story',
    QUIET: 'quiet',
    INTERNAL: 'internal',
});

// Symbol.for, not a module-local Symbol: a reloaded module instance must still
// read a mark written by the previous one.
const INTERNAL_REQUEST_MARK = Symbol.for('spendbook.internal-request');

// Generation types that produce the story reply (and its swipe/regenerate).
const STORY_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue', 'impersonate']);

let _generation = null;

/**
 * Marks one request init as internal. The mark is non-enumerable and a Symbol,
 * so it never reaches the wire and never changes a JSON body.
 *
 * @param {object|null} init Request init about to be passed to fetch.
 * @param {string|null} [label] Short feature name, e.g. 'Summarizer'.
 * @returns {object|null} The same init, for chaining.
 */
export function markInternalRequest(init, label = null) {
    if (!init || typeof init !== 'object') return null;
    Object.defineProperty(init, INTERNAL_REQUEST_MARK, {
        value: { label: typeof label === 'string' && label ? label : null },
        configurable: true,
        enumerable: false,
        writable: false,
    });
    return init;
}

/**
 * Marks a generation as in flight. A dry run assembles a prompt without calling
 * the provider, so it must not make the next call look like a story reply.
 *
 * @param {string} type SillyTavern generation type.
 * @param {{dryRun?: boolean, quietToLoud?: boolean}} [options] A quiet-to-loud
 *   generation is posted as a chat message, so it is a story reply.
 */
export function noteGenerationStarted(type, { dryRun = false, quietToLoud = false } = {}) {
    if (dryRun) return;
    _generation = {
        type: typeof type === 'string' ? type : null,
        quietToLoud: quietToLoud === true,
    };
}

/** Clears the in-flight generation on GENERATION_ENDED / GENERATION_STOPPED. */
export function noteGenerationEnded() {
    _generation = null;
}

/**
 * The origin the observed request belongs to. A per-request internal mark wins;
 * otherwise the request follows the generation state. A call with no generation
 * in flight — or an unrecognised generation type — is internal without a label:
 * the mark is how a caller names itself, and the fallback never claims a call
 * was the story reply.
 *
 * @param {object|null} [init] The request init the observer received.
 * @returns {{origin: string, label: string|null}}
 */
export function resolveUsageOrigin(init = null) {
    const marked = init && typeof init === 'object' ? init[INTERNAL_REQUEST_MARK] : null;
    if (marked) {
        return { origin: USAGE_ORIGINS.INTERNAL, label: marked.label ?? null };
    }
    if (!_generation) {
        return { origin: USAGE_ORIGINS.INTERNAL, label: null };
    }
    if (_generation.type === 'quiet') {
        return _generation.quietToLoud
            ? { origin: USAGE_ORIGINS.STORY, label: null }
            : { origin: USAGE_ORIGINS.QUIET, label: null };
    }
    if (STORY_GENERATION_TYPES.has(_generation.type)) {
        return { origin: USAGE_ORIGINS.STORY, label: null };
    }
    return { origin: USAGE_ORIGINS.INTERNAL, label: null };
}
