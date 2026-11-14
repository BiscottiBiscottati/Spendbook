/**
 * Spendbook panel — the DOM layer of the settings drawer.
 *
 * The entry module renders `settings.html` through SillyTavern's template
 * loader and hands the HTML here; this module mounts it, binds the tracking
 * toggle and paints the usage table from a read-only snapshot. The price table
 * is its own module. The caller owns the ledger, the observer and the settings;
 * the panel only reads through `getSnapshot`, and asks the entry module to
 * persist a toggle or a price change.
 */

import { buildUsageView } from './view.js';
import { mountPriceEditor } from './price-editor.js';

const TRACKING_TOGGLE_ID = 'spendbook_tracking_enabled';
const INCLUDE_CHAT_NAMES_ID = 'spendbook_include_chat_names';

/** How long a generated file's object URL stays alive after the click. */
const REVOKE_DELAY_MS = 1000;

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
 * @param {() => ({chatId?: string|null, records: object[], trackingEnabled: boolean, health: object|null, retention: object|null, allTime: object|null, archive: object|null, runs?: object|null})} [options.getSnapshot] Reads the current ledger and observer state; called on mount, on refresh, after a toggle change, a run start and a price edit
 * @param {() => void} [options.onResetChat] Clears the open chat after the user confirmed it
 * @param {() => void} [options.onResetAllTime] Clears the all-time totals after the user confirmed it
 * @param {(prices: import('../src/prices.js').UsagePriceTable) => void} [options.onPricesChange] Persists the edited price table
 * @param {(label: string) => (object|null)} [options.onStartRun] Starts a measurement run in the open chat and returns it
 * @param {() => ({fileName: string, content: string}|null)} [options.onExport] Builds the JSON export of the open chat, which the panel saves; null means nothing was built
 * @param {(includeChatNames: boolean) => void} [options.onIncludeChatNamesChange] Persists the chat-name opt-in
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
    onPricesChange = () => {},
    onStartRun = () => null,
    onExport = () => null,
    onIncludeChatNamesChange = () => {},
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
    const cardsContainer = root.querySelector('.spendbook-cards');
    const configurationTable = root.querySelector('.spendbook-configuration-table');
    const configurationRows = root.querySelector('.spendbook-configuration-rows');
    const allTimeLine = root.querySelector('.spendbook-alltime');
    const emptyLine = root.querySelector('.spendbook-empty');
    const table = root.querySelector('.spendbook-table');
    const rows = root.querySelector('.spendbook-rows');
    const retentionLine = root.querySelector('.spendbook-retention');
    const resetChatButton = root.querySelector('.spendbook-reset-chat');
    const resetAllTimeButton = root.querySelector('.spendbook-reset-alltime');
    const priceSection = root.querySelector('.spendbook-prices');
    const runCurrentLine = root.querySelector('.spendbook-run-current');
    const runFilter = root.querySelector('.spendbook-run-filter');
    const runLabelInput = root.querySelector('.spendbook-run-label');
    const runStartButton = root.querySelector('.spendbook-run-start');
    const exportButton = root.querySelector('.spendbook-export-button');
    const includeChatNamesInput = root.querySelector(`#${INCLUDE_CHAT_NAMES_ID}`);
    if (!healthLine || !cardsContainer || !configurationTable || !configurationRows
        || !allTimeLine || !emptyLine || !table || !rows
        || !retentionLine || !resetChatButton || !resetAllTimeButton
        || !runCurrentLine || !runFilter || !runLabelInput || !runStartButton
        || !exportButton || !includeChatNamesInput) {
        throw new Error('Spendbook: the settings template is incomplete.');
    }

    const readSnapshot = () => {
        if (typeof getSnapshot === 'function') return getSnapshot();
        return { records: [], trackingEnabled: settings.trackingEnabled, health: null };
    };

    // The run the user filtered to, and the chat it belongs to. A run id is
    // unique to one chat, so a switch must clear the filter rather than show a
    // window that belongs to the chat the user left.
    let selectedRunId = '';
    let activeChatId = null;
    // Null, not '', so the first render always writes the options: an empty run
    // list still needs its "All runs" option.
    let runOptionsSignature = null;

    const refresh = () => {
        const snapshot = readSnapshot();
        if (snapshot.chatId !== activeChatId) {
            activeChatId = snapshot.chatId;
            selectedRunId = '';
        }
        const view = buildUsageView({ ...snapshot, selectedRunId, prices: editor.prices });
        // A run the chat no longer lists (a reset, a rename) stops being a filter.
        // The select's "all runs" option is the empty string; the view speaks null.
        selectedRunId = view.runs.selectedRunId ?? '';
        healthLine.textContent = view.health.label;
        healthLine.dataset.state = view.health.state;
        renderRunBar(view.runs, { canStart: !!snapshot.chatId });
        cardsContainer.replaceChildren(...view.cards.map(renderCard));
        configurationTable.hidden = view.configurations.empty;
        configurationRows.replaceChildren(...view.configurations.groups.map(renderConfigurationRow));
        allTimeLine.textContent = view.allTime.label;
        emptyLine.textContent = view.empty ? view.emptyMessage : '';
        emptyLine.hidden = !view.empty;
        table.hidden = view.empty;
        retentionLine.textContent = view.retention.label;
        rows.replaceChildren(...view.rows.map(renderRow));
    };

    /**
     * Every run is listed even while one is shown, so switching back to all runs
     * needs no second control. The options are rebuilt only when the runs change,
     * so a capture arriving while the list is open does not close it.
     */
    const renderRunBar = (runs, { canStart }) => {
        runCurrentLine.textContent = runs.currentLabel;
        const signature = runs.items.map((item) => `${item.runId}\u0000${item.optionLabel}`).join('\u0001');
        if (signature !== runOptionsSignature) {
            runOptionsSignature = signature;
            runFilter.replaceChildren(
                createOption('', 'All runs'),
                ...runs.items.map((item) => createOption(item.runId, item.optionLabel)),
            );
        }
        runFilter.value = selectedRunId;
        runFilter.disabled = runs.items.length === 0;
        runLabelInput.disabled = !canStart;
        runStartButton.disabled = !canStart;
    };

    // Only edits that change computed results repaint; the editor keeps its own
    // fields, so the next keystroke still lands where the user left it.
    const editor = mountPriceEditor({
        section: priceSection,
        prices: settings.prices,
        onChange: (prices) => {
            onPricesChange(prices);
            refresh();
        },
    });

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

    runFilter.addEventListener('change', () => {
        selectedRunId = runFilter.value;
        refresh();
    });
    // The export reads the setting when it is clicked, so the checkbox only has
    // to write it; nothing on screen is repainted by turning the opt-in on.
    includeChatNamesInput.checked = settings.includeChatNames === true;
    includeChatNamesInput.addEventListener('change', () => {
        onIncludeChatNamesChange(includeChatNamesInput.checked);
    });
    exportButton.addEventListener('click', () => {
        const file = onExport();
        if (file) saveJsonFile(file.fileName, file.content);
    });

    runStartButton.addEventListener('click', () => {
        // Starting a run adds a window; it deliberately leaves the current view
        // alone, so the drawer never empties itself under the user's cursor. The
        // new run is listed and named as current straight away.
        if (!onStartRun(runLabelInput.value)) return;
        runLabelInput.value = '';
        refresh();
    });

    refresh();

    return { root, refresh };
}

/** One option of the run filter, whose "All runs" entry is the empty value. */
function createOption(value, text) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    return option;
}

/**
 * Saves a generated export through a Blob download. The object URL is revoked on
 * a later task rather than in the same tick, because the browser copies the blob
 * asynchronously and revoking immediately can cancel the download while the
 * drawer reports success.
 *
 * @param {string} fileName
 * @param {string} content
 */
function saveJsonFile(fileName, content) {
    if (typeof Blob !== 'function'
        || typeof globalThis.URL?.createObjectURL !== 'function'
        || typeof document === 'undefined') {
        return;
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

/**
 * One summary card: its title and request counts in the header, one cell per
 * metric, and the note that says why a card has no cost. The source of every
 * number rides on the cell as a data attribute, so a stylesheet can mute an
 * estimate without the drawer inventing a second way to say it.
 *
 * @param {object} card
 * @returns {HTMLElement}
 */
function renderCard(card) {
    const section = document.createElement('section');
    section.className = 'spendbook-card';
    section.dataset.scope = card.scope;

    const header = document.createElement('header');
    header.className = 'spendbook-card-header';
    const title = document.createElement('h4');
    title.className = 'spendbook-card-title';
    title.textContent = card.title;
    const counts = document.createElement('span');
    counts.className = 'spendbook-card-counts';
    counts.textContent = card.detailLabel
        ? `${card.requestsLabel} · ${card.detailLabel}`
        : card.requestsLabel;
    header.append(title, counts);
    section.append(header);

    const metrics = document.createElement('dl');
    metrics.className = 'spendbook-card-metrics';
    for (const metric of card.metrics) metrics.append(renderMetric(metric));
    section.append(metrics);

    if (card.note) {
        const note = document.createElement('small');
        note.className = 'spendbook-card-note';
        note.textContent = card.note;
        section.append(note);
    }
    return section;
}

function renderMetric(metric) {
    const cell = document.createElement('div');
    cell.className = `spendbook-metric spendbook-metric-${metric.key}`;
    cell.dataset.source = metric.source;

    const label = document.createElement('dt');
    label.textContent = metric.label;
    const value = document.createElement('dd');
    value.className = 'spendbook-metric-value';
    value.textContent = metric.value;
    cell.append(label, value);

    if (metric.note) {
        const note = document.createElement('small');
        note.className = 'spendbook-metric-note';
        note.textContent = metric.note;
        cell.append(note);
    }
    return cell;
}

function renderRow(row) {
    const tr = document.createElement('tr');
    tr.dataset.recordId = row.recordId;
    appendCell(tr, 'time', row.timeLabel);
    appendCell(tr, 'origin', row.originLabel);
    appendCell(tr, 'label', row.labelLabel);
    appendCell(tr, 'configuration', row.configurationLabel);
    appendCell(tr, 'provider', row.providerLabel);
    appendCell(tr, 'model', row.modelLabel);
    appendCell(tr, 'prompt', row.promptLabel);
    appendCell(tr, 'completion', row.completionLabel);
    appendCell(tr, 'cost', row.costLabel);
    appendCell(tr, 'saving', row.savingLabel);
    appendPrefixCell(tr, row);
    appendCell(tr, 'latency', row.latencyLabel);
    appendCell(tr, 'status', row.statusLabel);
    appendCell(tr, 'source', row.sourceLabel);
    return tr;
}

/**
 * One comparison row: the configuration's name and request count, then the
 * same metrics the cards carry, so a labelled configuration is read the same
 * way as the chat it was measured in.
 *
 * @param {object} group
 * @returns {HTMLElement}
 */
function renderConfigurationRow(group) {
    const tr = document.createElement('tr');
    tr.dataset.configuration = group.key;
    if (group.isDefault) tr.dataset.default = 'true';

    // The comparison table has its own cell class prefix, so the request
    // table's `.spendbook-cell-*` hooks never match a comparison cell.
    const prefix = 'spendbook-configuration-cell';
    appendCell(tr, 'configuration', group.label, { prefix });

    const requests = appendCell(tr, 'requests', group.requestsLabel, { prefix });
    if (group.detailLabel) {
        const detail = document.createElement('small');
        detail.className = 'spendbook-configuration-requests-detail';
        detail.textContent = group.detailLabel;
        requests.append(detail);
    }

    for (const metric of group.metrics) {
        const cell = appendCell(tr, metric.key, metric.value, { prefix });
        cell.dataset.source = metric.source;
        if (metric.note) {
            const note = document.createElement('small');
            note.className = 'spendbook-configuration-metric-note';
            note.textContent = metric.note;
            cell.append(note);
        }
    }
    return tr;
}

/**
 * The shared-prefix cell. The count is the tokenizer's estimate; the breaker
 * note sits beside it in words, so a row says why it is suspect without a
 * legend to learn.
 *
 * @param {HTMLElement} row
 * @param {object} entry
 * @returns {HTMLElement}
 */
function appendPrefixCell(row, entry) {
    const cell = appendCell(row, 'prefix', entry.sharedPrefixLabel);
    if (!entry.prefixBreakerLabel) return cell;
    const flag = document.createElement('span');
    flag.className = 'spendbook-prefix-flag';
    flag.textContent = entry.prefixBreakerLabel;
    cell.append(flag);
    return cell;
}

function appendCell(row, field, text, { prefix = 'spendbook-cell' } = {}) {
    const cell = document.createElement('td');
    cell.className = `${prefix}-${field}`;
    cell.textContent = text;
    row.append(cell);
    return cell;
}
