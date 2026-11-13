/**
 * Spendbook settings.
 *
 * SillyTavern replaces the whole `extension_settings.spendbook` object from the
 * saved settings blob at boot, so every read merges the defaults here instead of
 * assuming the stored object has every key. Writes stay inside Spendbook's own
 * namespace and never re-assign the shared `extension_settings` object.
 */

const SETTINGS_NAMESPACE = 'spendbook';

const EMPTY_PRICE_TABLE = Object.freeze({
    currency: 'USD',
    updated: '',
    entries: Object.freeze([]),
});

/**
 * @typedef {object} SpendbookSettings
 * @property {boolean} trackingEnabled Whether the observer taps chat-completion requests
 * @property {{ currency: string, updated: string, entries: object[] }} prices User-entered price table
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
 * Normalize a price table so a missing or partial saved value still behaves.
 * @param {unknown} saved
 * @returns {{ currency: string, updated: string, entries: object[] }}
 */
function readPriceTable(saved) {
    const table = isPlainObject(saved) ? saved : {};
    return {
        currency: table.currency ?? EMPTY_PRICE_TABLE.currency,
        updated: table.updated ?? EMPTY_PRICE_TABLE.updated,
        entries: Array.isArray(table.entries) ? table.entries.map(entry => ({ ...entry })) : [],
    };
}

/**
 * Read Spendbook's settings with defaults merged in.
 * @param {object} extensionSettings SillyTavern's shared extension settings object
 * @returns {SpendbookSettings}
 */
export function readSpendbookSettings(extensionSettings = {}) {
    const saved = isPlainObject(extensionSettings[SETTINGS_NAMESPACE])
        ? extensionSettings[SETTINGS_NAMESPACE]
        : {};

    return {
        trackingEnabled: saved.trackingEnabled ?? false,
        prices: readPriceTable(saved.prices),
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
