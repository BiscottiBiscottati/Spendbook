/**
 * Stable ids for the things Spendbook persists: one usage record and one
 * measurement run. A reloaded page must not reuse an id already in the chat
 * file or in the pending copy, because both are merged by id.
 */

let sequence = 0;

/**
 * A unique id from the platform's UUID source, with a sequence fallback for a
 * host that withholds it.
 *
 * @param {string} prefix Fallback prefix, so an id says what it names.
 * @returns {string}
 */
export function createUsageId(prefix) {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch {
        /* fall through to the sequence */
    }
    sequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}
