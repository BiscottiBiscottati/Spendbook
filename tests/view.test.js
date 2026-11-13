/**
 * View-model seam: records, the folded counters, the price table and observer
 * state in; labels and numbers out. Expected strings and dollars are literals
 * from the ticket, so a bug in the view cannot agree with itself.
 */

import { describe, it, expect } from 'vitest';

import { buildUsageView, describeAllTime, describeUsageTotals } from '../ui/view.js';
import { ACME_PRICES, ACME_PRICED_ROW } from './fixtures/prices.js';

function record(overrides = {}) {
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

describe('Spendbook view — row cost', () => {
    it('shows the cost and saving the price table resolves', () => {
        const view = buildUsageView({ records: [record()], trackingEnabled: true, prices: ACME_PRICES });

        // 400 * 0.003 + 800 * 0.15 + 340 * 0.6 = 325.2 micro-dollars,
        // saving 400 * (0.15 - 0.003) = 58.8 micro-dollars.
        expect(view.rows[0].costLabel).toBe('$0.00032520');
        expect(view.rows[0].savingLabel).toBe('$0.00005880');
    });

    it('shows a placeholder, never zero, when no price row matches', () => {
        const view = buildUsageView({
            records: [record({ provider: 'other', model: 'm9' })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });

        expect(view.rows[0].costLabel).toBe('—');
        expect(view.rows[0].savingLabel).toBe('—');
    });

    it('shows a provider-reported cost and discount as reported, unconverted', () => {
        const view = buildUsageView({
            records: [record({ cost: 0.42, cacheDiscount: 0.07 })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });

        expect(view.rows[0].costLabel).toBe('0.42 reported');
        expect(view.rows[0].savingLabel).toBe('0.07 reported');
    });
});

describe('Spendbook view — failed rows', () => {
    it('shows no dollar figure for a row that never counted toward a total', () => {
        const view = buildUsageView({
            records: [record({ status: 'error', usageSource: 'unavailable', promptTokens: null, cost: 0.42 })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });

        expect(view.rows[0].costLabel).toBe('—');
        expect(view.rows[0].savingLabel).toBe('—');
        expect(view.totals.cost.measured).toBe(0);
    });
});

describe('Spendbook view — all-time line', () => {
    const allTime = {
        totals: { requests: 3, excludedRequests: 1, promptTokens: 2400 },
        chats: 2,
    };

    it('counts tokens across chats without claiming a cost', () => {
        expect(describeAllTime(allTime).label).toBe(
            'All time: 3 completed requests and 1 failed or stopped, across 2 chats · 2,400 prompt tokens.',
        );
    });

    it('says cost is per chat once the user has priced anything', () => {
        expect(buildUsageView({ allTime, trackingEnabled: true, prices: ACME_PRICES }).allTime.label)
            .toBe('All time: 3 completed requests and 1 failed or stopped, across 2 chats · 2,400 prompt tokens. Cost is per chat.');
    });
});

describe('Spendbook view — chat totals', () => {
    it('reports nothing for a chat with no requests', () => {
        const totals = describeUsageTotals({ records: [], prices: ACME_PRICES });

        expect(totals).toMatchObject({ requests: 0, excluded: 0, label: '' });
        expect(totals.cost).toEqual({ measured: 0, measuredRequests: 0, estimated: 0, estimatedRequests: 0, requests: 0 });
        expect(totals.saving).toEqual({ measured: 0, measuredRequests: 0, estimated: 0, estimatedRequests: 0, requests: 0 });
    });

    it('sums the rows into one labelled total', () => {
        const totals = describeUsageTotals({ records: [record()], prices: ACME_PRICES });

        expect(totals.requests).toBe(1);
        expect(totals.promptTokens).toBe(1200);
        expect(totals.cost.estimated).toBeCloseTo(0.0003252, 12);
        expect(totals.cost.estimatedRequests).toBe(1);
        expect(totals.cost.measuredRequests).toBe(0);
        expect(totals.saving.estimated).toBeCloseTo(0.0000588, 12);
        expect(totals.label).toBe(
            'This chat: 1 completed request · 1,200 prompt tokens · $0.00032520 cost · $0.00005880 cache saving.',
        );
    });

    it('says the price table is empty instead of showing a zero cost', () => {
        const totals = describeUsageTotals({ records: [record()], prices: null });

        expect(totals.cost.requests).toBe(0);
        expect(totals.label).toBe(
            'This chat: 1 completed request · 1,200 prompt tokens · no cost — the price table is empty.',
        );
    });

    it('says no price row matched when the table has entries but none for these rows', () => {
        const totals = describeUsageTotals({ records: [record({ provider: 'other', model: 'm9' })], prices: ACME_PRICES });

        expect(totals.label).toBe(
            'This chat: 1 completed request · 1,200 prompt tokens · no cost — no complete price row for these requests.',
        );
    });

    it('says how many requests the cost covers when a price row is missing', () => {
        const totals = describeUsageTotals({
            records: [record(), record({ recordId: 'r-2', provider: 'other', model: 'm9' })],
            prices: ACME_PRICES,
        });

        expect(totals.requests).toBe(2);
        expect(totals.cost.requests).toBe(1);
        expect(totals.label).toContain('$0.00032520 cost for 1 of 2 requests');
    });

    it('marks a provider-reported total as reported instead of pricing it', () => {
        const totals = describeUsageTotals({ records: [record({ cost: 0.42, cacheDiscount: 0.07 })], prices: ACME_PRICES });

        expect(totals.cost).toMatchObject({ measured: 0.42, measuredRequests: 1, estimated: 0, estimatedRequests: 0 });
        expect(totals.label).toBe(
            'This chat: 1 completed request · 1,200 prompt tokens · 0.42 reported cost · 0.07 reported cache saving.',
        );
    });

    it('never adds a reported credit figure to a priced one', () => {
        const totals = describeUsageTotals({
            records: [record({ recordId: 'r-reported', cost: 0.42, cacheDiscount: 0.07 }), record({ recordId: 'r-priced' })],
            prices: ACME_PRICES,
        });

        expect(totals.cost.measured).toBe(0.42);
        expect(totals.cost.estimated).toBeCloseTo(0.0003252, 12);
        expect(totals.label).toBe(
            'This chat: 2 completed requests · 2,400 prompt tokens · '
            + '0.42 reported and $0.00032520 estimated cost · '
            + '0.07 reported and $0.00005880 estimated cache saving.',
        );
    });

    it('says no prompt count was reported rather than blaming the price row', () => {
        const totals = describeUsageTotals({
            records: [record({ promptTokens: null, hitTokens: null, usageSource: 'estimated', estimatedPromptTokens: 900 })],
            prices: ACME_PRICES,
        });

        expect(totals.label).toBe(
            'This chat: 1 completed request · 900 estimated prompt tokens · no cost — these requests reported no prompt count.',
        );
    });

    it('counts failed requests without inventing a plural', () => {
        const totals = describeUsageTotals({
            records: [
                record(),
                record({ recordId: 'r-2', status: 'error', usageSource: 'unavailable', promptTokens: null, hitTokens: null }),
                record({ recordId: 'r-3', status: 'aborted', usageSource: 'unavailable', promptTokens: null, hitTokens: null }),
            ],
            prices: ACME_PRICES,
        });

        expect(totals.excluded).toBe(2);
        expect(totals.label).toContain('1 completed request and 2 failed or stopped ·');
    });

    it('says how many requests a cache saving covers when only some are priced', () => {
        const totals = describeUsageTotals({
            records: [record(), record({ recordId: 'r-2', provider: 'other', model: 'm9' })],
            prices: ACME_PRICES,
        });

        // Cost and saving both cover one of the two requests; or the saving
        // note would let a partial figure look complete.
        expect(totals.label).toContain('$0.00032520 cost for 1 of 2 requests');
        expect(totals.label).toContain('$0.00005880 cache saving for 1 of 2 requests');
    });

    it('prices the rows the retention cap folded with the table in force now', () => {
        // The counters a folded copy of the fixture row leaves behind, written
        // out so the view cannot agree with a bug in the folding maths.
        const archive = {
            total: { requests: 1, measuredRequests: 1, promptTokens: 1200, hitTokens: 400, completionTokens: 340 },
            byModel: {
                'acme\u0000m1': {
                    provider: 'acme',
                    model: 'm1',
                    unpricedCost: { requests: 1, promptTokens: 1200, hitTokens: 400, completionTokens: 340 },
                    unpricedSaving: { requests: 1, promptTokens: 1200, hitTokens: 400, completionTokens: 340 },
                    reportedCost: 0,
                    reportedCostRequests: 0,
                    reportedSaving: 0,
                    reportedSavingRequests: 0,
                },
            },
        };

        const totals = describeUsageTotals({ records: [record({ recordId: 'r-new' })], archive, prices: ACME_PRICES });

        expect(totals.requests).toBe(2);
        expect(totals.promptTokens).toBe(2400);
        expect(totals.cost.estimated).toBeCloseTo(0.0006504, 12);
        expect(totals.saving.estimated).toBeCloseTo(0.0001176, 12);
    });

    it('reprices a folded row when the price table changes', () => {
        const archive = {
            total: { requests: 1, measuredRequests: 1, promptTokens: 1200, hitTokens: 400, completionTokens: 340 },
            byModel: {
                'acme\u0000m1': {
                    provider: 'acme',
                    model: 'm1',
                    unpricedCost: { requests: 1, promptTokens: 1200, hitTokens: 400, completionTokens: 340 },
                    unpricedSaving: { requests: 1, promptTokens: 1200, hitTokens: 400, completionTokens: 340 },
                },
            },
        };
        const repriced = {
            currency: 'USD',
            updated: '',
            entries: [{ provider: 'acme', model: 'm1', hit: 0.003, miss: 0.3, output: 0.6, cacheWrite: null }],
        };

        const totals = describeUsageTotals({ records: [], archive, prices: repriced });

        // 400 * 0.003 + 800 * 0.3 + 340 * 0.6 = 445.2 micro-dollars.
        expect(totals.cost.estimated).toBeCloseTo(0.0004452, 12);
    });

    it('keeps a folded provider-reported figure as reported', () => {
        const archive = {
            total: { requests: 1, measuredRequests: 1, promptTokens: 1200 },
            byModel: {
                'acme\u0000m1': {
                    provider: 'acme',
                    model: 'm1',
                    unpricedCost: {},
                    unpricedSaving: {},
                    reportedCost: 0.42,
                    reportedCostRequests: 1,
                    reportedSaving: 0.07,
                    reportedSavingRequests: 1,
                },
            },
        };

        const totals = describeUsageTotals({ records: [], archive, prices: ACME_PRICES });

        expect(totals.cost.measured).toBe(0.42);
        expect(totals.cost.estimated).toBe(0);
        expect(totals.saving.measured).toBe(0.07);
        expect(totals.label).toBe(
            'This chat: 1 completed request · 1,200 prompt tokens · 0.42 reported cost · 0.07 reported cache saving.',
        );
    });

    it('keeps measured and estimated prompt tokens apart and counts the failures', () => {
        const totals = describeUsageTotals({
            records: [
                record({ promptTokens: null, hitTokens: null, usageSource: 'estimated', estimatedPromptTokens: 240 }),
                record({ recordId: 'r-2', status: 'error', usageSource: 'unavailable', promptTokens: null, hitTokens: null, completionTokens: null }),
            ],
            prices: ACME_PRICES,
        });

        expect(totals.requests).toBe(1);
        expect(totals.excluded).toBe(1);
        expect(totals.label).toBe(
            'This chat: 1 completed request and 1 failed or stopped · 240 estimated prompt tokens · no cost — these requests reported no prompt count.',
        );
    });
});
