/**
 * Spendbook prompt-token estimator.
 *
 * Estimates prompt tokens only, and only for a provider that reported no
 * usage; a cache hit is never estimated. SillyTavern's tokenizer is loaded
 * lazily through an injected loader, so a missing tokenizer leaves the record
 * "unavailable" rather than turning it into a zero.
 */

import { messageText } from './message.js';

/**
 * Builds the estimator the observer runs after a usage-less response.
 *
 * @param {object} [options]
 * @param {() => (object|Promise<object>|null)} [options.loadTokenizer] Lazily
 *   imports SillyTavern's tokenizer module; a failure leaves estimates
 *   unavailable instead of breaking capture.
 * @returns {(messages: object[]) => Promise<number|null>}
 */
export function createPromptTokenEstimator({ loadTokenizer = () => null } = {}) {
    const load = createTokenizerLoader(loadTokenizer);

    return async function estimatePromptTokens(messages) {
        if (!Array.isArray(messages)) return null;
        const tokenizer = await load();
        if (typeof tokenizer?.getTokenCountAsync !== 'function') return null;

        let total = 0;
        for (const message of messages) {
            const text = messageText(message);
            if (!text) continue;
            try {
                total += await tokenizer.getTokenCountAsync(text);
            } catch {
                return null;
            }
        }
        return total > 0 ? total : null;
    };
}

/**
 * One lazy tokenizer import per factory, shared by repeated estimates.
 *
 * @param {() => (object|Promise<object>|null)} loadTokenizer
 * @returns {() => Promise<object|null>}
 */
function createTokenizerLoader(loadTokenizer) {
    let tokenizerPromise = null;
    return () => {
        if (!tokenizerPromise) {
            tokenizerPromise = Promise.resolve()
                .then(() => loadTokenizer())
                .catch(() => null);
        }
        return tokenizerPromise;
    };
}
