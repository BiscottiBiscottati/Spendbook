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
