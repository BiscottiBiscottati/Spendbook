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
} from '../src/stats.js';

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
        expect(normalizeUsageArchive(null)).toEqual({ total: ZERO_COUNTERS, byOrigin: {}, byConfiguration: {} });
        expect(normalizeUsageArchive({ total: { requests: 2 }, byOrigin: 'nope' })).toEqual({
            total: { ...ZERO_COUNTERS, requests: 2 },
            byOrigin: {},
            byConfiguration: {},
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
