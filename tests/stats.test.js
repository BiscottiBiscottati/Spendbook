import { describe, it, expect } from 'vitest';

import {
    addRecordToUsageAccumulator,
    addRecordToUsageArchive,
    createUsageAccumulator,
    createUsageArchive,
    isUsageAccumulatorEmpty,
    isUsageArchiveEmpty,
    mergeUsageAccumulators,
    mergeUsageArchives,
    normalizeUsageAccumulator,
    normalizeUsageArchive,
    subtractUsageAccumulators,
    sumUsageRecords,
} from '../src/stats.js';
import { ACME_PRICES, ACME_PRICED_ROW } from './fixtures/prices.js';

// The shape a zeroed accumulator must have, written out here so a bug in the
// accumulator cannot agree with itself.
const ZERO_COUNTERS = {
    requests: 0,
    measuredRequests: 0,
    estimatedRequests: 0,
    unavailableRequests: 0,
    excludedRequests: 0,
    ratedRequests: 0,
    coveredRequests: 0,
    estimatedPromptRequests: 0,
    promptTokens: 0,
    estimatedPromptTokens: 0,
    hitTokens: 0,
    ratedPromptTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
};

function record(overrides = {}) {
    return {
        recordId: 'r-1',
        status: 'ok',
        usageSource: 'measured',
        origin: 'story',
        configuration: null,
        promptTokens: 1200,
        hitTokens: 300,
        completionTokens: 340,
        totalTokens: 1540,
        estimatedPromptTokens: null,
        ...overrides,
    };
}

function fold(records) {
    const accumulator = createUsageAccumulator();
    for (const entry of records) addRecordToUsageAccumulator(accumulator, entry);
    return accumulator;
}

describe('Spendbook usage accumulator', () => {
    it('starts zeroed and counts a measured request', () => {
        const counts = fold([record()]);

        expect(counts).toEqual({
            requests: 1,
            measuredRequests: 1,
            estimatedRequests: 0,
            unavailableRequests: 0,
            excludedRequests: 0,
            ratedRequests: 1,
            coveredRequests: 1,
            estimatedPromptRequests: 0,
            promptTokens: 1200,
            estimatedPromptTokens: 0,
            hitTokens: 300,
            ratedPromptTokens: 1200,
            cacheWriteTokens: 0,
            completionTokens: 340,
            reasoningTokens: 0,
            totalTokens: 1540,
        });
    });

    it('counts an estimated request apart from the measured prompt tokens', () => {
        const counts = fold([
            record({ status: 'no-usage', usageSource: 'estimated', promptTokens: null, hitTokens: null, estimatedPromptTokens: 240 }),
        ]);

        expect(counts.requests).toBe(1);
        expect(counts.estimatedRequests).toBe(1);
        expect(counts.measuredRequests).toBe(0);
        expect(counts.estimatedPromptTokens).toBe(240);
        expect(counts.estimatedPromptRequests).toBe(1);
        expect(counts.promptTokens).toBe(0);
        expect(counts.coveredRequests).toBe(0);
        expect(counts.ratedRequests).toBe(0);
    });

    it('counts a completed request with no usage as unavailable', () => {
        const counts = fold([
            record({ status: 'no-usage', usageSource: 'unavailable', promptTokens: null, hitTokens: null }),
        ]);

        expect(counts.requests).toBe(1);
        expect(counts.unavailableRequests).toBe(1);
        expect(counts.measuredRequests).toBe(0);
        expect(counts.estimatedRequests).toBe(0);
    });

    it('keeps failed and aborted requests out of the completed counters', () => {
        const counts = fold([
            record({ status: 'error', usageSource: 'unavailable', promptTokens: null, hitTokens: null }),
            record({ recordId: 'r-2', status: 'aborted', usageSource: 'unavailable', promptTokens: null, hitTokens: null }),
        ]);

        expect(counts.requests).toBe(0);
        expect(counts.excludedRequests).toBe(2);
        expect(counts.promptTokens).toBe(0);
    });

    it('counts a hit-rate pair only when the provider reported both counts', () => {
        const counts = fold([
            record({ promptTokens: 1200, hitTokens: null }),
            record({ recordId: 'r-2', promptTokens: null, hitTokens: 300, usageSource: 'estimated', estimatedPromptTokens: 240 }),
        ]);

        expect(counts.ratedRequests).toBe(0);
        expect(counts.ratedPromptTokens).toBe(0);
        expect(counts.hitTokens).toBe(0);
    });

    it('normalizes a persisted accumulator, filling missing fields with zero', () => {
        expect(normalizeUsageAccumulator({ requests: 3, promptTokens: 900 })).toMatchObject({
            requests: 3,
            promptTokens: 900,
            excludedRequests: 0,
            hitTokens: 0,
        });
        expect(normalizeUsageAccumulator(null)).toEqual(ZERO_COUNTERS);
    });

    it('sums accumulators and clamps a subtraction at zero', () => {
        const left = fold([record(), record({ recordId: 'r-2' })]);
        const right = fold([record({ promptTokens: 500, hitTokens: 100, recordId: 'r-3' })]);

        expect(mergeUsageAccumulators(left, right)).toMatchObject({
            requests: 3,
            promptTokens: 2900,
            hitTokens: 700,
        });

        const difference = subtractUsageAccumulators(right, mergeUsageAccumulators(left, right));
        expect(difference.requests).toBe(0);
        expect(difference.promptTokens).toBe(0);
        expect(isUsageAccumulatorEmpty(difference)).toBe(true);
    });
});

describe('Spendbook evicted-row archive', () => {
    it('folds one evicted row into totals, origin and configuration groups', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record());
        addRecordToUsageArchive(archive, record({
            recordId: 'r-2',
            origin: 'internal',
            configuration: 'batch-8',
            promptTokens: 500,
            hitTokens: 100,
        }));
        addRecordToUsageArchive(archive, record({
            recordId: 'r-3',
            status: 'error',
            usageSource: 'unavailable',
            promptTokens: null,
            hitTokens: null,
        }));

        expect(archive.total).toMatchObject({
            requests: 2,
            excludedRequests: 1,
            promptTokens: 1700,
            hitTokens: 400,
        });
        expect(archive.byOrigin.story).toMatchObject({ requests: 1, excludedRequests: 1 });
        expect(archive.byOrigin.internal).toMatchObject({ requests: 1, promptTokens: 500 });
        expect(archive.byConfiguration.default).toMatchObject({
            configuration: null,
            accumulator: { requests: 1, excludedRequests: 1, promptTokens: 1200 },
        });
        expect(archive.byConfiguration['batch-8']).toMatchObject({
            configuration: 'batch-8',
            accumulator: { requests: 1, promptTokens: 500 },
        });
    });

    it('normalizes a missing or malformed archive', () => {
        expect(normalizeUsageArchive(null)).toEqual({
            total: ZERO_COUNTERS,
            byOrigin: {},
            byConfiguration: {},
            byModel: {},
        });
        expect(normalizeUsageArchive({ total: { requests: 2 }, byOrigin: 'nope', byModel: 'nope' })).toEqual({
            total: { ...ZERO_COUNTERS, requests: 2 },
            byOrigin: {},
            byConfiguration: {},
            byModel: {},
        });
    });

    it('merges two archives counter by counter', () => {
        const left = createUsageArchive();
        addRecordToUsageArchive(left, record());
        const right = createUsageArchive();
        addRecordToUsageArchive(right, record({
            recordId: 'r-2',
            origin: 'internal',
            configuration: 'batch-8',
            promptTokens: 500,
            hitTokens: 100,
        }));

        const merged = mergeUsageArchives(left, right);

        expect(merged.total).toMatchObject({ requests: 2, promptTokens: 1700 });
        expect(merged.byOrigin.story).toMatchObject({ requests: 1 });
        expect(merged.byOrigin.internal).toMatchObject({ requests: 1 });
        expect(merged.byConfiguration['batch-8'].accumulator).toMatchObject({ promptTokens: 500 });
        expect(isUsageArchiveEmpty(merged)).toBe(false);
        expect(isUsageArchiveEmpty(createUsageArchive())).toBe(true);
    });
});

describe('Spendbook dollars', () => {
    it('keeps the price inputs of a folded row under its provider and model', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record(ACME_PRICED_ROW));

        const bucket = archive.byModel['acme\u0000m1'];
        expect(bucket).toMatchObject({ provider: 'acme', model: 'm1' });
        expect(bucket.unpricedCost).toMatchObject({ requests: 1, promptTokens: 1200, hitTokens: 400, completionTokens: 340 });
        expect(bucket.unpricedSaving).toMatchObject({ requests: 1, hitTokens: 400 });
        expect(bucket.reportedCost).toBe(0);
    });

    it('keeps a folded provider-reported figure instead of pricing it', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record({ ...ACME_PRICED_ROW, cost: 0.42, cacheDiscount: 0.07 }));

        const bucket = archive.byModel['acme\u0000m1'];
        expect(bucket).toMatchObject({
            reportedCost: 0.42,
            reportedCostRequests: 1,
            reportedSaving: 0.07,
            reportedSavingRequests: 1,
        });
        // Nothing is left for the table to price.
        expect(bucket.unpricedCost.requests).toBe(0);
        expect(bucket.unpricedSaving.requests).toBe(0);
    });

    it('folds no price inputs for a row the estimator could not have priced', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record({
            ...ACME_PRICED_ROW,
            promptTokens: null,
            hitTokens: null,
            usageSource: 'estimated',
            estimatedPromptTokens: 900,
            completionTokens: 100,
        }));

        const totals = sumUsageRecords({ records: [], archive, prices: ACME_PRICES });

        // On screen that row shows no dollars, so folding its zeros must not
        // invent a cost or a zero saving.
        expect(totals.cost).toEqual({
            measured: 0,
            measuredRequests: 0,
            estimated: 0,
            estimatedRequests: 0,
            requests: 0,
        });
        expect(totals.saving.estimatedRequests).toBe(0);
    });

    it('archives no price inputs for a failed row', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record({
            status: 'error',
            usageSource: 'unavailable',
            promptTokens: null,
            hitTokens: null,
        }));

        expect(archive.byModel).toEqual({});
        expect(archive.total).toMatchObject({ requests: 0, excludedRequests: 1 });
    });

    it('prices a folded row with the table in force when the total is summed', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record(ACME_PRICED_ROW));

        const priced = sumUsageRecords({ records: [], archive, prices: ACME_PRICES });

        // 400 * 0.003 + 800 * 0.15 + 340 * 0.6 = 325.2 micro-dollars, saving 58.8.
        expect(priced.cost.estimated).toBeCloseTo(0.0003252, 12);
        expect(priced.cost.estimatedRequests).toBe(1);
        expect(priced.cost.measured).toBe(0);
        expect(priced.saving.estimated).toBeCloseTo(0.0000588, 12);
        expect(priced.counters).toMatchObject({ requests: 1, promptTokens: 1200 });
    });

    it('prices a folded row exactly like the same row left visible', () => {
        const withWriteRate = {
            currency: 'USD',
            updated: '',
            entries: [{ provider: 'acme', model: 'm1', hit: 0.003, miss: 0.15, output: 0.6, cacheWrite: 0.3 }],
        };
        const billed = record({ ...ACME_PRICED_ROW, promptTokens: 1000, hitTokens: 400, cacheWriteTokens: 100, completionTokens: 200 });
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, billed);

        const visible = sumUsageRecords({ records: [billed], archive: null, prices: withWriteRate });
        const folded = sumUsageRecords({ records: [], archive, prices: withWriteRate });

        // 400 * 0.003 + 100 * 0.3 + 500 * 0.15 + 200 * 0.6 = 226.2 micro-dollars.
        expect(visible.cost.estimated).toBeCloseTo(0.0002262, 12);
        expect(folded.cost.estimated).toBeCloseTo(visible.cost.estimated, 12);
        expect(folded.saving.estimated).toBeCloseTo(visible.saving.estimated, 12);
    });

    it('reprices a folded row when the table changes', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record(ACME_PRICED_ROW));
        const cheaper = {
            currency: 'USD',
            updated: '',
            entries: [{ provider: 'acme', model: 'm1', hit: 0.003, miss: 0.3, output: 0.6, cacheWrite: null }],
        };

        const before = sumUsageRecords({ records: [], archive, prices: ACME_PRICES });
        const after = sumUsageRecords({ records: [], archive, prices: cheaper });
        const withoutPrices = sumUsageRecords({ records: [], archive, prices: null });

        expect(before.cost.estimated).toBeCloseTo(0.0003252, 12);
        // 400 * 0.003 + 800 * 0.3 + 340 * 0.6 = 445.2 micro-dollars.
        expect(after.cost.estimated).toBeCloseTo(0.0004452, 12);
        // Removing the price row removes the dollars, folded rows included.
        expect(withoutPrices.cost).toEqual({
            measured: 0,
            measuredRequests: 0,
            estimated: 0,
            estimatedRequests: 0,
            requests: 0,
        });
    });

    it('counts folded reported dollars and folded table dollars side by side', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, record({ ...ACME_PRICED_ROW, recordId: 'r-1' }));
        addRecordToUsageArchive(archive, record({
            ...ACME_PRICED_ROW,
            recordId: 'r-2',
            cost: 0.42,
        }));

        const totals = sumUsageRecords({ records: [], archive, prices: ACME_PRICES });

        expect(totals.cost.measured).toBe(0.42);
        expect(totals.cost.measuredRequests).toBe(1);
        expect(totals.cost.estimated).toBeCloseTo(0.0003252, 12);
        expect(totals.cost.estimatedRequests).toBe(1);
        expect(totals.cost.requests).toBe(2);
    });

    it('merges the model groups of two archives', () => {
        const left = createUsageArchive();
        addRecordToUsageArchive(left, record({ ...ACME_PRICED_ROW, recordId: 'r-1' }));
        const right = createUsageArchive();
        addRecordToUsageArchive(right, record({ ...ACME_PRICED_ROW, recordId: 'r-2', cost: 0.5 }));

        const merged = mergeUsageArchives(left, right);
        const bucket = merged.byModel['acme\u0000m1'];

        expect(bucket.unpricedCost.requests).toBe(1);
        expect(bucket.reportedCost).toBe(0.5);
        expect(bucket.reportedCostRequests).toBe(1);
    });
});
