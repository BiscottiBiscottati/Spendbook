import { describe, it, expect } from 'vitest';

import { readSpendbookSettings, setTrackingEnabled } from '../src/settings.js';

describe('Spendbook settings', () => {
    it('reads defaults for a fresh install, leaving the shared settings object alone', () => {
        const extensionSettings = { otherExtension: { someSetting: true } };

        const settings = readSpendbookSettings(extensionSettings);

        expect(settings).toEqual({
            trackingEnabled: false,
            prices: { currency: 'USD', updated: '', entries: [] },
            includeChatNames: false,
        });
        expect(extensionSettings.spendbook).toBeUndefined();
    });

    it('fills in keys a saved settings blob is missing', () => {
        const prices = { currency: 'EUR', updated: '2026-11-13', entries: [{ provider: 'acme', model: 'm1' }] };
        const extensionSettings = { spendbook: { trackingEnabled: true, prices } };

        const settings = readSpendbookSettings(extensionSettings);

        expect(settings.trackingEnabled).toBe(true);
        expect(settings.prices).toEqual(prices);
        expect(settings.includeChatNames).toBe(false);
    });

    it('copies saved price entries rather than aliasing them', () => {
        const savedEntry = { provider: 'acme', model: 'm1', output: 1 };
        const extensionSettings = { spendbook: { prices: { entries: [savedEntry] } } };

        const settings = readSpendbookSettings(extensionSettings);
        settings.prices.entries[0].output = 2;

        expect(settings.prices.currency).toBe('USD');
        expect(savedEntry.output).toBe(1);
    });

    it('writes the tracking toggle into Spendbook’s namespace alone', () => {
        const other = { someSetting: true };
        const extensionSettings = { otherExtension: other };

        setTrackingEnabled(extensionSettings, true);

        expect(extensionSettings.spendbook).toEqual({ trackingEnabled: true });
        expect(extensionSettings.otherExtension).toBe(other);
        expect(Object.keys(extensionSettings).sort()).toEqual(['otherExtension', 'spendbook']);
        expect(readSpendbookSettings(extensionSettings).trackingEnabled).toBe(true);
    });
});
