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
import { readSpendbookSettings, setTrackingEnabled } from './src/settings.js';
import { UsageLedger } from './src/ledger.js';
import { getUsageObserverHealth, installUsageObserver } from './src/observer.js';
import { noteGenerationEnded, noteGenerationStarted } from './src/origin.js';
import { mountSpendbookPanel } from './ui/panel.js';

const EXTENSION_FOLDER = 'third-party/Spendbook';

const getChatId = () => getContext()?.chatId ?? null;
const getMetadata = () => getContext()?.chatMetadata ?? null;
const readSettings = () => readSpendbookSettings(extension_settings);

const ledger = new UsageLedger({
    getChatId,
    getMetadata,
    saveMetadata: () => saveMetadata(),
});

let refreshPanel = () => {};
let generationStateBound = false;

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
        handleRecord: (record) => ledger.add(record),
        // Refresh on settle, not on record: a skipped capture writes no record
        // but still changes the health line.
        onSettle: () => refreshPanel(),
    });
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
            records: ledger.recordsFor(getChatId()),
            trackingEnabled: readSettings().trackingEnabled,
            health: getUsageObserverHealth(),
        }),
        onTrackingChange: (trackingEnabled) => {
            setTrackingEnabled(extension_settings, trackingEnabled);
            saveSettingsDebounced();
            if (trackingEnabled) installObserver();
        },
    });
    refreshPanel = panel.refresh;
}

jQuery(async () => {
    try {
        // Bind before the async mount: SillyTavern can restore the open chat
        // while the template is still loading, and that switch must be seen.
        eventSource.on(event_types.CHAT_CHANGED, () => {
            ledger.handleChatChanged(getChatId());
            refreshPanel();
        });

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
