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

const RESET_CHAT_MESSAGE = 'Clear Spendbook’s usage rows for this chat? '
    + 'The all-time totals lose this chat’s contribution. This cannot be undone.';
const RESET_ALL_TIME_MESSAGE = 'Clear Spendbook’s all-time totals? '
    + 'Every chat keeps its own rows. This cannot be undone.';

/**
 * Mount the Spendbook drawer and bind its controls.
 * @param {object} options
 * @param {HTMLElement} options.container Element to append the drawer to
 * @param {string} options.html Rendered drawer markup
 * @param {import('../src/settings.js').SpendbookSettings} options.settings Settings with defaults already merged
 * @param {(trackingEnabled: boolean) => void} options.onTrackingChange Called when the user flips the tracking toggle
 * @param {() => ({records: object[], trackingEnabled: boolean, health: object|null, retention: object|null, allTime: object|null})} [options.getSnapshot] Reads the current ledger and observer state; called on mount, on refresh and after a toggle change
 * @param {() => void} [options.onResetChat] Clears the open chat after the user confirmed it
 * @param {() => void} [options.onResetAllTime] Clears the all-time totals after the user confirmed it
 * @param {(message: string) => boolean} [options.confirmReset] Asks the user; declining leaves the ledger untouched
 * @returns {{root: HTMLElement, refresh: () => void}} The mounted drawer and its repaint function
 */
export function mountSpendbookPanel({
    container,
    html,
    settings,
    onTrackingChange,
    getSnapshot = null,
    onResetChat = () => {},
    onResetAllTime = () => {},
    confirmReset = defaultConfirmReset,
}) {
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
    const allTimeLine = root.querySelector('.spendbook-alltime');
    const emptyLine = root.querySelector('.spendbook-empty');
    const table = root.querySelector('.spendbook-table');
    const rows = root.querySelector('.spendbook-rows');
    const retentionLine = root.querySelector('.spendbook-retention');
    const resetChatButton = root.querySelector('.spendbook-reset-chat');
    const resetAllTimeButton = root.querySelector('.spendbook-reset-alltime');
    if (!healthLine || !allTimeLine || !emptyLine || !table || !rows
        || !retentionLine || !resetChatButton || !resetAllTimeButton) {
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
        allTimeLine.textContent = view.allTime.label;
        emptyLine.textContent = view.empty ? view.emptyMessage : '';
        emptyLine.hidden = !view.empty;
        table.hidden = view.empty;
        retentionLine.textContent = view.retention.label;
        rows.replaceChildren(...view.rows.map(renderRow));
    };

    toggle.checked = settings.trackingEnabled;
    toggle.addEventListener('change', () => {
        onTrackingChange(toggle.checked);
        refresh();
    });

    resetChatButton.addEventListener('click', () => {
        if (!confirmReset(RESET_CHAT_MESSAGE)) return;
        onResetChat();
    });
    resetAllTimeButton.addEventListener('click', () => {
        if (!confirmReset(RESET_ALL_TIME_MESSAGE)) return;
        onResetAllTime();
    });

    refresh();

    return { root, refresh };
}

/**
 * A reset is destructive, so it never runs without a visible confirmation. A
 * host without `confirm` is treated as a decline rather than a yes.
 *
 * @param {string} message
 * @returns {boolean}
 */
function defaultConfirmReset(message) {
    if (typeof globalThis.confirm !== 'function') return false;
    return globalThis.confirm(message) === true;
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
