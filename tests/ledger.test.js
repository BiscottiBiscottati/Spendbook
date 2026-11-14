import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
    USAGE_ALL_TIME_STORAGE_KEY,
    USAGE_CHAT_METADATA_KEY,
    USAGE_PENDING_STORAGE_KEY,
    USAGE_RECORD_LIMIT,
    UsageLedger,
} from '../src/ledger.js';
import { ACME_PRICED_ROW } from './fixtures/prices.js';

function record(overrides = {}) {
    return {
        recordId: 'r-1',
        timestamp: 1000,
        chatId: 'chat-a',
        origin: 'story',
        label: null,
        configuration: null,
        provider: 'openai',
        model: 'model-a',
        status: 'ok',
        usageSource: 'measured',
        // Every stored row carries the prefix diagnostics, decided on add.
        sharedPrefixTokens: null,
        possiblePrefixBreaker: false,
        promptTokens: 10,
        hitTokens: 4,
        completionTokens: 4,
        ...overrides,
    };
}

function createStorage(initial = {}) {
    const entries = new Map(Object.entries(initial));
    return {
        getItem(key) {
            return entries.has(key) ? entries.get(key) : null;
        },
        setItem(key, value) {
            entries.set(key, String(value));
        },
        read(key) {
            const raw = entries.get(key);
            return raw == null ? null : JSON.parse(raw);
        },
    };
}

/**
 * A ledger over one fake `chat_metadata` object per open chat, a fake local
 * storage and an injected clock, as the entry module wires it.
 */
function createHarness({
    chatId = 'chat-a',
    metadata = {},
    storage = createStorage(),
    saveMetadata = vi.fn(),
    now = () => 5000,
    debounceMs = 1000,
    sanitizeChatFileName = null,
} = {}) {
    const state = { chatId, metadata };
    const createLedger = () => new UsageLedger({
        getChatId: () => state.chatId,
        getMetadata: () => state.metadata,
        saveMetadata,
        storage,
        now,
        debounceMs,
        sanitizeChatFileName,
    });
    return { ledger: createLedger(), createLedger, state, storage, saveMetadata };
}

function switchChat(harness, chatId, metadata = {}) {
    harness.state.chatId = chatId;
    harness.state.metadata = metadata;
    harness.ledger.handleChatChanged(chatId);
}

function buildRecords(count, overrides = {}) {
    return Array.from({ length: count }, (_, index) => record({
        recordId: `r-${index + 1}`,
        timestamp: index + 1,
        ...overrides,
    }));
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('Spendbook ledger', () => {
    it('starts an untouched chat without a spendbook namespace', () => {
        const { ledger, state } = createHarness();

        expect(ledger.recordsFor('chat-a')).toEqual([]);
        expect(state.metadata).toEqual({});
    });

    it('writes a record into chat_metadata.spendbook_usage and leaves other metadata alone', () => {
        const { ledger, state } = createHarness({ metadata: { world_info: 'kept' } });
        const entry = record();

        ledger.add(entry);

        expect(state.metadata.world_info).toBe('kept');
        expect(state.metadata[USAGE_CHAT_METADATA_KEY].ownerChatId).toBe('chat-a');
        expect(state.metadata[USAGE_CHAT_METADATA_KEY].records).toEqual([entry]);
    });

    it('returns a chat’s records newest first', () => {
        const { ledger } = createHarness();
        ledger.add(record({ recordId: 'old', timestamp: 1000 }));
        ledger.add(record({ recordId: 'new', timestamp: 2000 }));

        expect(ledger.recordsFor('chat-a').map((row) => row.recordId)).toEqual(['new', 'old']);
    });

    it('reads a persisted namespace back with the chat, on a fresh ledger', () => {
        const { ledger, state, createLedger, saveMetadata } = createHarness();
        ledger.add(record());
        ledger.flush();
        expect(saveMetadata).toHaveBeenCalledTimes(1);

        const reloaded = createLedger();
        reloaded.loadChat('chat-a');

        expect(reloaded.recordsFor('chat-a')).toEqual([record()]);
        expect(state.metadata[USAGE_CHAT_METADATA_KEY].records).toHaveLength(1);
    });

    it('keeps records for a chat that is not open out of the open chat’s metadata', () => {
        const { ledger, state } = createHarness({ chatId: 'chat-b' });

        ledger.add(record({ chatId: 'chat-a' }));
        ledger.add(record({ recordId: 'r-2', chatId: 'chat-b' }));

        expect(state.metadata[USAGE_CHAT_METADATA_KEY].records.map((row) => row.recordId)).toEqual(['r-2']);
        expect(ledger.recordsFor('chat-a').map((row) => row.recordId)).toEqual(['r-1']);
    });

    it('starts clean when the persisted namespace belongs to another chat', () => {
        const metadata = {
            [USAGE_CHAT_METADATA_KEY]: {
                ownerChatId: 'chat-other',
                revision: 3,
                records: [record({ chatId: 'chat-other' })],
            },
        };
        const { ledger } = createHarness({ metadata });

        ledger.loadChat('chat-a');

        expect(ledger.recordsFor('chat-a')).toEqual([]);
        expect(metadata[USAGE_CHAT_METADATA_KEY]).toBeUndefined();
    });

    it('tolerates a malformed persisted namespace', () => {
        const metadata = { [USAGE_CHAT_METADATA_KEY]: { ownerChatId: 'chat-a', records: 'nope' } };
        const { ledger } = createHarness({ metadata });

        expect(() => ledger.loadChat('chat-a')).not.toThrow();
        expect(ledger.recordsFor('chat-a')).toEqual([]);
    });

    it('follows a chat switch to the new chat’s records', () => {
        const { ledger, state } = createHarness();

        state.chatId = 'chat-b';
        state.metadata = {
            [USAGE_CHAT_METADATA_KEY]: {
                ownerChatId: 'chat-b',
                revision: 1,
                records: [record({ chatId: 'chat-b' })],
            },
        };
        ledger.handleChatChanged('chat-b');

        expect(ledger.recordsFor('chat-b').map((row) => row.recordId)).toEqual(['r-1']);
    });
});

describe('Spendbook ledger — retention', () => {
    it('keeps the newest 500 rows and folds the 501st into the totals', () => {
        const { ledger } = createHarness();

        for (let index = 1; index <= USAGE_RECORD_LIMIT + 1; index += 1) {
            ledger.add(record({
                recordId: `r-${index}`,
                timestamp: index,
                origin: index === 1 ? 'internal' : 'story',
                configuration: index === 1 ? 'batch-8' : null,
                promptTokens: index === 1 ? 10 : 20,
                hitTokens: 0,
            }));
        }

        const retained = ledger.recordsFor('chat-a');
        expect(retained).toHaveLength(USAGE_RECORD_LIMIT);
        expect(retained[0].recordId).toBe('r-501');
        expect(retained.at(-1).recordId).toBe('r-2');

        const archived = ledger.archivedFor('chat-a');
        expect(archived.total).toMatchObject({ requests: 1, promptTokens: 10 });
        expect(archived.byOrigin.internal).toMatchObject({ requests: 1, promptTokens: 10 });
        expect(archived.byOrigin.story).toBeUndefined();
        expect(archived.byConfiguration['batch-8'].accumulator).toMatchObject({ requests: 1 });
        expect(ledger.retentionFor('chat-a')).toEqual({ limit: 500, retained: 500, total: 501 });
    });

    it('keeps a failed row in the folded counters, not in the completed ones', () => {
        const { ledger } = createHarness();

        ledger.add(record({ status: 'error', usageSource: 'unavailable', promptTokens: null, hitTokens: null }));
        for (let index = 0; index < USAGE_RECORD_LIMIT; index += 1) ledger.add(record({ recordId: `r-${index + 2}` }));

        expect(ledger.archivedFor('chat-a').total).toMatchObject({
            requests: 0,
            excludedRequests: 1,
            promptTokens: 0,
        });
        expect(ledger.retentionFor('chat-a').total).toBe(501);
    });

    it('reports a chat with no rows at all', () => {
        const { ledger } = createHarness();

        expect(ledger.retentionFor('chat-a')).toEqual({ limit: 500, retained: 0, total: 0 });
    });

    it('restores the folded counters with the chat', () => {
        const { ledger, createLedger } = createHarness();
        for (const entry of buildRecords(501)) ledger.add(entry);
        ledger.flush();

        const reloaded = createLedger();
        reloaded.loadChat('chat-a');

        expect(reloaded.retentionFor('chat-a')).toEqual({ limit: 500, retained: 500, total: 501 });
        expect(reloaded.archivedFor('chat-a').total.requests).toBe(1);
    });

    it('keeps the price inputs of a row it evicts, so it can still be priced', () => {
        const harness = createHarness();
        harness.ledger.add(record({
            ...ACME_PRICED_ROW,
            promptTokens: 1000,
            hitTokens: 400,
            completionTokens: 200,
        }));
        for (let index = 2; index <= USAGE_RECORD_LIMIT + 1; index += 1) {
            harness.ledger.add(record({ recordId: `r-${index}`, timestamp: index }));
        }
        harness.ledger.flush();

        const archived = harness.ledger.archivedFor('chat-a');
        expect(archived.total.requests).toBe(1);
        expect(archived.byModel['acme\u0000m1\u0000story'].unpricedCost).toMatchObject({
            requests: 1,
            promptTokens: 1000,
            hitTokens: 400,
            completionTokens: 200,
        });

        // The folded inputs survive a reload of the chat, so the totals can
        // price them with whatever table is in force later.
        const reloaded = harness.createLedger();
        reloaded.loadChat('chat-a');
        expect(reloaded.archivedFor('chat-a').byModel['acme\u0000m1\u0000story'].unpricedCost.hitTokens).toBe(400);
    });

    it('counts every chat in the all-time total', () => {
        const harness = createHarness();
        harness.ledger.add(record());
        harness.ledger.add(record({ recordId: 'r-2' }));

        switchChat(harness, 'chat-b');
        harness.ledger.add(record({ recordId: 'r-3', chatId: 'chat-b' }));

        expect(harness.ledger.allTimeForView()).toEqual({
            totals: expect.objectContaining({ requests: 3, promptTokens: 30 }),
            chats: 2,
        });
    });

    it('survives a reload from local storage', () => {
        const { ledger, createLedger, storage } = createHarness();
        ledger.add(record());
        ledger.flush();

        const reloaded = createLedger();
        expect(reloaded.allTimeForView()).toEqual({
            totals: expect.objectContaining({ requests: 1, promptTokens: 10 }),
            chats: 1,
        });
        expect(storage.read(USAGE_ALL_TIME_STORAGE_KEY).updatedAt).toBe(5000);
    });

    it('persists the all-time total with the record, before the debounce', () => {
        const harness = createHarness();

        harness.ledger.add(record());

        expect(harness.storage.read(USAGE_ALL_TIME_STORAGE_KEY).totals).toMatchObject({ requests: 1 });
        expect(harness.saveMetadata).not.toHaveBeenCalled();
    });

    it('flushes a pending all-time write when the chat changes', () => {
        const harness = createHarness();
        harness.ledger.add(record());

        switchChat(harness, 'chat-b');

        expect(harness.storage.read(USAGE_ALL_TIME_STORAGE_KEY).totals).toMatchObject({ requests: 1 });
        expect(harness.storage.read(USAGE_ALL_TIME_STORAGE_KEY).chats).toHaveProperty('chat-a');
    });

    it('resets all-time without touching any chat’s rows', () => {
        const harness = createHarness();
        harness.ledger.add(record());
        harness.ledger.flush();

        harness.ledger.resetAllTime();

        expect(harness.ledger.allTimeForView()).toEqual({
            totals: expect.objectContaining({ requests: 0 }),
            chats: 0,
        });
        expect(harness.ledger.recordsFor('chat-a')).toHaveLength(1);
        expect(harness.ledger.retentionFor('chat-a').total).toBe(1);

        const reloaded = harness.createLedger();
        reloaded.loadChat('chat-a');
        expect(reloaded.allTimeForView().chats).toBe(0);
        expect(reloaded.recordsFor('chat-a')).toHaveLength(1);
    });

    it('treats a repeated all-time reset as a no-op', () => {
        const harness = createHarness();
        harness.ledger.add(record());

        harness.ledger.resetAllTime();
        expect(() => harness.ledger.resetAllTime()).not.toThrow();

        expect(harness.ledger.allTimeForView().totals.requests).toBe(0);
        expect(harness.ledger.recordsFor('chat-a')).toHaveLength(1);
    });
});

describe('Spendbook ledger — pending save', () => {
    it('debounces the metadata save but writes the namespace through immediately', () => {
        const { ledger, state, saveMetadata } = createHarness();

        ledger.add(record());

        expect(saveMetadata).not.toHaveBeenCalled();
        expect(state.metadata[USAGE_CHAT_METADATA_KEY].records).toHaveLength(1);

        vi.advanceTimersByTime(1000);
        expect(saveMetadata).toHaveBeenCalledTimes(1);
    });

    it('replays a record added inside the debounce when the chat is opened again', () => {
        const harness = createHarness();
        harness.ledger.loadChat('chat-a');
        harness.ledger.add(record());

        switchChat(harness, 'chat-b');
        harness.state.chatId = 'chat-a';
        harness.state.metadata = {};
        const reloaded = harness.createLedger();
        reloaded.loadChat('chat-a');

        expect(reloaded.recordsFor('chat-a').map((row) => row.recordId)).toEqual(['r-1']);
        expect(reloaded.retentionFor('chat-a').total).toBe(1);
    });

    it('writes a record that landed for a closed chat back on its first open', () => {
        const harness = createHarness();
        harness.ledger.add(record());
        switchChat(harness, 'chat-b');

        harness.state.chatId = 'chat-a';
        harness.state.metadata = {
            [USAGE_CHAT_METADATA_KEY]: { ownerChatId: 'chat-a', revision: 0, records: [] },
        };
        harness.ledger.handleChatChanged('chat-a');

        expect(harness.state.metadata[USAGE_CHAT_METADATA_KEY].records).toHaveLength(1);
        expect(harness.ledger.recordsFor('chat-a')).toHaveLength(1);
    });

    it('replays the folded counters too, so a capped row is not lost with the save', () => {
        const harness = createHarness();
        harness.ledger.loadChat('chat-a');
        for (const entry of buildRecords(501)) harness.ledger.add(entry);

        switchChat(harness, 'chat-b');
        harness.state.chatId = 'chat-a';
        harness.state.metadata = {};
        const reloaded = harness.createLedger();
        reloaded.loadChat('chat-a');

        expect(reloaded.retentionFor('chat-a')).toEqual({ limit: 500, retained: 500, total: 501 });
        expect(reloaded.archivedFor('chat-a').total.requests).toBe(1);
    });

    it('flushes a pending row when the page hides', () => {
        const { ledger, state, storage, saveMetadata } = createHarness();
        ledger.add(record());

        ledger.flush();

        expect(saveMetadata).toHaveBeenCalledTimes(1);
        expect(state.metadata[USAGE_CHAT_METADATA_KEY].records).toHaveLength(1);
        expect(storage.read(USAGE_ALL_TIME_STORAGE_KEY).totals).toMatchObject({ requests: 1 });
    });

    it('drops the pending copy once the chat file has caught up', () => {
        const harness = createHarness();
        harness.ledger.add(record());
        harness.ledger.flush();

        const reloaded = harness.createLedger();
        reloaded.loadChat('chat-a');

        expect(harness.storage.read(USAGE_PENDING_STORAGE_KEY).chats).toEqual({});
        expect(reloaded.recordsFor('chat-a')).toHaveLength(1);
    });

    it('keeps capturing when local storage rejects a write', () => {
        const storage = {
            getItem: () => null,
            setItem: () => {
                throw new Error('quota exceeded');
            },
        };
        const { ledger } = createHarness({ storage });

        expect(() => ledger.add(record())).not.toThrow();
        expect(ledger.recordsFor('chat-a')).toHaveLength(1);
        expect(ledger.allTimeForView().totals.requests).toBe(1);
    });

    it('keeps capturing when the metadata save rejects', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const saveMetadata = vi.fn(() => Promise.reject(new Error('save failed')));
        const { ledger } = createHarness({ saveMetadata });

        ledger.add(record());
        ledger.flush();
        await Promise.resolve();

        expect(ledger.recordsFor('chat-a')).toHaveLength(1);
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
    });
});

describe('Spendbook ledger — delete and rename', () => {
    it('deleting a chat removes its rows, folded counters, pending copy and bucket', () => {
        const harness = createHarness();
        harness.ledger.add(record());
        harness.ledger.add(record({ recordId: 'r-2', chatId: 'chat-b' }));
        harness.ledger.flush();
        expect(harness.ledger.allTimeForView().chats).toBe(2);

        harness.ledger.handleChatDeleted('chat-a');

        expect(harness.ledger.recordsFor('chat-a')).toEqual([]);
        expect(harness.ledger.allTimeForView()).toEqual({
            totals: expect.objectContaining({ requests: 1 }),
            chats: 1,
        });
        expect(harness.storage.read(USAGE_ALL_TIME_STORAGE_KEY).chats).not.toHaveProperty('chat-a');
        expect(harness.ledger.recordsFor('chat-b')).toHaveLength(1);
    });

    it('deleting the open chat removes its namespace and leaves the other chat’s metadata', () => {
        const otherMetadata = { world_info: 'kept' };
        const harness = createHarness({ metadata: { ...otherMetadata } });
        harness.ledger.add(record());

        harness.ledger.handleChatDeleted('chat-a');

        expect(harness.state.metadata.world_info).toBe('kept');
        expect(harness.state.metadata[USAGE_CHAT_METADATA_KEY]).toBeUndefined();
    });

    it('deleting a chat still clears its bucket when the metadata save fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const saveMetadata = vi.fn(() => Promise.reject(new Error('save failed')));
        const harness = createHarness({ saveMetadata });
        harness.ledger.add(record());
        harness.ledger.flush();

        harness.ledger.handleChatDeleted('chat-a');
        await Promise.resolve();

        expect(harness.ledger.recordsFor('chat-a')).toEqual([]);
        expect(harness.ledger.allTimeForView().totals.requests).toBe(0);
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it('treats a repeated delete as a no-op and never subtracts below zero', () => {
        const harness = createHarness();
        harness.ledger.add(record());

        harness.ledger.handleChatDeleted('chat-a');
        expect(() => harness.ledger.handleChatDeleted('chat-a')).not.toThrow();

        expect(harness.ledger.allTimeForView().totals.requests).toBe(0);
        expect(harness.ledger.recordsFor('chat-a')).toEqual([]);
    });

    it('renames a chat that is not open to the server-sanitized id', async () => {
        const harness = createHarness({
            chatId: 'chat-b',
            sanitizeChatFileName: async (name) => name.replace(/\s+/g, '-'),
        });
        harness.ledger.add(record());
        harness.ledger.flush();

        await harness.ledger.handleChatRenamed('chat-a', 'Chat A.jsonl');

        expect(harness.ledger.recordsFor('Chat-A')).toHaveLength(1);
        expect(harness.ledger.recordsFor('chat-a')).toEqual([]);
        expect(harness.ledger.allTimeForView()).toEqual({
            totals: expect.objectContaining({ requests: 1 }),
            chats: 1,
        });
        expect(harness.storage.read(USAGE_ALL_TIME_STORAGE_KEY).chats).toHaveProperty('Chat-A');
        expect(harness.storage.read(USAGE_ALL_TIME_STORAGE_KEY).chats).not.toHaveProperty('chat-a');
    });

    it('carries a renamed chat’s folded counters and pending copy to its new id', async () => {
        const harness = createHarness({ chatId: 'chat-b' });
        for (const entry of buildRecords(501)) harness.ledger.add(entry);

        await harness.ledger.handleChatRenamed('chat-a', 'chat-renamed');

        expect(harness.ledger.retentionFor('chat-renamed')).toEqual({ limit: 500, retained: 500, total: 501 });
        expect(harness.ledger.archivedFor('chat-renamed').total.requests).toBe(1);
        expect(harness.storage.read(USAGE_PENDING_STORAGE_KEY).chats).toHaveProperty('chat-renamed');
        expect(harness.storage.read(USAGE_PENDING_STORAGE_KEY).chats).not.toHaveProperty('chat-a');
    });

    it('moves the open chat to the id the rename reload actually opened', async () => {
        const sanitizeChatFileName = vi.fn(async () => 'server-sanitized');
        const harness = createHarness({ chatId: 'chat-a', sanitizeChatFileName });
        harness.ledger.add(record());

        harness.state.chatId = 'server-sanitized';
        harness.state.metadata = {};
        harness.ledger.handleChatChanged('server-sanitized');
        await harness.ledger.handleChatRenamed('chat-a', 'Requested Name.jsonl', {
            previousChatId: 'chat-a',
            currentChatId: 'server-sanitized',
        });

        expect(sanitizeChatFileName).toHaveBeenCalledWith('Requested Name');
        expect(harness.ledger.recordsFor('server-sanitized')).toHaveLength(1);
        expect(harness.state.metadata[USAGE_CHAT_METADATA_KEY].ownerChatId).toBe('server-sanitized');
        expect(harness.saveMetadata).toHaveBeenCalled();
    });

    it('does not mistake a rename of the chat it left for a rename of the open one', async () => {
        const harness = createHarness({
            chatId: 'chat-a',
            sanitizeChatFileName: async (name) => name.replace(/\s+/g, '-'),
        });
        harness.ledger.add(record());
        switchChat(harness, 'chat-b');
        harness.ledger.add(record({ recordId: 'r-b', chatId: 'chat-b' }));

        await harness.ledger.handleChatRenamed('chat-a', 'Chat A.jsonl', {
            previousChatId: 'chat-a',
            currentChatId: 'chat-b',
        });

        expect(harness.ledger.recordsFor('Chat-A')).toHaveLength(1);
        expect(harness.ledger.recordsFor('chat-b').map((entry) => entry.recordId)).toEqual(['r-b']);
        expect(harness.ledger.allTimeForView().chats).toBe(2);
    });

    it('keeps the rows of a renamed chat that was never opened in this session', async () => {
        const harness = createHarness({ chatId: 'chat-b' });
        await harness.ledger.handleChatRenamed('chat-a', 'chat-renamed');

        // The renamed file is the only copy of the rows, and it still names the
        // old id, so the alias is what proves they belong to this chat.
        expect(harness.storage.read(USAGE_PENDING_STORAGE_KEY).renames).toEqual({ 'chat-a': 'chat-renamed' });
        harness.state.chatId = 'chat-renamed';
        harness.state.metadata = {
            [USAGE_CHAT_METADATA_KEY]: { ownerChatId: 'chat-a', revision: 3, records: [record()] },
        };
        const reloaded = harness.createLedger();
        reloaded.loadChat('chat-renamed');

        expect(reloaded.recordsFor('chat-renamed')).toHaveLength(1);
        expect(harness.state.metadata[USAGE_CHAT_METADATA_KEY].ownerChatId).toBe('chat-renamed');

        // Once the file itself names the chat, the alias is dropped.
        const third = harness.createLedger();
        third.loadChat('chat-renamed');
        expect(harness.storage.read(USAGE_PENDING_STORAGE_KEY).renames).toEqual({});
        expect(third.recordsFor('chat-renamed')).toHaveLength(1);
    });

    it('follows a rename chain when the file still names the first id', async () => {
        const harness = createHarness({ chatId: 'chat-b' });
        await harness.ledger.handleChatRenamed('chat-a', 'chat-b-renamed');
        await harness.ledger.handleChatRenamed('chat-b-renamed', 'chat-c-renamed');

        harness.state.chatId = 'chat-c-renamed';
        harness.state.metadata = {
            [USAGE_CHAT_METADATA_KEY]: { ownerChatId: 'chat-a', revision: 1, records: [record()] },
        };
        const reloaded = harness.createLedger();
        reloaded.loadChat('chat-c-renamed');

        expect(reloaded.recordsFor('chat-c-renamed')).toHaveLength(1);
    });

    it('merges both sides’ folded counters when a rename collides with a live chat', async () => {
        const harness = createHarness({ chatId: 'chat-b', storage: null });
        for (const entry of buildRecords(501)) harness.ledger.add(entry);
        for (const entry of buildRecords(501, { chatId: 'chat-b' })) harness.ledger.add(entry);

        await harness.ledger.handleChatRenamed('chat-a', 'chat-b');

        expect(harness.ledger.archivedFor('chat-b').total.requests).toBe(2);
    });

    it('lets a renamed chat that was not open adopt its moved rows on the next open', async () => {
        const harness = createHarness({ chatId: 'chat-b' });
        harness.ledger.add(record());
        await harness.ledger.handleChatRenamed('chat-a', 'chat-renamed');

        // The renamed file still carries the namespace owned by the old id.
        harness.state.chatId = 'chat-renamed';
        harness.state.metadata = {
            [USAGE_CHAT_METADATA_KEY]: {
                ownerChatId: 'chat-a',
                revision: 1,
                records: [record()],
            },
        };
        const reloaded = harness.createLedger();
        reloaded.loadChat('chat-renamed');

        expect(reloaded.recordsFor('chat-renamed')).toHaveLength(1);
        expect(harness.state.metadata[USAGE_CHAT_METADATA_KEY].ownerChatId).toBe('chat-renamed');
    });

    it('renaming the open chat still moves its rows when the metadata save fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const saveMetadata = vi.fn(() => Promise.reject(new Error('save failed')));
        const harness = createHarness({
            chatId: 'chat-a',
            saveMetadata,
            sanitizeChatFileName: async () => 'chat-renamed',
        });
        harness.ledger.add(record());
        harness.state.chatId = 'chat-renamed';
        harness.state.metadata = {};
        harness.ledger.handleChatChanged('chat-renamed');

        await harness.ledger.handleChatRenamed('chat-a', 'chat-renamed', {
            previousChatId: 'chat-a',
            currentChatId: 'chat-renamed',
        });
        await Promise.resolve();

        expect(harness.ledger.recordsFor('chat-renamed')).toHaveLength(1);
        expect(harness.ledger.allTimeForView()).toEqual({
            totals: expect.objectContaining({ requests: 1 }),
            chats: 1,
        });
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it('treats a repeated rename as a no-op for the all-time totals', async () => {
        const harness = createHarness({ chatId: 'chat-b' });
        harness.ledger.add(record());

        await harness.ledger.handleChatRenamed('chat-a', 'chat-renamed');
        await harness.ledger.handleChatRenamed('chat-a', 'chat-renamed');

        expect(harness.ledger.allTimeForView()).toEqual({
            totals: expect.objectContaining({ requests: 1 }),
            chats: 1,
        });
    });

    it('leaves the copied namespace of a branch behind and starts clean', () => {
        const harness = createHarness();
        harness.ledger.add(record());

        switchChat(harness, 'chat-branch', {
            [USAGE_CHAT_METADATA_KEY]: {
                ownerChatId: 'chat-a',
                revision: 1,
                records: [record()],
            },
        });

        expect(harness.ledger.recordsFor('chat-branch')).toEqual([]);
        expect(harness.state.metadata[USAGE_CHAT_METADATA_KEY]).toBeUndefined();
        expect(harness.ledger.allTimeForView()).toEqual({
            totals: expect.objectContaining({ requests: 1 }),
            chats: 1,
        });
    });
});

describe('Spendbook ledger — reset this chat', () => {
    it('clears this chat’s rows, folded counters, namespace and bucket, and only its own', () => {
        const harness = createHarness();
        for (const entry of buildRecords(501)) harness.ledger.add(entry);
        harness.ledger.add(record({ recordId: 'r-b', chatId: 'chat-b' }));
        harness.ledger.flush();

        harness.ledger.resetChat('chat-a');

        expect(harness.ledger.recordsFor('chat-a')).toEqual([]);
        expect(harness.ledger.retentionFor('chat-a')).toEqual({ limit: 500, retained: 0, total: 0 });
        expect(harness.state.metadata[USAGE_CHAT_METADATA_KEY]).toBeUndefined();
        // An empty tombstone stays behind so a failed save cannot restore the rows.
        expect(harness.storage.read(USAGE_PENDING_STORAGE_KEY).chats['chat-a'].records).toEqual([]);
        expect(harness.storage.read(USAGE_PENDING_STORAGE_KEY).chats['chat-a'].revision).toBeGreaterThan(0);
        expect(harness.ledger.recordsFor('chat-b')).toHaveLength(1);
        expect(harness.ledger.allTimeForView()).toEqual({
            totals: expect.objectContaining({ requests: 1 }),
            chats: 1,
        });
    });

    it('treats a repeated reset as a no-op', () => {
        const harness = createHarness();
        harness.ledger.add(record());

        harness.ledger.resetChat('chat-a');
        expect(() => harness.ledger.resetChat('chat-a')).not.toThrow();

        expect(harness.ledger.recordsFor('chat-a')).toEqual([]);
        expect(harness.ledger.allTimeForView().totals.requests).toBe(0);
    });

    it('cannot restore the reset rows when the metadata save fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const saveMetadata = vi.fn(() => Promise.reject(new Error('save failed')));
        const harness = createHarness({ saveMetadata });
        harness.ledger.add(record());
        harness.ledger.flush();
        const persisted = harness.state.metadata[USAGE_CHAT_METADATA_KEY];
        const staleNamespace = { ...persisted, records: [...persisted.records] };

        harness.ledger.resetChat('chat-a');
        harness.ledger.resetChat('chat-a');

        // The chat file still holds the saved namespace because the save failed.
        harness.state.metadata = { [USAGE_CHAT_METADATA_KEY]: staleNamespace };
        const reloaded = harness.createLedger();
        reloaded.loadChat('chat-a');

        await Promise.resolve();
        expect(reloaded.recordsFor('chat-a')).toEqual([]);
        expect(reloaded.retentionFor('chat-a').total).toBe(0);
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
    });
});

describe('Spendbook ledger — measurement runs', () => {
    it('starts a run in the open chat with an id, a label and a start time, and makes it current', () => {
        const harness = createHarness({ now: () => 9000 });

        const run = harness.ledger.startRun({ label: 'batch 30' });

        expect(run).toEqual({ runId: expect.any(String), label: 'batch 30', startedAt: 9000 });
        expect(harness.ledger.runsFor('chat-a')).toEqual({ runs: [run], currentRunId: run.runId });
        expect(harness.ledger.currentRunIdFor('chat-a')).toBe(run.runId);
    });

    it('names an unlabelled run by its ordinal and tidies a pasted label', () => {
        const harness = createHarness();

        expect(harness.ledger.startRun().label).toBe('Run 1');
        expect(harness.ledger.startRun({ label: '  batch   30  ' }).label).toBe('batch 30');
        expect(harness.ledger.startRun({ label: '   ' }).label).toBe('Run 3');
    });

    it('keeps the earlier run listed and makes the newest one current', () => {
        let now = 9000;
        const harness = createHarness({ now: () => now });
        const first = harness.ledger.startRun({ label: 'before' });
        now = 9100;
        const second = harness.ledger.startRun({ label: 'after' });

        expect(harness.ledger.runsFor('chat-a')).toEqual({
            runs: [second, first],
            currentRunId: second.runId,
        });
        expect(harness.ledger.currentRunIdFor('chat-a')).toBe(second.runId);
    });

    it('reads the runs back with the chat on a fresh ledger', () => {
        const harness = createHarness();
        const first = harness.ledger.startRun({ label: 'before' });
        const second = harness.ledger.startRun({ label: 'after' });

        const reloaded = harness.createLedger();
        reloaded.loadChat('chat-a');

        expect(reloaded.runsFor('chat-a')).toEqual({ runs: [second, first], currentRunId: second.runId });
        expect(reloaded.currentRunIdFor('chat-a')).toBe(second.runId);
    });

    it('keeps one chat’s runs out of another chat', () => {
        const harness = createHarness();
        const run = harness.ledger.startRun({ label: 'batch 30' });

        switchChat(harness, 'chat-b');

        expect(harness.ledger.runsFor('chat-b')).toEqual({ runs: [], currentRunId: null });
        expect(harness.ledger.currentRunIdFor('chat-b')).toBeNull();

        const other = harness.ledger.startRun({ label: 'another chat' });
        switchChat(harness, 'chat-a');

        expect(harness.ledger.runsFor('chat-a')).toEqual({ runs: [run], currentRunId: run.runId });
        expect(other.runId).not.toBe(run.runId);
    });

    it('has no run to start without an open chat', () => {
        const harness = createHarness({ chatId: null });

        expect(harness.ledger.startRun({ label: 'nowhere' })).toBeNull();
        expect(harness.ledger.runsFor(null)).toEqual({ runs: [], currentRunId: null });
    });

    it('drops a chat’s runs with its rows when the chat is reset', () => {
        const harness = createHarness();
        harness.ledger.startRun({ label: 'batch 30' });
        harness.ledger.add(record());

        harness.ledger.resetChat('chat-a');

        expect(harness.ledger.runsFor('chat-a')).toEqual({ runs: [], currentRunId: null });
        expect(harness.ledger.currentRunIdFor('chat-a')).toBeNull();

        const reloaded = harness.createLedger();
        reloaded.loadChat('chat-a');
        expect(reloaded.runsFor('chat-a')).toEqual({ runs: [], currentRunId: null });
    });

    it('carries a chat’s runs to its renamed id', async () => {
        const harness = createHarness({ chatId: 'chat-b' });
        const run = harness.ledger.startRun({ chatId: 'chat-a', label: 'batch 30' });

        await harness.ledger.handleChatRenamed('chat-a', 'chat-renamed');

        expect(harness.ledger.runsFor('chat-renamed')).toEqual({ runs: [run], currentRunId: run.runId });
        expect(harness.ledger.runsFor('chat-a')).toEqual({ runs: [], currentRunId: null });
    });

    it('keeps the later run current when a rename merges two chats’ runs', async () => {
        let now = 9000;
        const harness = createHarness({ chatId: 'chat-b', now: () => now });
        const older = harness.ledger.startRun({ chatId: 'chat-b', label: 'b-old' });
        now = 9200;
        const newer = harness.ledger.startRun({ chatId: 'chat-a', label: 'a-new' });

        await harness.ledger.handleChatRenamed('chat-a', 'chat-b');

        expect(harness.ledger.runsFor('chat-b')).toEqual({
            runs: [newer, older],
            currentRunId: newer.runId,
        });
    });

    it('ignores a persisted run it cannot use and a current id that names none', () => {
        const harness = createHarness({
            metadata: {
                [USAGE_CHAT_METADATA_KEY]: {
                    ownerChatId: 'chat-a',
                    revision: 3,
                    records: [],
                    runs: [
                        { label: 'no id', startedAt: 1 },
                        { runId: 'run-1', label: 'kept', startedAt: 2 },
                        { runId: 'run-1', label: 'duplicate', startedAt: 3 },
                    ],
                    currentRunId: 'run-missing',
                },
            },
        });

        harness.ledger.loadChat('chat-a');

        expect(harness.ledger.runsFor('chat-a')).toEqual({
            runs: [{ runId: 'run-1', label: 'kept', startedAt: 2 }],
            currentRunId: null,
        });
    });
});

/**
 * A fingerprint as the observer hands it over beside the record: hashes and
 * per-message token counts. The ledger consumes it and stores only the
 * per-identity baseline.
 */
function fingerprint(overrides = {}) {
    return {
        provider: 'deepseek',
        model: 'deepseek-flash',
        origin: 'story',
        messages: [
            { hash: 11, tokens: 1500 },
            { hash: 22, tokens: 600 },
        ],
        ...overrides,
    };
}

function fingerprintWithReply(overrides = {}) {
    return fingerprint({
        messages: [
            { hash: 11, tokens: 1500 },
            { hash: 22, tokens: 600 },
            { hash: 33, tokens: 30 },
        ],
        ...overrides,
    });
}

/** Adds one row the way the observer does: the record, and its fingerprint beside it. */
function addWithFingerprint(ledger, overrides, print) {
    const entry = record(overrides);
    ledger.add(entry, print);
    return entry;
}

function persistedFingerprints(harness) {
    return Object.values(harness.state.metadata[USAGE_CHAT_METADATA_KEY]?.promptFingerprints ?? {});
}

describe('Spendbook ledger — prefix diagnostics', () => {
    it('compares a row with its comparable predecessor and flags a long zero-hit prefix', () => {
        const harness = createHarness();
        harness.ledger.loadChat('chat-a');

        addWithFingerprint(harness.ledger, { recordId: 'r-1', hitTokens: 1 }, fingerprint());
        const next = addWithFingerprint(harness.ledger, { recordId: 'r-2', hitTokens: 0 }, fingerprintWithReply());

        // 1500 + 600 from the matched messages; the reply is not shared.
        expect(next.sharedPrefixTokens).toBe(2100);
        expect(next.possiblePrefixBreaker).toBe(true);
        expect(harness.ledger.recordsFor('chat-a')[1].sharedPrefixTokens).toBeNull();
    });

    it('carries the baseline across a reload so the next request still compares', () => {
        const harness = createHarness();
        harness.ledger.loadChat('chat-a');
        addWithFingerprint(harness.ledger, { recordId: 'r-1', hitTokens: 1 }, fingerprint());
        harness.ledger.flush();

        const reloaded = harness.createLedger();
        reloaded.loadChat('chat-a');
        const next = addWithFingerprint(reloaded, { recordId: 'r-2', hitTokens: 0 }, fingerprintWithReply());

        expect(next.sharedPrefixTokens).toBe(2100);
        expect(next.possiblePrefixBreaker).toBe(true);
        // One baseline per identity — not one per row — replaced by the latest
        // comparable prompt: hashes and counts only, never the text.
        const persisted = persistedFingerprints(harness);
        expect(persisted).toHaveLength(1);
        expect(persisted[0].messages).toHaveLength(3);
        expect(persisted[0].messages.every((message) => !('content' in message))).toBe(true);
    });

    it('flags at exactly 2,048 shared tokens and not at 2,047', () => {
        const harness = createHarness();
        harness.ledger.loadChat('chat-a');
        addWithFingerprint(harness.ledger, { recordId: 'r-1' }, fingerprint({
            messages: [{ hash: 11, tokens: 1500 }, { hash: 22, tokens: 548 }],
        }));

        const exactly = addWithFingerprint(harness.ledger, { recordId: 'r-2', hitTokens: 0 }, fingerprint({
            messages: [{ hash: 11, tokens: 1500 }, { hash: 22, tokens: 548 }, { hash: 33, tokens: 100 }],
        }));
        expect(exactly.sharedPrefixTokens).toBe(2048);
        expect(exactly.possiblePrefixBreaker).toBe(true);

        const below = addWithFingerprint(harness.ledger, { recordId: 'r-3', hitTokens: 0 }, fingerprint({
            messages: [{ hash: 11, tokens: 1500 }, { hash: 22, tokens: 547 }, { hash: 44, tokens: 100 }],
        }));
        expect(below.sharedPrefixTokens).toBe(2047);
        expect(below.possiblePrefixBreaker).toBe(false);
    });

    it('compares each origin against its own baseline, so an interleaved call cannot hide a break', () => {
        const harness = createHarness();
        harness.ledger.loadChat('chat-a');
        addWithFingerprint(harness.ledger, { recordId: 'r-1', hitTokens: 1 }, fingerprint());

        const quiet = addWithFingerprint(harness.ledger, {
            recordId: 'r-2',
            origin: 'quiet',
            hitTokens: 0,
        }, fingerprint({
            origin: 'quiet',
            messages: [{ hash: 91, tokens: 5000 }],
        }));
        // The quiet call has its own baseline, so it shares nothing with the
        // story prompt even though that one is on screen.
        expect(quiet.sharedPrefixTokens).toBeNull();
        expect(quiet.possiblePrefixBreaker).toBe(false);

        const story = addWithFingerprint(harness.ledger, { recordId: 'r-3', hitTokens: 0 }, fingerprintWithReply());
        expect(story.sharedPrefixTokens).toBe(2100);
        expect(story.possiblePrefixBreaker).toBe(true);
    });

    it('keeps a separate baseline per provider and model', () => {
        const harness = createHarness();
        harness.ledger.loadChat('chat-a');
        addWithFingerprint(harness.ledger, { recordId: 'r-1', hitTokens: 1 }, fingerprint());

        const switched = addWithFingerprint(harness.ledger, {
            recordId: 'r-2',
            provider: 'openrouter',
            model: 'deepseek/deepseek-v3',
            hitTokens: 0,
        }, fingerprintWithReply({ provider: 'openrouter', model: 'deepseek/deepseek-v3' }));
        expect(switched.sharedPrefixTokens).toBeNull();

        const next = addWithFingerprint(harness.ledger, {
            recordId: 'r-3',
            provider: 'openrouter',
            model: 'deepseek/deepseek-v3',
            hitTokens: 0,
        }, fingerprintWithReply({ provider: 'openrouter', model: 'deepseek/deepseek-v3' }));
        // The switched request's own prompt is now the openrouter baseline,
        // reply included: this row shares all three of its messages.
        expect(next.sharedPrefixTokens).toBe(2130);
    });

    it('shows what a failed request shared without flagging it or moving the baseline', () => {
        const harness = createHarness();
        harness.ledger.loadChat('chat-a');
        addWithFingerprint(harness.ledger, { recordId: 'r-1', hitTokens: 1 }, fingerprint());

        const failed = addWithFingerprint(harness.ledger, {
            recordId: 'r-2',
            status: 'error',
            hitTokens: 0,
        }, fingerprintWithReply());
        expect(failed.sharedPrefixTokens).toBe(2100);
        expect(failed.possiblePrefixBreaker).toBe(false);

        const next = addWithFingerprint(harness.ledger, { recordId: 'r-3', hitTokens: 0 }, fingerprintWithReply());
        expect(next.sharedPrefixTokens).toBe(2100);
        expect(next.possiblePrefixBreaker).toBe(true);
    });

    it('drops the baselines with the chat’s state', () => {
        const harness = createHarness();
        harness.ledger.loadChat('chat-a');
        addWithFingerprint(harness.ledger, { recordId: 'r-1' }, fingerprint());

        harness.ledger.resetChat('chat-a');

        const next = addWithFingerprint(harness.ledger, { recordId: 'r-2', hitTokens: 0 }, fingerprintWithReply());
        expect(next.sharedPrefixTokens).toBeNull();
        expect(persistedFingerprints(harness)).toHaveLength(1);
    });

    it('moves the baselines with a renamed chat', async () => {
        const harness = createHarness({ chatId: 'chat-b' });
        addWithFingerprint(harness.ledger, { recordId: 'r-1' }, fingerprint());

        await harness.ledger.handleChatRenamed('chat-a', 'chat-renamed');

        const next = addWithFingerprint(harness.ledger, {
            recordId: 'r-2',
            chatId: 'chat-renamed',
            hitTokens: 0,
        }, fingerprintWithReply());
        expect(next.sharedPrefixTokens).toBe(2100);
        expect(next.possiblePrefixBreaker).toBe(true);
    });

    it('keeps both chats’ baselines when a rename merges two live chats', async () => {
        const harness = createHarness({ chatId: 'chat-c' });
        const routed = { provider: 'openrouter', model: 'deepseek/deepseek-v3' };
        // The chat being renamed into chat-b has a baseline for its own route.
        addWithFingerprint(harness.ledger, { chatId: 'chat-a', recordId: 'r-a', ...routed }, fingerprint(routed));
        // chat-b holds the baseline of the chat it is.
        addWithFingerprint(harness.ledger, { chatId: 'chat-b', recordId: 'r-b' }, fingerprint());

        await harness.ledger.handleChatRenamed('chat-a', 'chat-b');

        // The merged map keeps one baseline per identity, from both sides.
        const local = addWithFingerprint(harness.ledger, { chatId: 'chat-b', recordId: 'r-c', hitTokens: 0 }, fingerprintWithReply());
        expect(local.sharedPrefixTokens).toBe(2100);

        const moved = addWithFingerprint(harness.ledger, { chatId: 'chat-b', recordId: 'r-d', ...routed }, fingerprint({
            ...routed,
            messages: [{ hash: 11, tokens: 1500 }, { hash: 22, tokens: 600 }, { hash: 33, tokens: 30 }],
        }));
        expect(moved.sharedPrefixTokens).toBe(2100);
    });

    it('keeps a baseline the chat file does not describe when the chat is reopened', () => {
        const harness = createHarness();
        harness.ledger.loadChat('chat-a');
        const routed = { provider: 'openrouter', model: 'deepseek/deepseek-v3' };
        addWithFingerprint(harness.ledger, { recordId: 'r-1', ...routed }, fingerprint(routed));

        // The file moved on elsewhere (another tab, a later save) and knows only
        // the chat's own provider.
        const namespace = harness.state.metadata[USAGE_CHAT_METADATA_KEY];
        harness.state.metadata[USAGE_CHAT_METADATA_KEY] = {
            ...namespace,
            revision: namespace.revision + 5,
            promptFingerprints: { '["deepseek","deepseek-flash","story"]': fingerprint() },
        };
        harness.ledger.loadChat('chat-a');

        // The file's baseline is in force...
        const local = addWithFingerprint(harness.ledger, { recordId: 'r-2', hitTokens: 0 }, fingerprintWithReply());
        expect(local.sharedPrefixTokens).toBe(2100);
        // ...and the one the ledger held for the other route survived the load.
        const moved = addWithFingerprint(harness.ledger, { recordId: 'r-3', ...routed }, fingerprint({
            ...routed,
            messages: [{ hash: 11, tokens: 1500 }, { hash: 22, tokens: 600 }, { hash: 33, tokens: 30 }],
        }));
        expect(moved.sharedPrefixTokens).toBe(2100);
    });

    it('wins the identity with the chat file when both sides know it', () => {
        const harness = createHarness();
        harness.ledger.loadChat('chat-a');
        addWithFingerprint(harness.ledger, { recordId: 'r-1' }, fingerprint());

        // The file knows the same identity with a different second message, at a
        // newer revision.
        const namespace = harness.state.metadata[USAGE_CHAT_METADATA_KEY];
        harness.state.metadata[USAGE_CHAT_METADATA_KEY] = {
            ...namespace,
            revision: namespace.revision + 5,
            promptFingerprints: {
                '["deepseek","deepseek-flash","story"]': fingerprint({
                    messages: [{ hash: 11, tokens: 1500 }, { hash: 99, tokens: 800 }],
                }),
            },
        };
        harness.ledger.loadChat('chat-a');

        const next = addWithFingerprint(harness.ledger, { recordId: 'r-2', hitTokens: 0 }, fingerprintWithReply());
        // The file's baseline is the one in force: only the first message matches.
        expect(next.sharedPrefixTokens).toBe(1500);
    });

    it('keeps a baseline only the file knew when this page’s rows are newer', () => {
        const harness = createHarness({ storage: null });
        harness.ledger.loadChat('chat-a');
        addWithFingerprint(harness.ledger, { recordId: 'r-1' }, fingerprint());

        // The file is behind this page's rows, yet carries a route they never saw.
        const routed = { provider: 'openrouter', model: 'deepseek/deepseek-v3' };
        harness.state.metadata[USAGE_CHAT_METADATA_KEY] = {
            version: 1,
            ownerChatId: 'chat-a',
            revision: 0,
            records: [],
            runs: [],
            currentRunId: null,
            promptFingerprints: { '["openrouter","deepseek/deepseek-v3","story"]': fingerprint(routed) },
        };
        harness.ledger.loadChat('chat-a');

        // The page's rows and baseline were written through...
        const local = addWithFingerprint(harness.ledger, { recordId: 'r-2', hitTokens: 0 }, fingerprintWithReply());
        expect(local.sharedPrefixTokens).toBe(2100);
        // ...and the file's other route kept its comparison.
        const moved = addWithFingerprint(harness.ledger, { recordId: 'r-3', ...routed }, fingerprint({
            ...routed,
            messages: [{ hash: 11, tokens: 1500 }, { hash: 22, tokens: 600 }, { hash: 33, tokens: 30 }],
        }));
        expect(moved.sharedPrefixTokens).toBe(2100);
    });

    it('drops the baselines with a deleted chat', () => {
        const harness = createHarness();
        harness.ledger.loadChat('chat-a');
        addWithFingerprint(harness.ledger, { recordId: 'r-1' }, fingerprint());

        harness.ledger.handleChatDeleted('chat-a');

        const next = addWithFingerprint(harness.ledger, { recordId: 'r-2', hitTokens: 0 }, fingerprintWithReply());
        expect(next.sharedPrefixTokens).toBeNull();
        expect(persistedFingerprints(harness)).toHaveLength(1);
    });

    it('drops text that reached a stored fingerprint', () => {
        const harness = createHarness({
            metadata: {
                [USAGE_CHAT_METADATA_KEY]: {
                    version: 1,
                    ownerChatId: 'chat-a',
                    revision: 3,
                    records: [],
                    runs: [],
                    currentRunId: null,
                    // A hand-edited map: a key that names nothing, and a message
                    // that still carries the text it was hashed from.
                    promptFingerprints: {
                        'not-the-identity': {
                            provider: 'deepseek',
                            model: 'deepseek-flash',
                            origin: 'story',
                            messages: [
                                { hash: 11, tokens: 1500, content: 'SECRET PROMPT TEXT' },
                                { hash: 22, tokens: 600 },
                            ],
                        },
                    },
                },
            },
        });

        harness.ledger.loadChat('chat-a');
        const next = addWithFingerprint(harness.ledger, { recordId: 'r-2', hitTokens: 0 }, fingerprintWithReply());

        // The key is rebuilt from the fingerprint, so the comparison still
        // happens, and the text is dropped before the next write.
        expect(next.sharedPrefixTokens).toBe(2100);
        expect(JSON.stringify(harness.state.metadata)).not.toContain('SECRET PROMPT TEXT');
    });
});
