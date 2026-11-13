/**
 * Pure-helper seam: the price table the user types and the cost/saving it
 * resolves. Expected dollars are hand-worked from the per-million rates in each
 * fixture, never rebuilt through the function under test.
 */

import { describe, it, expect } from 'vitest';

import { normalizePriceTable, parsePriceInput, resolveUsageCost } from '../src/prices.js';

const PRICES = {
    currency: 'USD',
    updated: '2026-11-13',
    entries: [
        { provider: 'acme', model: 'm1', hit: 0.003, miss: 0.15, output: 0.6, cacheWrite: 0.15 },
    ],
};

describe('price table normalization', () => {
    it('defaults a fresh install to an empty USD table', () => {
        expect(normalizePriceTable(undefined)).toEqual({ currency: 'USD', updated: '', entries: [] });
        expect(normalizePriceTable(null)).toEqual({ currency: 'USD', updated: '', entries: [] });
        expect(normalizePriceTable({ entries: 'nope' })).toEqual({ currency: 'USD', updated: '', entries: [] });
    });

    it('tolerates a malformed entry and keeps one blank row per entry', () => {
        const normalized = normalizePriceTable({
            currency: '  ',
            updated: 7,
            entries: [null, 'nope'],
        });

        expect(normalized.currency).toBe('USD');
        expect(normalized.updated).toBe('');
        expect(normalized.entries).toEqual([
            { provider: '', model: '', hit: null, miss: null, output: null, cacheWrite: null },
            { provider: '', model: '', hit: null, miss: null, output: null, cacheWrite: null },
        ]);
    });

    it('keeps only usable rates: strings, negatives and non-numbers become null', () => {
        const [entry] = normalizePriceTable({
            entries: [{ provider: ' acme ', model: 'm1', hit: '0.5', miss: -1, output: 0, cacheWrite: Infinity }],
        }).entries;

        expect(entry).toEqual({ provider: 'acme', model: 'm1', hit: null, miss: null, output: 0, cacheWrite: null });
    });

    it('copies entries instead of aliasing the saved table', () => {
        const saved = { provider: 'acme', model: 'm1', output: 1 };
        const normalized = normalizePriceTable({ entries: [saved] });

        normalized.entries[0].output = 2;

        expect(saved.output).toBe(1);
    });
});

describe('price input parsing', () => {
    it('reads a blank or invalid field as no price', () => {
        expect(parsePriceInput('')).toBeNull();
        expect(parsePriceInput('   ')).toBeNull();
        expect(parsePriceInput('abc')).toBeNull();
        expect(parsePriceInput('-0.5')).toBeNull();
        expect(parsePriceInput('Infinity')).toBeNull();
    });

    it('reads zero and a decimal as the typed price', () => {
        expect(parsePriceInput('0')).toBe(0);
        expect(parsePriceInput('0.15')).toBe(0.15);
    });
});

describe('cost resolution', () => {
    it('resolves nothing without a price row', () => {
        const resolved = resolveUsageCost({
            provider: 'acme',
            model: 'm1',
            promptTokens: 1000,
            hitTokens: 400,
            completionTokens: 200,
        }, normalizePriceTable(undefined));

        expect(resolved).toEqual({ cost: null, costSource: 'unavailable', saving: null, savingSource: 'unavailable' });
    });

    it('prices hit, uncached prompt and output tokens each once', () => {
        const resolved = resolveUsageCost({
            provider: 'acme',
            model: 'm1',
            promptTokens: 1000,
            hitTokens: 400,
            completionTokens: 200,
        }, normalizePriceTable(PRICES));

        // 400 * 0.003 + 600 * 0.15 + 200 * 0.6 = 211.2 micro-dollars.
        expect(resolved.cost).toBeCloseTo(0.0002112, 12);
        expect(resolved.costSource).toBe('estimated');
        // 400 * (0.15 - 0.003) = 58.8 micro-dollars; output never counts.
        expect(resolved.saving).toBeCloseTo(0.0000588, 12);
        expect(resolved.savingSource).toBe('estimated');
    });

    it('bills cache writes at the cache-write rate when the row has one', () => {
        const prices = normalizePriceTable({
            entries: [{ provider: 'acme', model: 'm1', hit: 0.003, miss: 0.15, output: 0.6, cacheWrite: 0.3 }],
        });

        const resolved = resolveUsageCost({
            provider: 'acme',
            model: 'm1',
            promptTokens: 1000,
            hitTokens: 400,
            cacheWriteTokens: 100,
            completionTokens: 200,
        }, prices);

        // 400 * 0.003 + 100 * 0.3 + 500 * 0.15 + 200 * 0.6 = 226.2 micro-dollars.
        expect(resolved.cost).toBeCloseTo(0.0002262, 12);
    });

    it('falls back to the miss rate for cache writes when the row prices no write', () => {
        const prices = normalizePriceTable({
            entries: [{ provider: 'acme', model: 'm1', hit: 0.003, miss: 0.15, output: 0.6 }],
        });

        const resolved = resolveUsageCost({
            provider: 'acme',
            model: 'm1',
            promptTokens: 1000,
            hitTokens: 400,
            cacheWriteTokens: 100,
            completionTokens: 200,
        }, prices);

        // 400 * 0.003 + 100 * 0.15 + 500 * 0.15 + 200 * 0.6 = 211.2 micro-dollars.
        expect(resolved.cost).toBeCloseTo(0.0002112, 12);
    });

    it('prices a hit-only row, where nothing else was reported', () => {
        const prices = normalizePriceTable({
            entries: [{ provider: 'acme', model: 'm1', hit: 0.003, miss: 0.15, output: 0.6 }],
        });

        const resolved = resolveUsageCost({ provider: 'acme', model: 'm1', promptTokens: 800, hitTokens: 500 }, prices);

        // 500 * 0.003 + 300 * 0.15 = 46.5 micro-dollars; saving 500 * 0.147.
        expect(resolved.cost).toBeCloseTo(0.0000465, 12);
        expect(resolved.saving).toBeCloseTo(0.0000735, 12);
    });

    it('prices nothing when a row has no prompt count to allocate', () => {
        const prices = normalizePriceTable({
            entries: [{ provider: 'acme', model: 'm1', hit: 0.003, miss: 0.15, output: 0.6 }],
        });

        const resolved = resolveUsageCost({
            provider: 'acme',
            model: 'm1',
            estimatedPromptTokens: 900,
            completionTokens: 200,
        }, prices);

        expect(resolved.cost).toBeNull();
        expect(resolved.costSource).toBe('unavailable');
        expect(resolved.saving).toBeNull();
    });

    it('prices the saving but not the cost when the row gives no output rate', () => {
        const prices = normalizePriceTable({
            entries: [{ provider: 'acme', model: 'm1', hit: 0.003, miss: 0.15 }],
        });

        const resolved = resolveUsageCost({
            provider: 'acme',
            model: 'm1',
            promptTokens: 1000,
            hitTokens: 400,
            completionTokens: 200,
        }, prices);

        expect(resolved.cost).toBeNull();
        expect(resolved.costSource).toBe('unavailable');
        expect(resolved.saving).toBeCloseTo(0.0000588, 12);
        expect(resolved.savingSource).toBe('estimated');
    });

    it('uses a provider-reported cost and discount as reported, never recomputed', () => {
        const resolved = resolveUsageCost({
            provider: 'acme',
            model: 'm1',
            promptTokens: 1000,
            hitTokens: 400,
            completionTokens: 200,
            cost: 0.42,
            cacheDiscount: 0.07,
        }, normalizePriceTable(PRICES));

        expect(resolved).toEqual({
            cost: 0.42,
            costSource: 'measured',
            saving: 0.07,
            savingSource: 'measured',
        });
    });

    it('keeps a reported zero cost instead of falling back to the table', () => {
        const resolved = resolveUsageCost({
            provider: 'acme',
            model: 'm1',
            promptTokens: 1000,
            completionTokens: 200,
            cost: 0,
        }, normalizePriceTable(PRICES));

        expect(resolved.cost).toBe(0);
        expect(resolved.costSource).toBe('measured');
    });

    it('matches the provider and model case-insensitively', () => {
        const resolved = resolveUsageCost({
            provider: ' Acme ',
            model: 'M1',
            promptTokens: 1000,
            hitTokens: 400,
            completionTokens: 200,
        }, normalizePriceTable(PRICES));

        expect(resolved.costSource).toBe('estimated');
        expect(resolved.cost).toBeCloseTo(0.0002112, 12);
    });

    it('stops at the first row that matches', () => {
        const prices = normalizePriceTable({
            entries: [
                { provider: 'acme', model: 'm1', hit: 0.001, miss: 0.1, output: 0.2 },
                { provider: 'acme', model: 'm1', hit: 9, miss: 9, output: 9 },
            ],
        });

        const resolved = resolveUsageCost({ provider: 'acme', model: 'm1', promptTokens: 1000, completionTokens: 0 }, prices);

        // 1000 * 0.1 = 100 micro-dollars from the first row.
        expect(resolved.cost).toBeCloseTo(0.0001, 12);
    });
});

describe('cost resolution boundaries', () => {
    it('prices a row that reported no cached tokens without needing a hit rate', () => {
        const prices = normalizePriceTable({
            entries: [{ provider: 'acme', model: 'm1', miss: 0.15, output: 0.6 }],
        });

        const resolved = resolveUsageCost({ provider: 'acme', model: 'm1', promptTokens: 1000, completionTokens: 200 }, prices);

        // 1000 * 0.15 + 200 * 0.6 = 270 micro-dollars, and no cache saving.
        expect(resolved.cost).toBeCloseTo(0.00027, 12);
        expect(resolved.costSource).toBe('estimated');
        expect(resolved.saving).toBeNull();
    });

    it('refuses to price hit tokens with no hit rate', () => {
        const prices = normalizePriceTable({
            entries: [{ provider: 'acme', model: 'm1', miss: 0.15, output: 0.6 }],
        });

        const resolved = resolveUsageCost({ provider: 'acme', model: 'm1', promptTokens: 1000, hitTokens: 400 }, prices);

        expect(resolved.cost).toBeNull();
        expect(resolved.costSource).toBe('unavailable');
    });

    it('keeps a reported figure exactly as sent, sign included', () => {
        const resolved = resolveUsageCost({
            provider: 'acme',
            model: 'm1',
            promptTokens: 1000,
            cost: 0.5,
            cacheDiscount: -0.02,
        }, normalizePriceTable(PRICES));

        expect(resolved).toEqual({ cost: 0.5, costSource: 'measured', saving: -0.02, savingSource: 'measured' });
    });

    it('ignores a price row with no name to match on', () => {
        const prices = normalizePriceTable({
            entries: [{ provider: 'acme', model: '', hit: 0.003, miss: 0.15, output: 0.6 }],
        });

        expect(resolveUsageCost({ provider: 'acme', model: 'm1', promptTokens: 1000 }, prices).cost).toBeNull();
    });

    it('bills an empty table as no cost and no saving', () => {
        const resolved = resolveUsageCost({ provider: 'acme', model: 'm1', promptTokens: 1000, completionTokens: 100 }, normalizePriceTable({}));

        expect(resolved).toEqual({ cost: null, costSource: 'unavailable', saving: null, savingSource: 'unavailable' });
    });
});
