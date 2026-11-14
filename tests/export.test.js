/**
 * Export seam — the versioned JSON file a user attaches to a bug report.
 *
 * The export is a projection with a published field list, so the test asserts
 * the whole published shape with literals and, above all, that nothing a record
 * happens to carry can reach the file: no chat identifier, no prompt text, no
 * request body, no key.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { UsageLedger } from '../src/ledger.js';
import { buildUsageExport, usageExportFileName } from '../src/export.js';

const EXPORTED_AT = Date.UTC(2026, 10, 14, 12, 34, 56);

/** The field list the export publishes for one record, written out here. */
const PUBLISHED_RECORD_FIELDS = [
    'recordId',
    'timestamp',
    'runId',
    'origin',
    'label',
    'configuration',
    'provider',
    'model',
    'responseId',
    'stream',
    'status',
    'httpStatus',
    'latencyMs',
    'messageCount',
    'promptTokens',
    'hitTokens',
    'missTokens',
    'cacheWriteTokens',
    'completionTokens',
    'reasoningTokens',
    'totalTokens',
    'cost',
    'cacheDiscount',
    'estimatedPromptTokens',
    'usageSource',
    'sharedPrefixTokens',
    'possiblePrefixBreaker',
];

/** A zeroed counter block, written out so the published list is visible here. */
function zeroCounters() {
    return {
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
        completionTokenRequests: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        totalTokenRequests: 0,
    };
}

/**
 * One record that carries everything a record may carry — plus the chat id and
 * the host-only fields a future version might add, so a projection that dumps
 * the row instead of picking its fields fails here.
 */
function record(overrides = {}) {
    return {
        recordId: 'r-1',
        timestamp: 1_700_000_000_000,
        chatId: 'Alice - 2026-11-10T10-00-00',
        runId: 'run-1',
        origin: 'story',
        label: null,
        configuration: 'batch 30',
        provider: 'acme',
        model: 'm1',
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
        possiblePrefixBreaker: false,
        ...overrides,
    };
}

/** The record as the export publishes it, written out field by field. */
const PROJECTED_RECORD = {
    recordId: 'r-1',
    timestamp: 1_700_000_000_000,
    runId: 'run-1',
    origin: 'story',
    label: null,
    configuration: 'batch 30',
    provider: 'acme',
    model: 'm1',
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
    possiblePrefixBreaker: false,
};

/** The context of an open one-on-one chat with Alice. */
function oneOnOneContext(overrides = {}) {
    return {
        chatId: 'Alice - 2026-11-10T10-00-00',
        name2: 'Alice',
        groupId: null,
        ...overrides,
    };
}

/** The context of an open group chat where Bob happens to be speaking. */
function groupContext(overrides = {}) {
    return {
        chatId: 'The Trio - 2026-11-10T10-00-00',
        groupId: 'g-1',
        name2: 'Bob',
        groups: [
            { id: 'g-1', name: 'The Trio' },
            { id: 'g-2', name: 'Other' },
        ],
        ...overrides,
    };
}

describe('Spendbook export — published shape', () => {
    it('declares its kind and version and projects one record onto the published field list', () => {
        const exported = buildUsageExport({
            now: EXPORTED_AT,
            snapshot: { records: [record()] },
        });

        expect(exported).toEqual({
            version: 1,
            kind: 'spendbook-usage-export',
            exportedAt: '2026-11-14T12:34:56.000Z',
            records: [PROJECTED_RECORD],
            runs: [],
            aggregates: {
                archived: {
                    total: zeroCounters(),
                    byOrigin: {},
                    byConfiguration: {},
                    byModel: [],
                },
                allTime: zeroCounters(),
            },
        });
    });
});

describe('Spendbook export — what cannot leak', () => {
    it('drops every field a record carries but the published list does not name', () => {
        const exported = buildUsageExport({
            now: EXPORTED_AT,
            snapshot: {
                records: [record({
                    chatId: 'Secret Character - 2026-11-10T10-00-00',
                    promptText: 'the private prompt',
                    requestBody: '{"messages":[{"content":"the private prompt"}]}',
                    apiKey: '[REDACTED:auth_header]',
                    authorNote: 'a private note',
                })],
            },
        });

        // The chat id, the prompt and the key exist on the record and nowhere in
        // the file — not in a header, not in an aggregate key.
        const json = JSON.stringify(exported);
        expect(json).not.toContain('Secret Character');
        expect(json).not.toContain('the private prompt');
        expect(json).not.toContain('[REDACTED:auth_header]');
        expect(json).not.toContain('a private note');
        expect(exported.records[0]).not.toHaveProperty('chatId');
        expect(Object.keys(exported.records[0])).toEqual(PUBLISHED_RECORD_FIELDS);
    });

    it('publishes the all-time totals without the per-chat buckets they were accumulated in', () => {
        const exported = buildUsageExport({
            now: EXPORTED_AT,
            snapshot: {
                allTime: {
                    totals: { requests: 7, promptText: 'the private prompt' },
                    chats: 2,
                    buckets: { 'Secret Character - 2026-11-10T10-00-00': { requests: 4 } },
                },
            },
        });

        // The bucket map is keyed by chat id, so it is not in the file; only the
        // totals it was accumulated in are.
        expect(JSON.stringify(exported)).not.toContain('Secret Character');
        expect(exported.aggregates.allTime).toEqual({ ...zeroCounters(), requests: 7 });
        expect(exported.aggregates.allTime).not.toHaveProperty('buckets');
    });

    it('publishes a host configuration label as a group of its own, whatever it spells', () => {
        const byConfiguration = JSON.parse(
            '{"__proto__":{"configuration":"__proto__","accumulator":{"requests":3}}}',
        );

        const exported = buildUsageExport({
            now: EXPORTED_AT,
            snapshot: { archived: { byConfiguration } },
        });

        expect(Object.keys(exported.aggregates.archived.byConfiguration)).toEqual(['__proto__']);
        expect(exported.aggregates.archived.byConfiguration.__proto__.accumulator.requests).toBe(3);
    });

    it('publishes null for a field the record lacks and keeps a reported zero and a false', () => {
        const exported = buildUsageExport({
            now: EXPORTED_AT,
            snapshot: { records: [{ recordId: 'r-2', hitTokens: 0, stream: false }] },
        });

        expect(exported.records[0]).toEqual({
            ...Object.fromEntries(PUBLISHED_RECORD_FIELDS.map((field) => [field, null])),
            recordId: 'r-2',
            hitTokens: 0,
            stream: false,
        });
    });
});

describe('Spendbook export — runs, folded rows and all-time', () => {
    const snapshot = {
        records: [record()],
        runs: [
            { runId: 'run-2', label: 'after', startedAt: 1_700_000_100_000 },
            { runId: 'run-1', label: 'before', startedAt: 1_700_000_000_000 },
        ],
        archived: {
            total: { requests: 2, measuredRequests: 2, promptTokens: 900, hitTokens: 100, ratedPromptTokens: 900 },
            byOrigin: { story: { requests: 2 }, quiet: { requests: 1 } },
            byConfiguration: {
                'batch 30': { configuration: 'batch 30', accumulator: { requests: 2 } },
            },
            byModel: {
                'acme\u0000m1\u0000story\u0001batch 30': {
                    provider: 'acme',
                    model: 'm1',
                    origin: 'story',
                    configuration: 'batch 30',
                    unpricedCost: { requests: 1, promptTokens: 900 },
                    unpricedSaving: { requests: 1, hitTokens: 100 },
                    reportedCost: 0.42,
                    reportedCostRequests: 1,
                    reportedSaving: 0.07,
                    reportedSavingRequests: 1,
                },
            },
        },
        allTime: { totals: { requests: 7 }, chats: 3 },
    };

    it('publishes the runs, the folded-row counters and the all-time totals', () => {
        const exported = buildUsageExport({ now: EXPORTED_AT, snapshot });

        expect(exported.runs).toEqual([
            { runId: 'run-2', label: 'after', startedAt: 1_700_000_100_000 },
            { runId: 'run-1', label: 'before', startedAt: 1_700_000_000_000 },
        ]);
        expect(exported.aggregates.archived.total).toEqual({
            ...zeroCounters(),
            requests: 2,
            measuredRequests: 2,
            promptTokens: 900,
            hitTokens: 100,
            ratedPromptTokens: 900,
        });
        expect(exported.aggregates.archived.byOrigin).toEqual({
            story: { ...zeroCounters(), requests: 2 },
            quiet: { ...zeroCounters(), requests: 1 },
        });
        expect(exported.aggregates.archived.byConfiguration).toEqual({
            'batch 30': {
                configuration: 'batch 30',
                accumulator: { ...zeroCounters(), requests: 2 },
            },
        });
        // The archive keys model buckets by a separator-joined string; the export
        // publishes them as a list of objects, so a bug report does not carry
        // NUL-separated keys.
        expect(exported.aggregates.archived.byModel).toEqual([
            {
                provider: 'acme',
                model: 'm1',
                origin: 'story',
                configuration: 'batch 30',
                unpricedCost: { ...zeroCounters(), requests: 1, promptTokens: 900 },
                unpricedSaving: { ...zeroCounters(), requests: 1, hitTokens: 100 },
                reportedCost: 0.42,
                reportedCostRequests: 1,
                reportedSaving: 0.07,
                reportedSavingRequests: 1,
            },
        ]);
    });

    it('publishes the all-time totals as counters, never a bucket per chat', () => {
        const exported = buildUsageExport({ now: EXPORTED_AT, snapshot });

        expect(exported.aggregates.allTime).toEqual({ ...zeroCounters(), requests: 7 });
    });

    it('publishes an unknown start time as null rather than as the epoch', () => {
        const exported = buildUsageExport({
            now: EXPORTED_AT,
            snapshot: { runs: [{ runId: 'run-3', label: 'later' }] },
        });

        expect(exported.runs).toEqual([{ runId: 'run-3', label: 'later', startedAt: null }]);
    });
});

describe('Spendbook export — the chat-name opt-in', () => {
    it('carries no name by default, even when the chat has one', () => {
        const exported = buildUsageExport({
            now: EXPORTED_AT,
            snapshot: { records: [record()] },
            chatContext: oneOnOneContext(),
        });

        expect(exported).not.toHaveProperty('chatName');
        expect(Object.keys(exported)).toEqual(['version', 'kind', 'exportedAt', 'records', 'runs', 'aggregates']);
        expect(JSON.stringify(exported)).not.toContain('Alice');
    });

    it('adds only the open chat’s name at the top level when the user opted in', () => {
        const exported = buildUsageExport({
            now: EXPORTED_AT,
            snapshot: { records: [record()] },
            chatContext: oneOnOneContext(),
            includeChatNames: true,
        });

        expect(Object.keys(exported)).toEqual([
            'version', 'kind', 'exportedAt', 'chatName', 'records', 'runs', 'aggregates',
        ]);
        expect(exported.chatName).toBe('Alice');
        // Still no chat id: the name is the only chat-shaped thing in the file.
        expect(JSON.stringify(exported)).not.toContain('Alice - 2026-11-10T10-00-00');
    });

    it('names a group chat by its group, never by the member who is speaking', () => {
        const exported = buildUsageExport({
            now: EXPORTED_AT,
            snapshot: null,
            chatContext: groupContext(),
            includeChatNames: true,
        });

        expect(exported.chatName).toBe('The Trio');
        expect(JSON.stringify(exported)).not.toContain('Bob');
        expect(JSON.stringify(exported)).not.toContain('The Trio - 2026-11-10T10-00-00');
    });

    it('publishes no name while no chat is open or the name is missing', () => {
        const contexts = [
            // `name2` outlives the chat that set it: with no chat open it still
            // holds the default assistant, which names no chat.
            { chatId: undefined, name2: 'SillyTavern System', groupId: null },
            { chatId: null, name2: 'SillyTavern System', groupId: null },
            { chatId: 'Alice - 2026-11-10T10-00-00' },
            { chatId: 'Alice - 2026-11-10T10-00-00', name2: '' },
            { chatId: 'Alice - 2026-11-10T10-00-00', name2: '   ' },
            { chatId: 'Alice - 2026-11-10T10-00-00', name2: 42 },
            // A group chat whose group is not in the context never falls back to
            // a character name.
            { chatId: 'The Trio - 2026-11-10T10-00-00', groupId: 'g-missing', name2: 'Bob', groups: [] },
            null,
        ];

        for (const chatContext of contexts) {
            const exported = buildUsageExport({
                now: EXPORTED_AT,
                snapshot: null,
                chatContext,
                includeChatNames: true,
            });
            expect(exported).not.toHaveProperty('chatName');
        }
    });
});

describe('Spendbook export — the filename', () => {
    it('names the chat and the moment, without ever naming the chat file', () => {
        const chatContext = oneOnOneContext();

        const fileName = usageExportFileName({ now: EXPORTED_AT, chatContext });

        expect(fileName).toBe('spendbook-usage-Alice-20261114-123456.json');
        // The name is what tells two downloads apart, so it is not behind the
        // opt-in; the chat id is what the name must never carry.
        expect(fileName).not.toContain(chatContext.chatId);
    });

    it('names a group chat by its group, never by the member who is speaking', () => {
        const chatContext = groupContext();

        const fileName = usageExportFileName({ now: EXPORTED_AT, chatContext });

        expect(fileName).toBe('spendbook-usage-The-Trio-20261114-123456.json');
        expect(fileName).not.toContain('Bob');
        expect(fileName).not.toContain(chatContext.chatId);
    });

    it('names the download by timestamp alone while no chat is open', () => {
        expect(usageExportFileName({ now: EXPORTED_AT, chatContext: null }))
            .toBe('spendbook-usage-20261114-123456.json');
        expect(usageExportFileName({
            now: EXPORTED_AT,
            chatContext: { chatId: undefined, name2: 'SillyTavern System' },
        })).toBe('spendbook-usage-20261114-123456.json');
    });

    it('makes a name safe to save on every platform', () => {
        expect(usageExportFileName({
            now: EXPORTED_AT,
            chatContext: oneOnOneContext({ name2: 'The Trio: "A/B" <2>' }),
        })).toBe('spendbook-usage-The-Trio-A-B-2-20261114-123456.json');
    });

    it('caps a long name so the timestamp stays readable', () => {
        expect(usageExportFileName({
            now: EXPORTED_AT,
            chatContext: oneOnOneContext({ name2: 'x'.repeat(100) }),
        })).toBe(`spendbook-usage-${'x'.repeat(60)}-20261114-123456.json`);
    });
});

describe('Spendbook export — from a real ledger', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('projects the ledger snapshot the entry module hands it, with no chat id in the file', () => {
        vi.stubGlobal('crypto', { randomUUID: () => '11111111-2222-4333-8444-555555555555' });
        const chatId = 'Alice - 2026-11-10T10-00-00';
        const ledger = new UsageLedger({
            getChatId: () => chatId,
            getMetadata: () => null,
            storage: null,
            now: () => 1_700_000_000_000,
        });
        ledger.loadChat(chatId);
        ledger.add(record({ recordId: 'r-ledger', chatId }));
        ledger.startRun({ label: 'after' });

        const exported = buildUsageExport({
            now: EXPORTED_AT,
            snapshot: ledger.exportSnapshotFor(chatId),
        });

        // The ledger consumes the prompt fingerprint itself, so a row added
        // without one carries no shared-prefix count.
        expect(exported.records).toEqual([{
            ...PROJECTED_RECORD,
            recordId: 'r-ledger',
            sharedPrefixTokens: null,
        }]);
        expect(exported.runs).toEqual([{
            runId: '11111111-2222-4333-8444-555555555555',
            label: 'after',
            startedAt: 1_700_000_000_000,
        }]);
        expect(exported.aggregates.archived).toEqual({
            total: zeroCounters(),
            byOrigin: {},
            byConfiguration: {},
            byModel: [],
        });
        expect(exported.aggregates.allTime).toEqual({
            ...zeroCounters(),
            requests: 1,
            measuredRequests: 1,
            coveredRequests: 1,
            promptTokens: 1200,
            ratedRequests: 1,
            ratedPromptTokens: 1200,
            hitTokens: 400,
            completionTokens: 340,
            completionTokenRequests: 1,
            totalTokens: 1540,
            totalTokenRequests: 1,
        });
        expect(JSON.stringify(exported)).not.toContain(chatId);
    });
});
