/**
 * Spendbook — usage accounting for SillyTavern.
 *
 * Entry module: read settings with defaults merged, open the chat's ledger,
 * install the read-only chat-completion observer while tracking is on, and mount
 * the settings drawer. Observation is wired to SillyTavern's generation events so
 * each request is attributed to the work that caused it.
 */

import { eventSource, event_types, saveMetadata, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { getSanitizedFilename } from '../../../utils.js';
import {
    readSpendbookSettings,
    setIncludeChatNames,
    setPriceTable,
    setTrackingEnabled,
} from './src/settings.js';
import { UsageLedger } from './src/ledger.js';
import { createMessageTokenEstimator, createPromptTokenEstimator } from './src/estimator.js';
import { getUsageObserverHealth, installUsageObserver } from './src/observer.js';
import { noteGenerationEnded, noteGenerationStarted } from './src/origin.js';
import { getConfigurationLabel } from './src/configuration.js';
import { publishSpendbookHost } from './src/host.js';
import { buildUsageExport, usageExportFileName } from './src/export.js';
import { describeImportResult, importableLegacyPrices, readLegacyChat } from './src/importer.js';
import { registerSpendbookCommands } from './src/commands.js';
import { saveJsonFile } from './ui/download.js';
import { mountSpendbookPanel } from './ui/panel.js';

const EXTENSION_FOLDER = 'third-party/Spendbook';

// Published at load, not at mount: another extension may label a request while
// the drawer is still being rendered, and the label is read when a request is
// sent. The surface carries only the two documented host calls.
publishSpendbookHost();

const getChatId = () => getContext()?.chatId ?? null;
const getMetadata = () => getContext()?.chatMetadata ?? null;
const readSettings = () => readSpendbookSettings(extension_settings);

// Local storage is optional: a disabled store loses the all-time totals and the
// debounce backup, never the capture.
function readLocalStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

const ledger = new UsageLedger({
    getChatId,
    getMetadata,
    saveMetadata: () => saveMetadata(),
    storage: readLocalStorage(),
    sanitizeChatFileName: getSanitizedFilename,
});

// Prompt-token estimate for providers that omit usage, and the per-message
// counts behind the prefix fingerprint. The tokenizer is imported lazily, so an
// unavailable one leaves the row "unavailable" instead of breaking the
// extension.
const loadTokenizer = () => import('../../../../scripts/tokenizers.js');
const estimatePromptTokens = createPromptTokenEstimator({ loadTokenizer });
const estimateMessageTokens = createMessageTokenEstimator({ loadTokenizer });

// The mounted drawer, once the template is in: the entry module repaints it and
// hands it a table that changed outside its own edits.
let panel = null;
const refreshPanel = () => panel?.refresh();
let generationStateBound = false;
// The chat open before the last CHAT_CHANGED and the one open now. A rename of
// the open chat reloads it under its new server-sanitized id before the event
// fires, so these two ids are how the ledger recognises that case.
let previousChatId = null;
let activeChatId = null;

function bindGenerationState() {
    if (generationStateBound) return;
    generationStateBound = true;
    eventSource.on(event_types.GENERATION_STARTED, (type, options, dryRun) => {
        noteGenerationStarted(type, { dryRun, quietToLoud: options?.quietToLoud });
    });
    eventSource.on(event_types.GENERATION_ENDED, () => noteGenerationEnded());
    eventSource.on(event_types.GENERATION_STOPPED, () => noteGenerationEnded());
}

/**
 * Install the observer. Only called while tracking is on, so a fresh install
 * with tracking off never wraps fetch at all.
 */
function installObserver() {
    bindGenerationState();
    return installUsageObserver({
        isEnabled: () => readSettings().trackingEnabled,
        getChatId,
        // The run is resolved when the request is sent, so a run started while a
        // request is in flight does not claim it.
        getRunId: () => ledger.currentRunIdFor(getChatId()),
        getConfigurationLabel,
        estimatePromptTokens,
        estimateMessageTokens,
        handleRecord: (record, fingerprint) => ledger.add(record, fingerprint),
        // Refresh on settle, not on record: a skipped capture writes no record
        // but still changes the health line.
        onSettle: () => refreshPanel(),
    });
}

/**
 * The ledger and observer state both surfaces read: the open chat's rows, the
 * observer's state and the aggregates. Each surface adds its own view inputs on
 * top — the drawer its selected run and edited prices, the commands the saved
 * price table — so a number is never drawn from one set of records and reported
 * from another.
 *
 * @returns {object}
 */
function readSnapshot() {
    return {
        chatId: getChatId(),
        records: ledger.recordsFor(getChatId()),
        trackingEnabled: readSettings().trackingEnabled,
        health: getUsageObserverHealth(),
        retention: ledger.retentionFor(getChatId()),
        allTime: ledger.allTimeForView(),
        archive: ledger.archivedFor(getChatId()),
        runs: ledger.runsFor(getChatId()),
    };
}

/**
 * One file for a bug report: the open chat's records, its runs, the counters of
 * the rows the retention cap folded and the all-time totals. The export module
 * owns the published shape and the name opt-in, and the ledger owns the snapshot
 * shape; here they are only brought together, and the drawer does the saving.
 *
 * `includeChatNames` is the caller's policy: the drawer passes the setting, and
 * `/spendbook-export` passes false, so the command can never be the path a chat
 * name leaves the browser.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeChatNames] Add the open chat's name; off by
 *   default.
 * @returns {{fileName: string, content: string}}
 */
function createChatExport({ includeChatNames = false } = {}) {
    const now = Date.now();
    const chatContext = getContext();
    const snapshot = ledger.exportSnapshotFor(getChatId());
    return {
        fileName: usageExportFileName({ now, chatContext, includeChatNames }),
        content: JSON.stringify(
            buildUsageExport({ now, chatContext, includeChatNames, snapshot }),
            null,
            2,
        ),
    };
}

/**
 * Stores a price table in Spendbook's namespace and saves it. The editor's own
 * edits and an import both go through here; an import repaints the editor
 * separately, because it brought rows the editor has never seen.
 *
 * @param {import('./src/prices.js').UsagePriceTable} prices
 */
function persistPrices(prices) {
    setPriceTable(extension_settings, prices);
    saveSettingsDebounced();
}

/**
 * One click of the drawer's Import button: the open chat's VectFox history and
 * the old price table, read from the old namespaces and written only into
 * Spendbook's own. The old keys are left exactly as they are, so a rollback to
 * VectFox still has its ledger, and the old price table is only taken into an
 * empty one.
 *
 * @returns {string} The line the drawer shows.
 */
function importLegacyHistory() {
    const chatId = getChatId();
    if (chatId == null) return '';
    const legacy = readLegacyChat({ metadata: getMetadata(), chatId });
    const counts = legacy ? ledger.importChat(chatId, legacy) : { added: 0, alreadyPresent: 0 };

    const prices = importableLegacyPrices({
        extensionSettings: extension_settings,
        currentPrices: readSettings().prices,
    });
    if (prices) {
        persistPrices(prices);
        // The price editor was mounted with the table the settings had then.
        panel?.setPrices(prices);
    }

    return describeImportResult({ found: !!legacy, ...counts, pricesImported: !!prices });
}

/**
 * Render the drawer template and mount it in the extensions settings panel.
 * @returns {Promise<void>}
 */
async function mountSettingsDrawer() {
    const container = document.getElementById('extensions_settings2');
    if (!container) {
        console.warn('Spendbook: extensions settings container not found; drawer not mounted.');
        return;
    }

    const html = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings');
    panel = mountSpendbookPanel({
        container,
        html,
        settings: readSettings(),
        getSnapshot: readSnapshot,
        onTrackingChange: (trackingEnabled) => {
            setTrackingEnabled(extension_settings, trackingEnabled);
            saveSettingsDebounced();
            if (trackingEnabled) installObserver();
        },
        onResetChat: () => {
            const chatId = getChatId();
            if (chatId == null) return;
            ledger.resetChat(chatId);
            refreshPanel();
        },
        onResetAllTime: () => {
            ledger.resetAllTime();
            refreshPanel();
        },
        onPricesChange: (prices) => persistPrices(prices),
        onStartRun: (label) => ledger.startRun({ chatId: getChatId(), label }),
        onExport: () => createChatExport({ includeChatNames: readSettings().includeChatNames }),
        onImport: () => importLegacyHistory(),
        onIncludeChatNamesChange: (includeChatNames) => {
            setIncludeChatNames(extension_settings, includeChatNames);
            saveSettingsDebounced();
        },
    });
}

/**
 * Follow SillyTavern's chat lifecycle even while tracking is off: the all-time
 * aggregate must lose a deleted chat's bucket, follow a rename, and replay a
 * pending row when a chat is opened again.
 */
function bindChatLifecycle() {
    activeChatId = getChatId();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        previousChatId = activeChatId;
        activeChatId = getChatId();
        ledger.handleChatChanged(activeChatId);
        refreshPanel();
    });

    const handleChatDeleted = (deletedChatId) => {
        ledger.handleChatDeleted(deletedChatId ?? null);
        refreshPanel();
    };
    eventSource.on(event_types.CHAT_DELETED, handleChatDeleted);
    eventSource.on(event_types.GROUP_CHAT_DELETED, handleChatDeleted);

    eventSource.on(event_types.CHAT_RENAMED, async (eventData) => {
        // The ledger strips SillyTavern's `.jsonl` file names back to chat ids
        // and asks the server how it sanitized a name it has not reloaded.
        await ledger.handleChatRenamed(eventData?.oldFileName, eventData?.newFileName, {
            previousChatId,
            currentChatId: activeChatId,
        });
        refreshPanel();
    });

    globalThis.addEventListener('pagehide', () => ledger.flush());
}

/**
 * Where a slash command's text is read. SillyTavern's toast is the only always-on
 * surface for a command run from the chat bar, so the report is shown there,
 * line by line; the message is escaped before its newlines become breaks.
 *
 * @param {string} text
 */
function showSpendbookText(text) {
    const toastr = globalThis.toastr;
    if (!toastr || typeof toastr.info !== 'function') return;

    const html = String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .split('\n')
        .join('<br>');
    toastr.info(html, 'Spendbook', { escapeHtml: false, timeOut: 20000 });
}

/**
 * Register `/spendbook`, `/spendbook-run` and `/spendbook-export`. The call
 * starts here: SillyTavern's parser attributes a command by the extension folder
 * in the registration call stack, so it lands on Spendbook. No callback here can
 * change whether tracking is on — the toggle stays in the drawer.
 */
function registerSlashCommands() {
    const context = getContext();
    registerSpendbookCommands({
        parser: context?.SlashCommandParser ?? null,
        commandClass: context?.SlashCommand ?? null,
        getSnapshot: () => ({ ...readSnapshot(), prices: readSettings().prices }),
        getExport: (options) => createChatExport(options),
        startRun: () => ledger.startRun({ chatId: getChatId() }),
        refresh: refreshPanel,
        saveFile: saveJsonFile,
        notify: showSpendbookText,
    });
}

registerSlashCommands();

jQuery(async () => {
    try {
        // Bind before the async mount: SillyTavern can restore the open chat
        // while the template is still loading, and that switch must be seen.
        bindChatLifecycle();

        if (readSettings().trackingEnabled) installObserver();
        ledger.loadChat(getChatId());
        await mountSettingsDrawer();
        // The chat may have been restored during the mount.
        ledger.loadChat(getChatId());
        refreshPanel();
    } catch (error) {
        console.error('Spendbook: failed to mount the settings drawer.', error);
    }
});
