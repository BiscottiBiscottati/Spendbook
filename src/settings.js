/**
 * Spendbook settings.
 *
 * SillyTavern replaces the whole `extension_settings.spendbook` object from the
 * saved settings blob at boot, so every read merges the defaults here instead of
 * assuming the stored object has every key. Writes stay inside Spendbook's own
 * namespace and never re-assign the shared `extension_settings` object.
 */

import { normalizePriceTable } from './prices.js';

const SETTINGS_NAMESPACE = 'spendbook';

/**
 * @typedef {object} SpendbookSettings
 * @property {boolean} trackingEnabled Whether the observer taps chat-completion requests
 * @property {import('./prices.js').UsagePriceTable} prices User-entered price table
 * @property {boolean} includeChatNames Whether exports may carry the open chat's name
 */

/**
 * Whether `value` is a plain object (not an array or null).
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read Spendbook's settings with defaults merged in.
 * @param {object} extensionSettings SillyTavern's shared extension settings object
 * @returns {SpendbookSettings}
 */
export function readSpendbookSettings(extensionSettings = {}) {
    const saved = isPlainObject(extensionSettings?.[SETTINGS_NAMESPACE])
        ? extensionSettings[SETTINGS_NAMESPACE]
        : {};

    return {
        trackingEnabled: saved.trackingEnabled ?? false,
        prices: normalizePriceTable(saved.prices),
        includeChatNames: saved.includeChatNames ?? false,
    };
}

/**
 * Set whether Spendbook tracks chat-completion requests.
 * Creates Spendbook's namespace if needed; touches no other namespace.
 * @param {object} extensionSettings SillyTavern's shared extension settings object
 * @param {boolean} trackingEnabled
 * @returns {boolean} The stored value
 */
export function setTrackingEnabled(extensionSettings, trackingEnabled) {
    if (!isPlainObject(extensionSettings[SETTINGS_NAMESPACE])) {
        extensionSettings[SETTINGS_NAMESPACE] = {};
    }
    extensionSettings[SETTINGS_NAMESPACE].trackingEnabled = Boolean(trackingEnabled);
    return extensionSettings[SETTINGS_NAMESPACE].trackingEnabled;
}

/**
 * Store the user's price table in Spendbook's namespace, normalized so a hand-
 * typed field cannot persist a string or a negative rate. The caller schedules
 * the settings save; this only writes the shared object, and the editor keeps
 * its own normalized copy for the numbers on screen.
 *
 * @param {object} extensionSettings SillyTavern's shared extension settings object
 * @param {import('./prices.js').UsagePriceTable} prices
 * @returns {void}
 */
export function setPriceTable(extensionSettings, prices) {
    if (!isPlainObject(extensionSettings[SETTINGS_NAMESPACE])) {
        extensionSettings[SETTINGS_NAMESPACE] = {};
    }
    extensionSettings[SETTINGS_NAMESPACE].prices = normalizePriceTable(prices);
}
