/**
 * Spendbook host surface.
 *
 * The one place another extension may reach without importing across extension
 * folders: `globalThis.Spendbook`, published once when Spendbook loads. It
 * carries the two documented calls and nothing else — the per-request internal
 * mark and the configuration label — so a host cannot couple to Spendbook's
 * internals through it.
 *
 * A host that wants zero coupling writes the mark's `Symbol.for` property and
 * calls this surface's label setter, both documented in the README.
 */

import { setConfigurationLabel } from './configuration.js';
import { markInternalRequest } from './origin.js';

const SPENDBOOK_HOST_NAME = 'Spendbook';

/**
 * Publishes `target.Spendbook`. Publishing twice replaces the surface, so a
 * reloaded module instance keeps one page object rather than stacking them.
 *
 * @param {object} [options]
 * @param {object|null} [options.target] Object to publish on (`globalThis` in
 *   production, a plain object in tests).
 * @returns {{markInternalRequest: Function, setConfigurationLabel: Function}|null}
 *   The surface, or null when the target cannot hold it.
 */
export function publishSpendbookHost({ target = globalThis } = {}) {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) return null;
    const surface = { markInternalRequest, setConfigurationLabel };
    target[SPENDBOOK_HOST_NAME] = surface;
    return surface;
}
