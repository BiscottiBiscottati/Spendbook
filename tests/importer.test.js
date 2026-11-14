/**
 * Importer seam — an existing VectFox user's history, moved into Spendbook's
 * namespace by one explicit click.
 *
 * The old shapes are the ones VectFox persists today: `chat_metadata.vectfox_usage`
 * and `extension_settings.vectfox.usage_*`. The test drives the importer the way
 * the drawer does — old namespaces in, new namespace out through a real ledger —
 * and asserts the migrated rows field by field, so an import that drops a
 * timestamp or re-sums a folded counter fails here.
 */

import { describe, it, expect, vi } from 'vitest';

import { UsageLedger } from '../src/ledger.js';
import { sumUsageRecords } from '../src/stats.js';
import { describeImportResult, importableLegacyPrices, readLegacyChat } from '../src/importer.js';
import { createBlankPriceEntry } from '../src/prices.js';
import { readSpendbookSettings, setPriceTable } from '../src/settings.js';
import { ACME_PRICES } from './fixtures/prices.js';

const CHAT_ID = 'Seraphina - 2026-11-13T10-00-00';
const LEGACY_KEY = 'vectfox_usage';
const NEW_KEY = 'spendbook_usage';

/**
 * One record as VectFox writes it: everything a record carries, including the
 * old origin vocabulary, the old label field and the transient prompt
 * fingerprint that must never be stored by Spendbook.
 */
function legacyRecord(overrides = {}) {
    return {
        recordId: 'r-1',
        timestamp: 1_700_000_000_000,
        chatId: CHAT_ID,
        runId: 'run-m9x-1',
        origin: 'story',
        featureLabel: null,
        configuration: { ghostEnabled: true, ghostBatchSize: 30, ghostKeepRecent: 10 },
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        responseId: 'resp-1',
        stream: true,
        status: 'ok',
        httpStatus: 200,
        latencyMs: 1200,
        messageCount: 12,
        promptTokens: 1200,
        hitTokens: 400,
        missTokens: 800,
        cacheWriteTokens: null,
        completionTokens: 340,
        reasoningTokens: null,
        totalTokens: 1540,
        cost: null,
        cacheDiscount: null,
        estimatedPromptTokens: null,
        messageFingerprint: { hash: 'abc', tokenCounts: [1, 2] },
        usageSource: 'measured',
        sharedPrefixTokens: 2500,
        possiblePrefixBreaker: true,
        ...overrides,
    };
}

/** The VectFox namespace one chat carries: version 1, this chat's owner. */
function legacyNamespace({ records = [legacyRecord()], overrides = {} } = {}) {
    return {
        version: 1,
        ownerChatId: CHAT_ID,
        revision: 7,
        records,
        runs: [],
        currentRunId: null,
        archived: { total: {}, byOrigin: {}, byConfiguration: {}, byModel: {} },
        promptFingerprints: {},
        ...overrides,
    };
}

/**
 * A ledger over one fake `chat_metadata` object, as the entry module wires it.
 * The open chat is `CHAT_ID`, so a write-through is observable on the metadata.
 */
function createHarness({ metadata = { [LEGACY_KEY]: legacyNamespace() } } = {}) {
    const state = { chatId: CHAT_ID, metadata };
    const saveMetadata = vi.fn();
    const ledger = new UsageLedger({
        getChatId: () => state.chatId,
        getMetadata: () => state.metadata,
        saveMetadata,
        storage: null,
        now: () => 9000,
        debounceMs: 1000,
    });
    ledger.loadChat(CHAT_ID);
    return { ledger, metadata, saveMetadata };
}

/** The one thing the drawer does on a click, short of persisting settings. */
function importChat(ledger, metadata, chatId = CHAT_ID) {
    const legacy = readLegacyChat({ metadata, chatId });
    return legacy ? ledger.importChat(chatId, legacy) : { added: 0, alreadyPresent: 0 };
}

describe('readLegacyChat', () => {
    it('keeps every migrated record field and drops the old label and fingerprint', () => {
        const legacy = legacyNamespace({
            records: [legacyRecord({ origin: 'vectfox-internal', featureLabel: 'EventBase' })],
        });

        const chat = readLegacyChat({ metadata: { [LEGACY_KEY]: legacy }, chatId: CHAT_ID });

        expect(chat.records).toEqual([{
            recordId: 'r-1',
            timestamp: 1_700_000_000_000,
            chatId: CHAT_ID,
            runId: 'run-m9x-1',
            origin: 'internal',
            label: 'EventBase',
            configuration: 'Ghosting on · batch 30 · keep 10',
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            responseId: 'resp-1',
            stream: true,
            status: 'ok',
            httpStatus: 200,
            latencyMs: 1200,
            messageCount: 12,
            promptTokens: 1200,
            hitTokens: 400,
            missTokens: 800,
            cacheWriteTokens: null,
            completionTokens: 340,
            reasoningTokens: null,
            totalTokens: 1540,
            cost: null,
            cacheDiscount: null,
            estimatedPromptTokens: null,
            usageSource: 'measured',
            sharedPrefixTokens: 2500,
            possiblePrefixBreaker: true,
        }]);
    });

    it('maps the old origin vocabulary onto the new one', () => {
        const records = [
            legacyRecord({ recordId: 'r-story', origin: 'story' }),
            legacyRecord({ recordId: 'r-quiet', origin: 'quiet' }),
            legacyRecord({ recordId: 'r-marked', origin: 'vectfox-internal', featureLabel: 'EventBase' }),
            legacyRecord({ recordId: 'r-worker', origin: 'worker-profile' }),
            legacyRecord({ recordId: 'r-unknown', origin: 'unknown' }),
            legacyRecord({ recordId: 'r-missing', origin: undefined }),
        ];

        const chat = readLegacyChat({
            metadata: { [LEGACY_KEY]: legacyNamespace({ records }) },
            chatId: CHAT_ID,
        });

        expect(chat.records.map((record) => [record.recordId, record.origin, record.label])).toEqual([
            ['r-story', 'story', null],
            ['r-quiet', 'quiet', null],
            ['r-marked', 'internal', 'EventBase'],
            ['r-worker', 'internal', null],
            ['r-unknown', 'internal', null],
            ['r-missing', 'internal', null],
        ]);
    });

    it('carries the old runs, the current run id and the folded-row counters', () => {
        const legacy = legacyNamespace({
            overrides: {
                runs: [
                    { runId: 'run-old-1', label: 'Run 1', startedAt: 100, endedAt: 200 },
                    { runId: 'run-old-2', label: 'Baseline', startedAt: 300, endedAt: null },
                ],
                currentRunId: 'run-old-2',
                archived: {
                    total: { requests: 3, promptTokens: 900, hitTokens: 300 },
                    byOrigin: {
                        'vectfox-internal': { requests: 2, promptTokens: 600 },
                        'worker-profile': { requests: 1, promptTokens: 300 },
                    },
                    byConfiguration: {},
                    byModel: { anything: { provider: 'deepseek', model: 'm', origin: 'vectfox-internal' } },
                },
            },
        });

        const chat = readLegacyChat({ metadata: { [LEGACY_KEY]: legacy }, chatId: CHAT_ID });

        expect(chat.currentRunId).toBe('run-old-2');
        expect(chat.revision).toBe(7);
        expect(chat.archived.total.requests).toBe(3);
        expect(chat.archived.total.promptTokens).toBe(900);
        // Both old origins are background work now, so they are one group.
        expect(chat.archived.byOrigin.internal.requests).toBe(3);
        expect(chat.archived.byOrigin['vectfox-internal']).toBeUndefined();
    });

    it('keeps the old runs, with the ledger giving them their shape', () => {
        const legacy = legacyNamespace({
            records: [],
            overrides: {
                runs: [
                    { runId: 'run-old-1', label: 'Run 1', startedAt: 100, endedAt: 200 },
                    { runId: 'run-old-2', label: 'Baseline', startedAt: 300, endedAt: null },
                ],
                currentRunId: 'run-old-2',
            },
        });
        const { ledger, metadata } = createHarness({ metadata: { [LEGACY_KEY]: legacy } });

        importChat(ledger, metadata);

        // The old `endedAt` is dropped: a Spendbook run has no end to record.
        expect(ledger.runsFor(CHAT_ID)).toEqual({
            runs: [
                { runId: 'run-old-2', label: 'Baseline', startedAt: 300 },
                { runId: 'run-old-1', label: 'Run 1', startedAt: 100 },
            ],
            currentRunId: 'run-old-2',
        });
    });

    it('turns the old configuration snapshot into a label', () => {
        const chat = readLegacyChat({
            metadata: {
                [LEGACY_KEY]: legacyNamespace({
                    records: [
                        legacyRecord({ recordId: 'r-snap' }),
                        legacyRecord({ recordId: 'r-none', configuration: null }),
                    ],
                }),
            },
            chatId: CHAT_ID,
        });

        expect(chat.records.map((record) => record.configuration))
            .toEqual(['Ghosting on · batch 30 · keep 10', null]);
    });

    it('reads the old archive’s own shapes: per-model counters, reported dollars and snapshot groups', () => {
        const legacy = legacyNamespace({
            records: [],
            overrides: {
                archived: {
                    total: { requests: 5, promptTokens: 1400, hitTokens: 400 },
                    byOrigin: {
                        'vectfox-internal': { requests: 3, promptTokens: 900 },
                        'worker-profile': { requests: 2, promptTokens: 500 },
                    },
                    byConfiguration: {
                        'ghost:true|30|10': {
                            configuration: { ghostEnabled: true, ghostBatchSize: 30, ghostKeepRecent: 10 },
                            accumulator: { requests: 5, promptTokens: 1400 },
                        },
                    },
                    byModel: {
                        // A group whose rows reported no dollars: its token counts
                        // are what the price table in force now reprices.
                        'acme\u0000m1': {
                            provider: 'acme',
                            model: 'm1',
                            accumulator: { requests: 3, promptTokens: 900, hitTokens: 300, costEstimated: 1, costEstimatedRequests: 3 },
                        },
                        // A group whose rows reported their own dollars: those are
                        // kept as reported, and the group is not priced again.
                        'acme\u0000m2': {
                            provider: 'acme',
                            model: 'm2',
                            accumulator: { requests: 2, promptTokens: 500, hitTokens: 100, costMeasured: 0.00042, costMeasuredRequests: 2, savingMeasured: 0.00001, savingMeasuredRequests: 1 },
                        },
                    },
                },
            },
        });
        const { ledger, metadata } = createHarness({ metadata: { [LEGACY_KEY]: legacy } });

        importChat(ledger, metadata);

        const archive = ledger.archivedFor(CHAT_ID);
        expect(archive.total.requests).toBe(5);
        expect(archive.byOrigin.internal.requests).toBe(5);
        expect(Object.keys(archive.byConfiguration)).toEqual(['Ghosting on · batch 30 · keep 10']);
        expect(archive.byConfiguration['Ghosting on · batch 30 · keep 10'].accumulator.requests).toBe(5);

        const summary = sumUsageRecords({ records: [], archive, prices: ACME_PRICES });
        expect(summary.cost.measured).toBeCloseTo(0.00042, 10);
        expect(summary.cost.measuredRequests).toBe(2);
        expect(summary.saving.measured).toBeCloseTo(0.00001, 10);
        // 300 hit tokens at $0.003/M and 600 miss tokens at $0.15/M.
        expect(summary.cost.estimated).toBeCloseTo(0.0000909, 10);
        expect(summary.cost.estimatedRequests).toBe(3);
    });

    it('refuses a namespace that belongs to another chat, and one that is not VectFox v1', () => {
        const branch = legacyNamespace({ overrides: { ownerChatId: 'Seraphina - 2026-11-12T09-00-00' } });
        expect(readLegacyChat({ metadata: { [LEGACY_KEY]: branch }, chatId: CHAT_ID })).toBeNull();
        expect(readLegacyChat({ metadata: { [LEGACY_KEY]: { version: 2, records: [] } }, chatId: CHAT_ID })).toBeNull();
        expect(readLegacyChat({ metadata: {}, chatId: CHAT_ID })).toBeNull();
        expect(readLegacyChat({ metadata: { [LEGACY_KEY]: legacyNamespace() }, chatId: null })).toBeNull();
    });
});

describe('UsageLedger.importChat', () => {
    it('copies this chat’s records into the new namespace with their ids, once', () => {
        const { ledger, metadata } = createHarness({
            metadata: {
                [LEGACY_KEY]: legacyNamespace({
                    records: [
                        legacyRecord({ recordId: 'r-1', timestamp: 1000 }),
                        legacyRecord({ recordId: 'r-2', timestamp: 2000 }),
                    ],
                }),
            },
        });

        const first = importChat(ledger, metadata);

        expect(first).toEqual({ added: 2, alreadyPresent: 0 });
        expect(metadata[NEW_KEY].records.map((record) => record.recordId)).toEqual(['r-1', 'r-2']);
        expect(ledger.recordsFor(CHAT_ID).map((record) => record.recordId)).toEqual(['r-2', 'r-1']);

        const revision = metadata[NEW_KEY].revision;
        const second = importChat(ledger, metadata);

        expect(second).toEqual({ added: 0, alreadyPresent: 2 });
        expect(metadata[NEW_KEY].records).toHaveLength(2);
        expect(metadata[NEW_KEY].revision).toBe(revision);
    });

    it('adds nothing on a second click even after the cap folded some imported rows', () => {
        const records = Array.from({ length: 501 }, (_, index) => legacyRecord({
            recordId: `r-${index + 1}`,
            timestamp: 1000 + index,
        }));
        const { ledger, metadata } = createHarness({
            metadata: { [LEGACY_KEY]: legacyNamespace({ records }) },
        });

        expect(importChat(ledger, metadata)).toEqual({ added: 501, alreadyPresent: 0 });
        // 501 rows into a 500-row chat: the oldest is folded into the counters.
        expect(ledger.retentionFor(CHAT_ID)).toEqual({ limit: 500, retained: 500, total: 501 });
        expect(ledger.archivedFor(CHAT_ID).total.requests).toBe(1);
        expect(ledger.allTimeForView().totals.requests).toBe(501);

        expect(importChat(ledger, metadata)).toEqual({ added: 0, alreadyPresent: 501 });
        expect(ledger.retentionFor(CHAT_ID)).toEqual({ limit: 500, retained: 500, total: 501 });
        expect(ledger.archivedFor(CHAT_ID).total.requests).toBe(1);
        expect(ledger.allTimeForView().totals.requests).toBe(501);
    });

    it('imports rows VectFox recorded after a first import, and only those', () => {
        const first = legacyNamespace({ records: [legacyRecord({ recordId: 'r-1', timestamp: 1000 })] });
        const { ledger, metadata } = createHarness({ metadata: { [LEGACY_KEY]: first } });
        expect(importChat(ledger, metadata)).toEqual({ added: 1, alreadyPresent: 0 });

        const grown = legacyNamespace({
            records: [legacyRecord({ recordId: 'r-1', timestamp: 1000 }), legacyRecord({ recordId: 'r-2', timestamp: 2000 })],
            overrides: { revision: 8 },
        });
        metadata[LEGACY_KEY] = grown;

        expect(importChat(ledger, metadata)).toEqual({ added: 1, alreadyPresent: 1 });
        expect(ledger.recordsFor(CHAT_ID).map((record) => record.recordId)).toEqual(['r-2', 'r-1']);
        expect(importChat(ledger, metadata)).toEqual({ added: 0, alreadyPresent: 2 });
    });

    it('counts a row the chat already recorded as present instead of adding it twice', () => {
        const { ledger, metadata } = createHarness({
            metadata: { [LEGACY_KEY]: legacyNamespace({ records: [legacyRecord({ recordId: 'r-1' })] }) },
        });
        ledger.add({ recordId: 'r-1', timestamp: 1500, chatId: CHAT_ID, origin: 'story', status: 'ok', usageSource: 'measured' });

        expect(importChat(ledger, metadata)).toEqual({ added: 0, alreadyPresent: 1 });
        expect(ledger.recordsFor(CHAT_ID)).toHaveLength(1);
        // The row stays the one the chat recorded; the import does not overwrite it.
        expect(ledger.recordsFor(CHAT_ID)[0].timestamp).toBe(1500);
    });

    it('merges the old runs and adopts the old current run only while the chat has none', () => {
        const legacy = legacyNamespace({
            records: [],
            overrides: {
                runs: [{ runId: 'run-old-1', label: 'Baseline', startedAt: 100, endedAt: 200 }],
                currentRunId: 'run-old-1',
            },
        });
        const { ledger, metadata } = createHarness({ metadata: { [LEGACY_KEY]: legacy } });

        importChat(ledger, metadata);

        expect(ledger.runsFor(CHAT_ID).runs).toEqual([{ runId: 'run-old-1', label: 'Baseline', startedAt: 100 }]);
        expect(ledger.runsFor(CHAT_ID).currentRunId).toBe('run-old-1');

        // A run started in Spendbook is later, so importing again cannot move it.
        const own = ledger.startRun({ chatId: CHAT_ID, label: 'After' });
        importChat(ledger, metadata);
        expect(ledger.runsFor(CHAT_ID).currentRunId).toBe(own.runId);
        expect(ledger.runsFor(CHAT_ID).runs).toHaveLength(2);
    });

    it('merges folded-row counters once, rather than summing them again on every click', () => {
        const { ledger, metadata } = createHarness({
            metadata: {
                [LEGACY_KEY]: legacyNamespace({
                    records: [],
                    overrides: {
                        archived: {
                            total: { requests: 3, promptTokens: 900 },
                            byOrigin: { 'vectfox-internal': { requests: 3, promptTokens: 900 } },
                            byConfiguration: {},
                            byModel: {},
                        },
                    },
                }),
            },
        });

        importChat(ledger, metadata);
        const afterFirst = ledger.archivedFor(CHAT_ID).total;
        expect(afterFirst.requests).toBe(3);
        expect(afterFirst.promptTokens).toBe(900);

        importChat(ledger, metadata);
        expect(ledger.archivedFor(CHAT_ID).total.requests).toBe(3);
        expect(ledger.archivedFor(CHAT_ID).byOrigin.internal.requests).toBe(3);
    });

    it('adds the old folded counters to the ones the chat already folded', () => {
        const { ledger, metadata } = createHarness({
            metadata: {
                [LEGACY_KEY]: legacyNamespace({
                    records: [],
                    overrides: { archived: { total: { requests: 3, promptTokens: 900 }, byOrigin: { 'worker-profile': { requests: 3, promptTokens: 900 } }, byConfiguration: {}, byModel: {} } },
                }),
                // The chat already folded one row of its own before the import.
                [NEW_KEY]: {
                    version: 1,
                    ownerChatId: CHAT_ID,
                    revision: 2,
                    records: [],
                    archived: { total: { requests: 1, promptTokens: 100 }, byOrigin: { story: { requests: 1, promptTokens: 100 } }, byConfiguration: {}, byModel: {} },
                    runs: [],
                    currentRunId: null,
                    promptFingerprints: {},
                },
            },
        });

        importChat(ledger, metadata);

        expect(ledger.archivedFor(CHAT_ID).total.requests).toBe(4);
        expect(ledger.archivedFor(CHAT_ID).total.promptTokens).toBe(1000);
        expect(ledger.archivedFor(CHAT_ID).byOrigin.internal.requests).toBe(3);
        expect(ledger.archivedFor(CHAT_ID).byOrigin.story.requests).toBe(1);
        expect(ledger.retentionFor(CHAT_ID).total).toBe(4);
    });

    it('counts an imported row in this chat and in the all-time aggregate', () => {
        const { ledger, metadata } = createHarness();

        importChat(ledger, metadata);

        expect(ledger.allTimeForView().totals.requests).toBe(1);
        expect(ledger.retentionFor(CHAT_ID)).toEqual({ limit: 500, retained: 1, total: 1 });
    });

    it('leaves the old chat key and the old settings keys exactly as they were', () => {
        const legacy = legacyNamespace({ records: [legacyRecord()] });
        const before = structuredClone(legacy);
        const { ledger, metadata } = createHarness({ metadata: { [LEGACY_KEY]: legacy } });

        importChat(ledger, metadata);

        expect(metadata[LEGACY_KEY]).toEqual(before);
        expect(metadata[NEW_KEY]).toBeTruthy();
    });
});

/** VectFox's settings block, as an existing user's storage has it. */
function legacySettings(overrides = {}) {
    return {
        vectfox: {
            usage_tracking_enabled: true,
            usage_prices: {
                currency: 'EUR',
                updated: '2026-10-01',
                entries: ACME_PRICES.entries.map((entry) => ({ ...entry })),
            },
            ...overrides,
        },
    };
}

describe('importableLegacyPrices', () => {
    it('brings the old table into an empty one, rates and all', () => {
        const prices = importableLegacyPrices({
            extensionSettings: legacySettings(),
            currentPrices: { currency: 'USD', updated: '', entries: [] },
        });

        expect(prices).toEqual({
            currency: 'EUR',
            updated: '2026-10-01',
            entries: [{ provider: 'acme', model: 'm1', hit: 0.003, miss: 0.15, output: 0.6, cacheWrite: null }],
        });
    });

    it('never overwrites a price row the user entered', () => {
        expect(importableLegacyPrices({
            extensionSettings: legacySettings(),
            currentPrices: ACME_PRICES,
        })).toBeNull();
        // Nor one that only fills in a single field.
        expect(importableLegacyPrices({
            extensionSettings: legacySettings(),
            currentPrices: { currency: 'USD', updated: '', entries: [{ provider: '', model: 'm1', hit: null, miss: null, output: null, cacheWrite: null }] },
        })).toBeNull();
    });

    it('leaves a table that already holds a row alone, even a blank one', () => {
        expect(importableLegacyPrices({
            extensionSettings: legacySettings(),
            currentPrices: { currency: 'USD', updated: '', entries: [createBlankPriceEntry()] },
        })).toBeNull();
    });

    it('imports nothing when there is no old table, and never reads the tracking flag', () => {
        expect(importableLegacyPrices({
            extensionSettings: {},
            currentPrices: { currency: 'USD', updated: '', entries: [] },
        })).toBeNull();
        expect(importableLegacyPrices({
            extensionSettings: legacySettings({ usage_prices: { currency: 'USD', entries: [{ provider: '', model: '', hit: null, miss: null, output: null, cacheWrite: null }] } }),
            currentPrices: { currency: 'USD', updated: '', entries: [] },
        })).toBeNull();

        const extensionSettings = legacySettings();
        const before = structuredClone(extensionSettings.vectfox);
        const prices = importableLegacyPrices({ extensionSettings, currentPrices: { currency: 'USD', updated: '', entries: [] } });
        setPriceTable(extensionSettings, prices);
        expect(readSpendbookSettings(extensionSettings).trackingEnabled).toBe(false);
        expect(extensionSettings.vectfox).toEqual(before);
    });
});

describe('describeImportResult', () => {
    it('says what a click did, and whether prices came with it', () => {
        expect(describeImportResult({ found: true, added: 2, alreadyPresent: 0, pricesImported: true }))
            .toBe('2 records added, 0 already present. Prices imported.');
        expect(describeImportResult({ found: true, added: 1, alreadyPresent: 3, pricesImported: false }))
            .toBe('1 record added, 3 already present. Prices not imported.');
        expect(describeImportResult({ found: true, added: 0, alreadyPresent: 5, pricesImported: false }))
            .toBe('0 records added, 5 already present. Prices not imported.');
    });

    it('says so when the chat has no old ledger, and still reports the prices', () => {
        expect(describeImportResult({ found: false }))
            .toBe('Nothing to import: this chat has no VectFox usage ledger. Prices not imported.');
        expect(describeImportResult({ found: false, pricesImported: true }))
            .toBe('Nothing to import: this chat has no VectFox usage ledger. Prices imported.');
    });
});
