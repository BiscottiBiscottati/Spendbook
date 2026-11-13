/**
 * Drawer smoke: the template mounts into the extensions settings panel and the
 * tracking toggle reflects stored state.
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { mountSpendbookPanel } from '../ui/panel.js';
import { readSpendbookSettings, setTrackingEnabled } from '../src/settings.js';

const templateHtml = readFileSync(join(process.cwd(), 'settings.html'), 'utf8');

function mount({ settings = {}, onTrackingChange = () => {} } = {}) {
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    const container = document.getElementById('extensions_settings2');
    mountSpendbookPanel({ container, html: templateHtml, settings, onTrackingChange });
    return container;
}

describe('Spendbook drawer', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('mounts one Spendbook drawer with a tracking toggle and the privacy note', () => {
        const container = mount({ settings: { trackingEnabled: true } });

        expect(container.querySelectorAll('.inline-drawer')).toHaveLength(1);
        expect(container.querySelector('.inline-drawer').textContent).toContain('Spendbook');
        expect(container.querySelectorAll('#spendbook_tracking_enabled')).toHaveLength(1);
        expect(container.querySelector('.spendbook-privacy-note').textContent).toMatch(/never stores prompt text/i);
    });

    it('shows the stored tracking state', () => {
        const container = mount({ settings: { trackingEnabled: true } });

        expect(container.querySelector('#spendbook_tracking_enabled').checked).toBe(true);
    });

    it('persists the toggle in Spendbook’s namespace and restores it on the next mount', () => {
        const extensionSettings = { otherExtension: { someSetting: false } };
        const onTrackingChange = vi.fn(value => setTrackingEnabled(extensionSettings, value));
        const container = mount({ settings: readSpendbookSettings(extensionSettings), onTrackingChange });

        const toggle = container.querySelector('#spendbook_tracking_enabled');
        expect(toggle.checked).toBe(false);

        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(onTrackingChange).toHaveBeenCalledWith(true);
        expect(extensionSettings.spendbook).toEqual({ trackingEnabled: true });
        expect(extensionSettings.otherExtension).toEqual({ someSetting: false });

        const remounted = mount({ settings: readSpendbookSettings(extensionSettings) });
        expect(remounted.querySelector('#spendbook_tracking_enabled').checked).toBe(true);
    });
});
