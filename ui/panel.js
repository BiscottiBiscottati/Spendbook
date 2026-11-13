/**
 * Spendbook panel — the DOM layer of the settings drawer.
 *
 * The entry module renders `settings.html` through SillyTavern's template
 * loader and hands the HTML here; this module mounts it, binds the tracking
 * toggle and paints the usage table from a read-only snapshot. The caller owns
 * the ledger, the observer and the settings; the panel only reads through
 * `getSnapshot` and asks the entry module to persist a toggle change.
 */

import { buildUsageView } from './view.js';

const TRACKING_TOGGLE_ID = 'spendbook_tracking_enabled';

/**
 * Mount the Spendbook drawer and bind its controls.
 * @param {object} options
 * @param {HTMLElement} options.container Element to append the drawer to
 * @param {string} options.html Rendered drawer markup
 * @param {import('../src/settings.js').SpendbookSettings} options.settings Settings with defaults already merged
 * @param {(trackingEnabled: boolean) => void} options.onTrackingChange Called when the user flips the tracking toggle
 * @param {() => ({records: object[], trackingEnabled: boolean, health: object|null})} [options.getSnapshot] Reads the current ledger and observer state; called on mount, on refresh and after a toggle change
 * @returns {{root: HTMLElement, refresh: () => void}} The mounted drawer and its repaint function
 */
export function mountSpendbookPanel({ container, html, settings, onTrackingChange, getSnapshot = null }) {
    container.insertAdjacentHTML('beforeend', html);
    const root = container.querySelector('.spendbook-drawer');
    if (!root) {
        throw new Error('Spendbook: the settings template has no .spendbook-drawer.');
    }

    const toggle = root.querySelector(`#${TRACKING_TOGGLE_ID}`);
    if (!toggle) {
        throw new Error('Spendbook: the settings template has no tracking toggle.');
    }

    const healthLine = root.querySelector('.spendbook-health');
    const emptyLine = root.querySelector('.spendbook-empty');
    const table = root.querySelector('.spendbook-table');
    const rows = root.querySelector('.spendbook-rows');
    if (!healthLine || !emptyLine || !table || !rows) {
        throw new Error('Spendbook: the settings template has no usage table.');
    }

    const readSnapshot = () => {
        if (typeof getSnapshot === 'function') return getSnapshot();
        return { records: [], trackingEnabled: settings.trackingEnabled, health: null };
    };

    const refresh = () => {
        const view = buildUsageView(readSnapshot());
        healthLine.textContent = view.health.label;
        healthLine.dataset.state = view.health.state;
        emptyLine.textContent = view.empty ? view.emptyMessage : '';
        emptyLine.hidden = !view.empty;
        table.hidden = view.empty;
        rows.replaceChildren(...view.rows.map(renderRow));
    };

    toggle.checked = settings.trackingEnabled;
    toggle.addEventListener('change', () => {
        onTrackingChange(toggle.checked);
        refresh();
    });

    refresh();

    return { root, refresh };
}

function renderRow(row) {
    const tr = document.createElement('tr');
    tr.dataset.recordId = row.recordId;
    appendCell(tr, 'time', row.timeLabel);
    appendCell(tr, 'origin', row.originLabel);
    appendCell(tr, 'label', row.labelLabel);
    appendCell(tr, 'provider', row.providerLabel);
    appendCell(tr, 'model', row.modelLabel);
    appendCell(tr, 'prompt', row.promptLabel);
    appendCell(tr, 'completion', row.completionLabel);
    appendCell(tr, 'latency', row.latencyLabel);
    appendCell(tr, 'status', row.statusLabel);
    appendCell(tr, 'source', row.sourceLabel);
    return tr;
}

function appendCell(row, field, text) {
    const cell = document.createElement('td');
    cell.className = `spendbook-cell-${field}`;
    cell.textContent = text;
    row.append(cell);
}
