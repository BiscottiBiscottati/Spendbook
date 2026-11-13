import { describe, it, expect, vi } from 'vitest';

import { USAGE_CHAT_METADATA_KEY, UsageLedger } from '../src/ledger.js';

function record(overrides = {}) {
    return {
        recordId: 'r-1',
        timestamp: 1000,
        chatId: 'chat-a',
        origin: 'story',
        label: null,
        provider: 'openai',
        model: 'model-a',
        promptTokens: 10,
        completionTokens: 4,
        ...overrides,
    };
}

function createLedger({ chatId = 'chat-a', metadata = {}, saveMetadata = () => {} } = {}) {
    const ledger = new UsageLedger({
        getChatId: () => chatId,
        getMetadata: () => metadata,
        saveMetadata,
    });
    return { ledger, metadata };
}

describe('Spendbook ledger', () => {
    it('starts an untouched chat without a spendbook namespace', () => {
        const { ledger, metadata } = createLedger();

        expect(ledger.recordsFor('chat-a')).toEqual([]);
        expect(metadata).toEqual({});
    });

    it('writes a record into chat_metadata.spendbook_usage and leaves other metadata alone', () => {
        const otherMetadata = { world_info: 'kept' };
        const { ledger, metadata } = createLedger({ metadata: { ...otherMetadata } });
        const entry = record();

        ledger.add(entry);

        expect(metadata.world_info).toBe('kept');
        expect(metadata[USAGE_CHAT_METADATA_KEY].ownerChatId).toBe('chat-a');
        expect(metadata[USAGE_CHAT_METADATA_KEY].records).toEqual([entry]);
    });

    it('returns a chat’s records newest first', () => {
        const { ledger } = createLedger();
        ledger.add(record({ recordId: 'old', timestamp: 1000 }));
        ledger.add(record({ recordId: 'new', timestamp: 2000 }));

        expect(ledger.recordsFor('chat-a').map((row) => row.recordId)).toEqual(['new', 'old']);
    });

    it('reads a persisted namespace back with the chat, on a fresh ledger', () => {
        const saveMetadata = vi.fn();
        const { ledger, metadata } = createLedger({ saveMetadata });
        ledger.add(record());
        expect(saveMetadata).toHaveBeenCalledTimes(1);

        const reloaded = new UsageLedger({
            getChatId: () => 'chat-a',
            getMetadata: () => metadata,
            saveMetadata,
        });
        reloaded.loadChat('chat-a');

        expect(reloaded.recordsFor('chat-a')).toEqual([record()]);
    });

    it('keeps records for a chat that is not open out of the open chat’s metadata', () => {
        const { ledger, metadata } = createLedger({ chatId: 'chat-b' });

        ledger.add(record({ chatId: 'chat-a' }));
        ledger.add(record({ recordId: 'r-2', chatId: 'chat-b' }));

        expect(metadata[USAGE_CHAT_METADATA_KEY].records.map((row) => row.recordId)).toEqual(['r-2']);
        expect(ledger.recordsFor('chat-a').map((row) => row.recordId)).toEqual(['r-1']);
    });

    it('starts clean when the persisted namespace belongs to another chat', () => {
        const metadata = {
            [USAGE_CHAT_METADATA_KEY]: { ownerChatId: 'chat-other', records: [record({ chatId: 'chat-other' })] },
        };
        const { ledger } = createLedger({ chatId: 'chat-a', metadata });

        ledger.loadChat('chat-a');

        expect(ledger.recordsFor('chat-a')).toEqual([]);
    });

    it('tolerates a malformed persisted namespace', () => {
        const metadata = { [USAGE_CHAT_METADATA_KEY]: { ownerChatId: 'chat-a', records: 'nope' } };
        const { ledger } = createLedger({ metadata });

        expect(() => ledger.loadChat('chat-a')).not.toThrow();
        expect(ledger.recordsFor('chat-a')).toEqual([]);
    });

    it('follows a chat switch to the new chat’s records', () => {
        let chatId = 'chat-a';
        const metadata = {
            [USAGE_CHAT_METADATA_KEY]: { ownerChatId: 'chat-b', records: [record({ chatId: 'chat-b' })] },
        };
        const ledger = new UsageLedger({
            getChatId: () => chatId,
            getMetadata: () => metadata,
            saveMetadata: () => {},
        });
        ledger.loadChat(chatId);

        chatId = 'chat-b';
        ledger.handleChatChanged(chatId);

        expect(ledger.recordsFor('chat-b').map((row) => row.recordId)).toEqual(['r-1']);
    });
});
