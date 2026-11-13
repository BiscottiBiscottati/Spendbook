/**
 * Spendbook — usage accounting for SillyTavern.
 *
 * Entry module: read settings with defaults merged, mount the drawer in the
 * extensions settings panel, and persist the tracking toggle inside Spendbook's
 * own settings namespace.
 */

import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { readSpendbookSettings, setTrackingEnabled } from './src/settings.js';
import { mountSpendbookPanel } from './ui/panel.js';

const EXTENSION_FOLDER = 'third-party/Spendbook';

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

    mountSpendbookPanel({
        container,
        html,
        settings: readSpendbookSettings(extension_settings),
        onTrackingChange: (trackingEnabled) => {
            setTrackingEnabled(extension_settings, trackingEnabled);
            saveSettingsDebounced();
        },
    });
}

jQuery(async () => {
    try {
        await mountSettingsDrawer();
    } catch (error) {
        console.error('Spendbook: failed to mount the settings drawer.', error);
    }
});
