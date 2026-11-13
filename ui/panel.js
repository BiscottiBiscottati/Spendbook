/**
 * Spendbook panel — the DOM layer of the settings drawer.
 *
 * The entry module renders `settings.html` through SillyTavern's template
 * loader and hands the HTML here; this module mounts it and binds the tracking
 * toggle. Persistence belongs to the caller: the toggle reports the new value
 * and the entry module writes it into Spendbook's settings namespace.
 */

const TRACKING_TOGGLE_ID = 'spendbook_tracking_enabled';

/**
 * Mount the Spendbook drawer and bind its controls.
 * @param {object} options
 * @param {HTMLElement} options.container Element to append the drawer to
 * @param {string} options.html Rendered drawer markup
 * @param {import('../src/settings.js').SpendbookSettings} options.settings Settings with defaults already merged
 * @param {(trackingEnabled: boolean) => void} options.onTrackingChange Called when the user flips the tracking toggle
 * @returns {HTMLElement} The mounted drawer
 */
export function mountSpendbookPanel({ container, html, settings, onTrackingChange }) {
    container.insertAdjacentHTML('beforeend', html);
    const root = container.querySelector('.spendbook-drawer');
    if (!root) {
        throw new Error('Spendbook: the settings template has no .spendbook-drawer.');
    }

    const toggle = root.querySelector(`#${TRACKING_TOGGLE_ID}`);
    if (!toggle) {
        throw new Error('Spendbook: the settings template has no tracking toggle.');
    }

    toggle.checked = settings.trackingEnabled;
    toggle.addEventListener('change', () => onTrackingChange(toggle.checked));

    return root;
}
