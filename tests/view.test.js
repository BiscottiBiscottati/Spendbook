/**
 * View-model seam: records, the folded counters, the price table and observer
 * state in; labels and numbers out. Expected strings and dollars are literals
 * from the ticket, so a bug in the view cannot agree with itself.
 */

import { describe, it, expect } from 'vitest';

import { buildUsageView, describeAllTime } from '../ui/view.js';
import { addRecordToUsageArchive, createUsageArchive } from '../src/stats.js';
import { ACME_PRICES, ACME_PRICED_ROW } from './fixtures/prices.js';
import { CHAT_RUNS } from './fixtures/runs.js';

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
        // It never counted toward a total, so no card prices it — but the card
        // above the table still accounts for the row.
        expect(view.cards).toHaveLength(1);
        expect(metric(view.cards[0], 'cost').value).toBe('—');
    });
});

/**
 * One metric of one card, so a test reads as "the card's cached count" rather
 * than as an index into an array.
 */
function metric(card, key) {
    return card.metrics.find((entry) => entry.key === key);
}

describe('Spendbook view — cards', () => {
    it('draws no card for a chat with no requests', () => {
        const view = buildUsageView({ records: [], trackingEnabled: true, prices: ACME_PRICES });

        expect(view.cards).toEqual([]);
        expect(view.empty).toBe(true);
    });

    it('draws one overall card for one request', () => {
        const view = buildUsageView({ records: [record()], trackingEnabled: true, prices: ACME_PRICES });
        const [card] = view.cards;

        expect(view.cards.map((entry) => entry.scope)).toEqual(['all', 'story']);
        expect(card).toMatchObject({ scope: 'all', title: 'This chat', requestsLabel: '1 completed request', detailLabel: '' });
        expect(metric(card, 'prompt')).toMatchObject({ value: '1,200', source: 'measured' });
        expect(metric(card, 'cached')).toMatchObject({ value: '400', source: 'measured' });
        expect(metric(card, 'hitRate')).toMatchObject({ value: '33.3%', source: 'measured' });
        expect(metric(card, 'completion')).toMatchObject({ value: '340', source: 'measured' });
        expect(metric(card, 'coverage')).toMatchObject({ value: '100%', source: 'measured' });
        expect(metric(card, 'cost')).toMatchObject({ value: '$0.00032520', source: 'estimated' });
        expect(metric(card, 'saving')).toMatchObject({ value: '$0.00005880', source: 'estimated' });
    });

    it('counts many requests into one card', () => {
        const view = buildUsageView({
            records: [
                record(),
                record({ recordId: 'r-2' }),
                record({ recordId: 'r-3', completionTokens: null, totalTokens: null }),
            ],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });
        const [card] = view.cards;

        expect(card.requestsLabel).toBe('3 completed requests');
        expect(metric(card, 'prompt').value).toBe('3,600');
        expect(metric(card, 'cached').value).toBe('1,200');
        expect(metric(card, 'completion').value).toBe('680');
        expect(metric(card, 'hitRate').value).toBe('33.3%');
    });

    it('shows an unreported column as a placeholder, never as zero', () => {
        const view = buildUsageView({
            records: [record({
                usageSource: 'unavailable',
                promptTokens: null,
                hitTokens: null,
                completionTokens: null,
                totalTokens: null,
            })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });
        const [card] = view.cards;

        for (const key of ['prompt', 'cached', 'hitRate', 'completion', 'total', 'coverage', 'cost', 'saving']) {
            expect(metric(card, key).value).toBe('—');
        }
        expect(card.requestsLabel).toBe('1 completed request');
    });

    it('shows an estimated prompt with its own mark and no invented coverage', () => {
        const view = buildUsageView({
            records: [record({
                usageSource: 'estimated',
                promptTokens: null,
                hitTokens: null,
                completionTokens: null,
                totalTokens: null,
                estimatedPromptTokens: 900,
            })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });
        const [card] = view.cards;

        expect(metric(card, 'prompt')).toMatchObject({ value: '~900', source: 'estimated' });
        expect(metric(card, 'coverage')).toMatchObject({ value: '0%', source: 'estimated' });
        expect(metric(card, 'hitRate').value).toBe('—');
        expect(card.note).toBe('no cost — these requests reported no prompt count');
    });

    it('shows the measured prompt and the estimate beside it', () => {
        const view = buildUsageView({
            records: [
                record(),
                record({ recordId: 'r-2', usageSource: 'estimated', promptTokens: null, hitTokens: null, estimatedPromptTokens: 240 }),
            ],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });
        const [card] = view.cards;

        expect(metric(card, 'prompt')).toMatchObject({ value: '1,200', source: 'measured', note: '~240 estimated' });
        // 1,200 of 1,440 prompt tokens were reported.
        expect(metric(card, 'coverage').value).toBe('83.3%');
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

describe('Spendbook view — card caveats', () => {
    it('counts a chat whose only request failed in the overall card', () => {
        const view = buildUsageView({
            records: [record({ status: 'error', usageSource: 'unavailable', promptTokens: null, hitTokens: null })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });
        const [card] = view.cards;

        // The row is in the table, so the numbers above it must not pretend the
        // chat is empty; a failed request is in no denominator, so every metric
        // has no figure to show.
        expect(view.rows).toHaveLength(1);
        expect(card).toMatchObject({
            scope: 'all',
            requestsLabel: '1 failed or stopped request',
            detailLabel: '',
            note: '',
        });
        for (const metricEntry of card.metrics) expect(metricEntry.value).toBe('—');
    });

    it('does not card an origin whose only row failed, but counts it above the table', () => {
        const view = buildUsageView({
            records: [
                record(),
                record({
                    recordId: 'r-2',
                    origin: 'internal',
                    status: 'error',
                    usageSource: 'unavailable',
                    promptTokens: null,
                    hitTokens: null,
                }),
            ],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });
        const [overall, story] = view.cards;

        expect(view.cards.map((card) => card.scope)).toEqual(['all', 'story']);
        expect(overall.detailLabel).toBe('1 failed or stopped request');
        expect(story.detailLabel).toBe('');
        expect(story.requestsLabel).toBe('1 completed request');
    });

    it('sums the rows into one card', () => {
        const [card] = buildUsageView({ records: [record()], trackingEnabled: true, prices: ACME_PRICES }).cards;

        expect(card.requestsLabel).toBe('1 completed request');
        expect(metric(card, 'prompt').value).toBe('1,200');
        expect(metric(card, 'cost')).toEqual({ key: 'cost', label: 'Cost', value: '$0.00032520', source: 'estimated', note: '' });
        expect(metric(card, 'saving').value).toBe('$0.00005880');
    });

    it('says the price table is empty instead of showing a zero cost', () => {
        const [card] = buildUsageView({ records: [record()], trackingEnabled: true, prices: null }).cards;

        expect(metric(card, 'cost')).toMatchObject({ value: '—', source: 'unavailable' });
        expect(card.note).toBe('no cost — the price table is empty');
    });

    it('says no price row matched when the table has entries but none for these rows', () => {
        const [card] = buildUsageView({
            records: [record({ provider: 'other', model: 'm9' })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        }).cards;

        expect(metric(card, 'cost').value).toBe('—');
        expect(card.note).toBe('no cost — no complete price row for these requests');
    });

    it('says how many requests the cost covers when a price row is missing', () => {
        const [card] = buildUsageView({
            records: [record(), record({ recordId: 'r-2', provider: 'other', model: 'm9' })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        }).cards;

        expect(metric(card, 'cost')).toMatchObject({ value: '$0.00032520', note: 'for 1 of 2 requests' });
        // Or the saving note would let a partial figure look complete.
        expect(metric(card, 'saving').note).toBe('for 1 of 2 requests');
    });

    it('marks a provider-reported amount as reported instead of pricing it', () => {
        const [card] = buildUsageView({
            records: [record({ cost: 0.42, cacheDiscount: 0.07 })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        }).cards;

        expect(metric(card, 'cost')).toMatchObject({ value: '0.42 reported', source: 'measured', note: '' });
        expect(metric(card, 'saving')).toMatchObject({ value: '0.07 reported', source: 'measured' });
        expect(card.note).toBe('');
    });

    it('never adds a reported credit figure to a priced one', () => {
        const [card] = buildUsageView({
            records: [record({ recordId: 'r-reported', cost: 0.42, cacheDiscount: 0.07 }), record({ recordId: 'r-priced' })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        }).cards;

        expect(metric(card, 'cost').value).toBe('0.42 reported and $0.00032520 estimated');
        expect(metric(card, 'cost').source).toBe('estimated');
        expect(metric(card, 'saving').value).toBe('0.07 reported and $0.00005880 estimated');
    });

    it('counts failed requests in the card header without inventing a plural', () => {
        const [card] = buildUsageView({
            records: [
                record(),
                record({ recordId: 'r-2', status: 'error', usageSource: 'unavailable', promptTokens: null, hitTokens: null }),
                record({ recordId: 'r-3', status: 'aborted', usageSource: 'unavailable', promptTokens: null, hitTokens: null }),
            ],
            trackingEnabled: true,
            prices: ACME_PRICES,
        }).cards;

        expect(card.requestsLabel).toBe('1 completed request');
        expect(card.detailLabel).toBe('2 failed or stopped requests');
    });

    it('keeps measured and estimated prompt tokens apart and counts the failures', () => {
        const [card] = buildUsageView({
            records: [
                record({ promptTokens: null, hitTokens: null, usageSource: 'estimated', estimatedPromptTokens: 240 }),
                record({ recordId: 'r-2', status: 'error', usageSource: 'unavailable', promptTokens: null, hitTokens: null, completionTokens: null }),
            ],
            trackingEnabled: true,
            prices: ACME_PRICES,
        }).cards;

        expect(metric(card, 'prompt')).toMatchObject({ value: '~240', source: 'estimated' });
        expect(card.detailLabel).toBe('1 failed or stopped request');
        expect(card.note).toBe('no cost — these requests reported no prompt count');
    });

    it('prices the rows the retention cap folded with the table in force now', () => {
        // The counters a folded copy of the fixture row leaves behind, written
        // out so the view cannot agree with a bug in the folding maths.
        const archive = {
            total: { requests: 1, measuredRequests: 1, promptTokens: 1200, hitTokens: 400, completionTokens: 340 },
            byModel: {
                'acme\u0000m1\u0000story': {
                    provider: 'acme',
                    model: 'm1',
                    origin: 'story',
                    unpricedCost: { requests: 1, promptTokens: 1200, hitTokens: 400, completionTokens: 340 },
                    unpricedSaving: { requests: 1, promptTokens: 1200, hitTokens: 400, completionTokens: 340 },
                    reportedCost: 0,
                    reportedCostRequests: 0,
                    reportedSaving: 0,
                    reportedSavingRequests: 0,
                },
            },
        };

        const [card] = buildUsageView({
            records: [record({ recordId: 'r-new' })],
            trackingEnabled: true,
            archive,
            prices: ACME_PRICES,
        }).cards;

        expect(card.requestsLabel).toBe('2 completed requests');
        expect(metric(card, 'prompt').value).toBe('2,400');
        expect(metric(card, 'cost').value).toBe('$0.00065040');
        expect(metric(card, 'saving').value).toBe('$0.00011760');
    });

    it('reprices a folded row when the price table changes', () => {
        const archive = {
            total: { requests: 1, measuredRequests: 1, promptTokens: 1200, hitTokens: 400, completionTokens: 340 },
            byModel: {
                'acme\u0000m1\u0000story': {
                    provider: 'acme',
                    model: 'm1',
                    origin: 'story',
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

        const [card] = buildUsageView({ records: [], trackingEnabled: true, archive, prices: repriced }).cards;

        // 400 * 0.003 + 800 * 0.3 + 340 * 0.6 = 445.2 micro-dollars.
        expect(metric(card, 'cost').value).toBe('$0.00044520');
    });

    it('keeps a folded provider-reported figure as reported', () => {
        const archive = {
            total: { requests: 1, measuredRequests: 1, promptTokens: 1200 },
            byModel: {
                'acme\u0000m1\u0000story': {
                    provider: 'acme',
                    model: 'm1',
                    origin: 'story',
                    unpricedCost: {},
                    unpricedSaving: {},
                    reportedCost: 0.42,
                    reportedCostRequests: 1,
                    reportedSaving: 0.07,
                    reportedSavingRequests: 1,
                },
            },
        };

        const [card] = buildUsageView({ records: [], trackingEnabled: true, archive, prices: ACME_PRICES }).cards;

        expect(metric(card, 'cost')).toMatchObject({ value: '0.42 reported', source: 'measured' });
        expect(metric(card, 'saving')).toMatchObject({ value: '0.07 reported', source: 'measured' });
    });
});

describe('Spendbook view — per-origin cards', () => {
    it('draws one card per origin in a fixed order', () => {
        const view = buildUsageView({
            records: [
                record({ recordId: 'r-1', origin: 'internal' }),
                record({ recordId: 'r-2', origin: 'story' }),
                record({ recordId: 'r-3', origin: 'quiet' }),
            ],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });

        expect(view.cards.map((card) => card.scope)).toEqual(['all', 'story', 'quiet', 'internal']);
        expect(view.cards.map((card) => card.title)).toEqual(['This chat', 'Story', 'Quiet', 'Internal']);
    });

    it('agrees with the rows below it, folded rows included', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record({
            ...ACME_PRICED_ROW,
            recordId: 'r-folded',
            origin: 'internal',
            promptTokens: 500,
            hitTokens: 100,
            completionTokens: 200,
        }));

        const view = buildUsageView({
            records: [record({ recordId: 'r-visible', origin: 'story' })],
            trackingEnabled: true,
            archive,
            prices: ACME_PRICES,
        });
        const [overall, story, internal] = view.cards;

        expect(view.cards.map((card) => card.scope)).toEqual(['all', 'story', 'internal']);
        // The overall card is the two origin cards added up — the visible row
        // and the row the cap folded.
        expect(metric(overall, 'prompt').value).toBe('1,700');
        expect(metric(story, 'prompt').value).toBe('1,200');
        expect(metric(internal, 'prompt').value).toBe('500');
        // 100 * 0.003 + 400 * 0.15 + 200 * 0.6 = 180.3 micro-dollars.
        expect(metric(internal, 'cost').value).toBe('$0.00018030');
        expect(metric(story, 'cost').value).toBe('$0.00032520');
        expect(metric(overall, 'cost').value).toBe('$0.00050550');
    });

    it('keeps a folded row out of an origin that did not send it', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record({ ...ACME_PRICED_ROW, recordId: 'r-folded', origin: 'internal' }));

        const view = buildUsageView({
            records: [record({ recordId: 'r-visible', origin: 'story' })],
            trackingEnabled: true,
            archive,
            prices: ACME_PRICES,
        });
        const [, story, internal] = view.cards;

        expect(story.requestsLabel).toBe('1 completed request');
        expect(metric(story, 'cost').value).toBe('$0.00032520');
        expect(internal.requestsLabel).toBe('1 completed request');
        expect(metric(internal, 'cost').value).toBe('$0.00032520');
    });

    it('counts many requests into the card of their own origin', () => {
        const view = buildUsageView({
            records: [
                record({ recordId: 'r-1' }),
                record({ recordId: 'r-2' }),
                record({ recordId: 'r-3', origin: 'internal' }),
            ],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });
        const [overall, story, internal] = view.cards;

        expect(view.cards.map((card) => card.scope)).toEqual(['all', 'story', 'internal']);
        expect(overall.requestsLabel).toBe('3 completed requests');
        expect(metric(overall, 'prompt').value).toBe('3,600');
        expect(story.requestsLabel).toBe('2 completed requests');
        expect(metric(story, 'prompt').value).toBe('2,400');
        expect(internal.requestsLabel).toBe('1 completed request');
        expect(metric(internal, 'prompt').value).toBe('1,200');
    });

    it('shows the output and total an older archive carried without its counts', () => {
        // A counter persisted before the counts existed still knows its sums;
        // the card must show them instead of claiming nothing was reported.
        const archive = {
            total: {
                requests: 1,
                measuredRequests: 1,
                coveredRequests: 1,
                promptTokens: 1200,
                completionTokens: 340,
                totalTokens: 1540,
            },
            byModel: {},
        };

        const [card] = buildUsageView({ records: [], trackingEnabled: true, archive, prices: ACME_PRICES }).cards;

        expect(metric(card, 'prompt').value).toBe('1,200');
        expect(metric(card, 'completion').value).toBe('340');
        expect(metric(card, 'total').value).toBe('1,540');
    });

    it('weights the hit rate across a card’s rows instead of averaging percentages', () => {
        const view = buildUsageView({
            records: [
                record({ recordId: 'r-1', promptTokens: 10_000, hitTokens: 9_000 }),
                record({ recordId: 'r-2', promptTokens: 100, hitTokens: 0 }),
            ],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });
        const [, story] = view.cards;

        // The per-row rates are 90% and 0%; the card reports the cached share
        // of the prompt actually billed.
        expect(metric(story, 'hitRate').value).toBe('89.1%');
        expect(metric(story, 'hitRate').value).not.toBe('45%');
    });

    it('says which part of the prompt the hit rate covers', () => {
        const view = buildUsageView({
            records: [
                record({ recordId: 'r-1', promptTokens: 1000, hitTokens: 500 }),
                record({ recordId: 'r-2', promptTokens: 9000, hitTokens: null }),
            ],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });
        const [, story] = view.cards;

        expect(metric(story, 'hitRate')).toMatchObject({ value: '50%', note: '1,000 of 10,000 prompt tokens' });
        expect(metric(story, 'coverage').value).toBe('100%');
    });
});

describe('Spendbook view — measurement runs', () => {
    const runs = CHAT_RUNS;

    it('lists every run, newest first, and keeps the current one visible', () => {
        const view = buildUsageView({ records: [record()], trackingEnabled: true, prices: ACME_PRICES, runs });

        expect(view.runs.items.map((item) => item.label)).toEqual(['after', 'before']);
        expect(view.runs.items.map((item) => item.isCurrent)).toEqual([true, false]);
        expect(view.runs.selectedRunId).toBeNull();
        expect(view.runs.currentLabel).toMatch(/^Current run: after · started /);
        expect(view.runs.currentLabel).toMatch(/\d{2}:\d{2}/);
    });

    it('says requests belong to no run before the first one starts', () => {
        const view = buildUsageView({ records: [record()], trackingEnabled: true, prices: ACME_PRICES });

        expect(view.runs.items).toEqual([]);
        expect(view.runs.currentLabel).toBe('No run started yet — requests belong to no run until you start one.');
    });

    it('says no run is current when the chat lists runs but names none', () => {
        const view = buildUsageView({
            records: [record({ runId: 'run-1' })],
            trackingEnabled: true,
            prices: ACME_PRICES,
            runs: { runs: runs.runs, currentRunId: null },
        });

        expect(view.runs.items).toHaveLength(2);
        expect(view.runs.items.some((item) => item.isCurrent)).toBe(false);
        expect(view.runs.currentLabel).toBe('No current run — requests belong to no run until you start one.');
    });

    it('filters the table and the cards to one run while the bar keeps every run', () => {
        const records = [
            record({ recordId: 'r-run2', runId: 'run-2', promptTokens: 2000 }),
            record({ recordId: 'r-run1', runId: 'run-1', promptTokens: 1200 }),
            record({ recordId: 'r-before', runId: null, promptTokens: 100 }),
        ];

        const filtered = buildUsageView({
            records,
            trackingEnabled: true,
            prices: ACME_PRICES,
            runs,
            selectedRunId: 'run-1',
        });

        expect(filtered.rows.map((row) => row.recordId)).toEqual(['r-run1']);
        expect(filtered.runs.items.map((item) => item.label)).toEqual(['after', 'before']);
        expect(filtered.runs.selectedRunId).toBe('run-1');
        expect(filtered.cards[0].title).toBe('This run');
        expect(metric(filtered.cards[0], 'prompt').value).toBe('1,200');
        expect(metric(filtered.cards[0], 'cached').value).toBe('400');

        const all = buildUsageView({ records, trackingEnabled: true, prices: ACME_PRICES, runs });
        expect(all.rows.map((row) => row.recordId)).toEqual(['r-run2', 'r-run1', 'r-before']);
        expect(all.cards[0].title).toBe('This chat');
        expect(metric(all.cards[0], 'prompt').value).toBe('3,300');
    });

    it('leaves the folded counters out of a run and says so', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record({ recordId: 'r-folded' }));
        const records = [record({ recordId: 'r-run1', runId: 'run-1', promptTokens: 500, hitTokens: 100 })];
        const retention = { limit: 500, retained: 1, total: 2 };

        const filtered = buildUsageView({
            records,
            trackingEnabled: true,
            archive,
            retention,
            prices: ACME_PRICES,
            runs,
            selectedRunId: 'run-1',
        });

        // The folded copy of the fixture row would add 1,200 prompt tokens.
        expect(metric(filtered.cards[0], 'prompt').value).toBe('500');
        expect(filtered.retention.label).toBe(
            'Retention: this view covers one run — 1 folded row cannot be attributed to a run, so it is left out.',
        );

        const all = buildUsageView({ records, trackingEnabled: true, archive, retention, prices: ACME_PRICES, runs });
        expect(metric(all.cards[0], 'prompt').value).toBe('1,700');
    });

    it('explains a run with no folded rows without inventing an exclusion', () => {
        const view = buildUsageView({
            records: [record({ runId: 'run-1' })],
            trackingEnabled: true,
            retention: { limit: 500, retained: 1, total: 1 },
            prices: ACME_PRICES,
            runs,
            selectedRunId: 'run-1',
        });

        expect(view.retention.label).toBe(
            'Retention: this view covers one run — rows the cap folds cannot be attributed to a run, so a run’s view leaves them out.',
        );
    });

    it('tells an empty run apart from a chat with nothing recorded', () => {
        const view = buildUsageView({
            records: [record({ recordId: 'r-run1', runId: 'run-1' })],
            trackingEnabled: true,
            prices: ACME_PRICES,
            runs,
            selectedRunId: 'run-2',
        });

        expect(view.rows).toEqual([]);
        expect(view.empty).toBe(true);
        expect(view.emptyMessage).toBe(
            'No requests recorded in this run yet. Send a message while the run is open to fill the table.',
        );
    });

    it('narrows the per-origin cards to the run too', () => {
        const records = [
            record({ recordId: 'r-1', runId: 'run-1', origin: 'story', promptTokens: 1000, hitTokens: 500 }),
            record({ recordId: 'r-2', runId: 'run-1', origin: 'internal', promptTokens: 300, hitTokens: 60 }),
            record({ recordId: 'r-3', runId: 'run-2', origin: 'internal', promptTokens: 999 }),
        ];

        const view = buildUsageView({
            records,
            trackingEnabled: true,
            prices: ACME_PRICES,
            runs,
            selectedRunId: 'run-1',
        });

        expect(view.cards.map((card) => card.title)).toEqual(['This run', 'Story', 'Internal']);
        expect(metric(view.cards.find((card) => card.scope === 'internal'), 'prompt').value).toBe('300');
    });

    it('falls back to all runs when the selected run is not listed', () => {
        const view = buildUsageView({
            records: [record({ runId: null })],
            trackingEnabled: true,
            prices: ACME_PRICES,
            runs,
            selectedRunId: 'run-gone',
        });

        expect(view.runs.selectedRunId).toBeNull();
        expect(view.rows).toHaveLength(1);
    });
});

describe('Spendbook view — prefix diagnostics', () => {
    it('shows the shared prefix as an estimate, marked with a tilde', () => {
        const view = buildUsageView({
            records: [record({ sharedPrefixTokens: 2200 })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });

        // The count comes from the tokenizer, never from the provider, so it is
        // marked the way an estimated prompt is.
        expect(view.rows[0].sharedPrefixLabel).toBe('~2,200');
        expect(view.rows[0].prefixBreakerLabel).toBe('');
    });

    it('shows a placeholder when there is no comparable prior request', () => {
        const view = buildUsageView({
            records: [record({ sharedPrefixTokens: null })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });

        expect(view.rows[0].sharedPrefixLabel).toBe('—');
        expect(view.rows[0].prefixBreakerLabel).toBe('');
    });

    it('names a suspected prefix breaker in words', () => {
        const view = buildUsageView({
            records: [record({
                hitTokens: 0,
                sharedPrefixTokens: 2200,
                possiblePrefixBreaker: true,
            })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });

        expect(view.rows[0].sharedPrefixLabel).toBe('~2,200');
        expect(view.rows[0].prefixBreakerLabel).toBe('Possible prefix breaker');
    });

    it('does not flag a zero-hit row whose shared prefix is short', () => {
        const view = buildUsageView({
            // A row captured before the flag existed carries no field at all.
            records: [record({ hitTokens: 0, sharedPrefixTokens: 780 })],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });

        expect(view.rows[0].sharedPrefixLabel).toBe('~780');
        expect(view.rows[0].prefixBreakerLabel).toBe('');
    });
});

describe('Spendbook view — configuration comparison', () => {
    it('compares the labelled configurations side by side, default first', () => {
        const view = buildUsageView({
            records: [
                record({ recordId: 'r-1', configuration: null }),
                record({
                    recordId: 'r-2',
                    configuration: 'batch-8',
                    promptTokens: 800,
                    hitTokens: 800,
                    completionTokens: 100,
                    totalTokens: 900,
                }),
            ],
            trackingEnabled: true,
            prices: ACME_PRICES,
        });

        expect(view.configurations.groups.map((group) => group.label)).toEqual(['default', 'batch-8']);
        const [base, after] = view.configurations.groups;
        expect(base.isDefault).toBe(true);
        expect(after.isDefault).toBe(false);
        expect(base.requestsLabel).toBe('1 completed request');
        expect(after.requestsLabel).toBe('1 completed request');

        expect(metric(base, 'prompt').value).toBe('1,200');
        expect(metric(base, 'completion').value).toBe('340');
        expect(metric(base, 'hitRate').value).toBe('33.3%');
        expect(metric(base, 'cost').value).toBe('$0.00032520');

        // 800 cached tokens at $0.003/M and 100 output tokens at $0.60/M:
        // 2.4 micro-dollars of hits plus 60 micro-dollars of output.
        expect(metric(after, 'prompt').value).toBe('800');
        expect(metric(after, 'completion').value).toBe('100');
        expect(metric(after, 'hitRate').value).toBe('100%');
        expect(metric(after, 'cost').value).toBe('$0.00006240');
    });

    it('keeps a row unlabelled only when no host set a configuration', () => {
        const view = buildUsageView({
            records: [
                record({ recordId: 'r-1', configuration: null }),
                record({ recordId: 'r-2', configuration: '  batch-8  ' }),
            ],
            trackingEnabled: true,
        });

        expect(view.rows.map((row) => row.configurationLabel)).toEqual(['default', 'batch-8']);
        expect(view.configurations.groups.map((group) => group.label).sort()).toEqual(['batch-8', 'default']);
    });

    it('folds the evicted rows into their configuration group', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record({
            ...ACME_PRICED_ROW,
            recordId: 'r-folded',
            configuration: 'batch-8',
        }));

        const view = buildUsageView({
            records: [],
            trackingEnabled: true,
            archive,
            prices: ACME_PRICES,
        });

        expect(view.configurations.groups).toHaveLength(1);
        const [group] = view.configurations.groups;
        expect(group.label).toBe('batch-8');
        expect(group.requestsLabel).toBe('1 completed request');
        expect(metric(group, 'prompt').value).toBe('1,200');
        expect(metric(group, 'hitRate').value).toBe('33.3%');
        expect(metric(group, 'cost').value).toBe('$0.00032520');
    });

    it('shows no comparison at all when nothing was recorded', () => {
        const view = buildUsageView({ records: [], trackingEnabled: true });

        expect(view.configurations.groups).toEqual([]);
        expect(view.configurations.empty).toBe(true);
    });

    it('compares only the run’s configurations while a run is shown', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record({ ...ACME_PRICED_ROW, recordId: 'r-folded', configuration: 'before' }));

        const view = buildUsageView({
            records: [
                record({ ...ACME_PRICED_ROW, recordId: 'r-run-2', configuration: 'after', runId: 'run-2' }),
                record({ ...ACME_PRICED_ROW, recordId: 'r-run-1', configuration: 'before', runId: 'run-1' }),
            ],
            trackingEnabled: true,
            archive,
            prices: ACME_PRICES,
            runs: CHAT_RUNS,
            selectedRunId: 'run-2',
        });

        // A folded row carries no run, so it cannot join a run's comparison.
        expect(view.configurations.groups.map((group) => group.label)).toEqual(['after']);
    });
});
