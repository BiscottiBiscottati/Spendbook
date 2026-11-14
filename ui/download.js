/**
 * Spendbook download helper.
 *
 * Saves a generated export through a Blob download. The drawer's export button
 * and `/spendbook-export` both come here, so the two paths cannot save the same
 * file two different ways.
 */

/** How long a generated file's object URL stays alive after the click. */
const REVOKE_DELAY_MS = 1000;

/**
 * Starts a download of one generated file. The object URL is revoked on a later
 * task rather than in the same tick, because the browser copies the blob
 * asynchronously and revoking immediately can cancel the download.
 *
 * @param {string} fileName
 * @param {string} content
 * @returns {boolean} Whether a download was started; a host without Blob or a
 *   document cannot save one.
 */
export function saveJsonFile(fileName, content) {
    if (typeof Blob !== 'function'
        || typeof globalThis.URL?.createObjectURL !== 'function'
        || typeof document === 'undefined') {
        return false;
    }

    const url = globalThis.URL.createObjectURL(new Blob([content], { type: 'application/json' }));

    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    } catch (error) {
        // Nothing will consume the URL now; do not wait out the grace period.
        globalThis.URL.revokeObjectURL?.(url);
        throw error;
    }

    setTimeout(() => globalThis.URL.revokeObjectURL?.(url), REVOKE_DELAY_MS);
    return true;
}
