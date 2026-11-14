import { ACME_PRICED_ROW } from './prices.js';

/**
 * One completed story request the ACME price table prices, with the metadata a
 * record carries beyond its token counts. Shared by the view and slash-command
 * seams so their literals describe the same row.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
export function createAcmeRecord(overrides = {}) {
    return {
        recordId: 'r-1',
        timestamp: 1_700_000_000_000,
        origin: 'story',
        label: null,
        ...ACME_PRICED_ROW,
        latencyMs: 820,
        status: 'ok',
        usageSource: 'measured',
        ...overrides,
    };
}
