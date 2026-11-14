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

let refreshPanel = () => {};
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
 * One file for a bug report: the open chat's records, its runs, the counters of
 * the rows the retention cap folded and the all-time totals. The export module
 * owns the published shape and the name opt-in, and the ledger owns the snapshot
 * shape; here they are only brought together, and the drawer does the saving.
 *
 * @returns {{fileName: string, content: string}}
 */
function createChatExport() {
    const now = Date.now();
    const settings = readSettings();
    const chatContext = getContext();
    const snapshot = ledger.exportSnapshotFor(getChatId());
    return {
        fileName: usageExportFileName({ now, chatContext }),
        content: JSON.stringify(
            buildUsageExport({ now, chatContext, includeChatNames: settings.includeChatNames, snapshot }),
            null,
            2,
        ),
    };
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
    const panel = mountSpendbookPanel({
        container,
        html,
        settings: readSettings(),
        getSnapshot: () => ({
            chatId: getChatId(),
            records: ledger.recordsFor(getChatId()),
            trackingEnabled: readSettings().trackingEnabled,
            health: getUsageObserverHealth(),
            retention: ledger.retentionFor(getChatId()),
            allTime: ledger.allTimeForView(),
            archive: ledger.archivedFor(getChatId()),
            runs: ledger.runsFor(getChatId()),
        }),
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
        onPricesChange: (prices) => {
            setPriceTable(extension_settings, prices);
            saveSettingsDebounced();
        },
        onStartRun: (label) => ledger.startRun({ chatId: getChatId(), label }),
        onExport: () => createChatExport(),
        onIncludeChatNamesChange: (includeChatNames) => {
            setIncludeChatNames(extension_settings, includeChatNames);
            saveSettingsDebounced();
        },
    });
    refreshPanel = panel.refresh;
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
