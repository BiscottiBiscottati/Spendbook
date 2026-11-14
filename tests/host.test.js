/**
 * Host-surface seam: the one page-level object another extension may reach
 * without importing Spendbook. It carries the two documented calls — the
 * per-request internal mark and the configuration label — and nothing else, so
 * a host cannot end up coupled to Spendbook's internals through it.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { getConfigurationLabel, setConfigurationLabel } from '../src/configuration.js';
import { publishSpendbookHost } from '../src/host.js';
import { resolveUsageOrigin } from '../src/origin.js';

describe('Spendbook host surface', () => {
    beforeEach(() => {
        setConfigurationLabel(null);
    });

    it('publishes exactly the two documented calls under one page name', () => {
        const page = {};
        const surface = publishSpendbookHost({ target: page });

        expect(page.Spendbook).toBe(surface);
        expect(Object.keys(surface).sort()).toEqual(['markInternalRequest', 'setConfigurationLabel']);
    });

    it('sets the label a request sent from now on carries', () => {
        const page = {};
        publishSpendbookHost({ target: page });

        page.Spendbook.setConfigurationLabel('  after  ');
        expect(getConfigurationLabel()).toBe('after');

        page.Spendbook.setConfigurationLabel(null);
        expect(getConfigurationLabel()).toBeNull();
    });

    it('marks a request internal with its label through the surface', () => {
        const page = {};
        publishSpendbookHost({ target: page });

        const init = { method: 'POST', body: '{}' };
        expect(page.Spendbook.markInternalRequest(init, 'ExampleFeature')).toBe(init);
        expect(resolveUsageOrigin(init)).toEqual({ origin: 'internal', label: 'ExampleFeature' });
    });

    it('publishes nothing onto a target it cannot write to', () => {
        expect(publishSpendbookHost({ target: null })).toBeNull();
    });
});
