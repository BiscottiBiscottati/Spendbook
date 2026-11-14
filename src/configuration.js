/**
 * Spendbook configuration label.
 *
 * A free-form label a host extension sets for the runs it drives, so a row can
 * say which configuration was in force when it was sent without Spendbook
 * knowing anything about the host's settings.
 *
 * Page-lifetime, never persisted: it is module state, read when a request is
 * sent. A label set before a run therefore covers that run, and a label set
 * afterwards never retro-labels the rows already recorded. With no host label,
 * rows are shown and grouped as `default`.
 *
 * One owner of the label's shape: trimmed, whitespace collapsed, length-capped,
 * and empty is no label at all.
 */

export const DEFAULT_CONFIGURATION_LABEL = 'default';

// A label describes a configuration, not a paragraph: long enough for
// "gpt-4o · temp 0.8 · no system prompt" and short enough to sit in a table
// column without turning the comparison into a wall of text.
export const CONFIGURATION_LABEL_MAX_LENGTH = 64;

let _configurationLabel = null;

/**
 * The label as Spendbook stores it. A value that is not text, and one that is
 * blank once trimmed, both mean no label.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeConfigurationLabel(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim().replace(/\s+/g, ' ');
    if (!text) return null;
    return text.length > CONFIGURATION_LABEL_MAX_LENGTH
        // The cap can land on a space; trimming the slice keeps a label from
        // ending on whitespace.
        ? text.slice(0, CONFIGURATION_LABEL_MAX_LENGTH).trim()
        : text;
}

/**
 * The configuration label in force right now, or null when no host set one.
 * The observer reads this when a request is sent.
 *
 * @returns {string|null}
 */
export function getConfigurationLabel() {
    return _configurationLabel;
}

/**
 * Sets the page-lifetime configuration label. `null` — or a blank value —
 * clears it. The label is not a setting: it is never persisted, and a reload
 * starts with none.
 *
 * @param {string|null} label
 * @returns {string|null} The label as stored.
 */
export function setConfigurationLabel(label) {
    _configurationLabel = normalizeConfigurationLabel(label);
    return _configurationLabel;
}
