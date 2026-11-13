import { describe, it, expect, beforeEach, vi } from 'vitest';

import { installUsageObserver, getUsageObserverHealth } from '../src/observer.js';
import { noteGenerationEnded, noteGenerationStarted, markInternalRequest } from '../src/origin.js';
import { USAGE_CHAT_METADATA_KEY, UsageLedger } from '../src/ledger.js';

const GENERATE_URL = '/api/backends/chat-completions/generate';

function jsonResponse(payload, { status = 200 } = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function requestInit({ model = 'model-a', source = 'openai', stream = false } = {}) {
    return {
        method: 'POST',
        body: JSON.stringify({
            chat_completion_source: source,
            model,
            stream,
            messages: [{ role: 'user', content: 'hello' }],
        }),
    };
}

/**
 * Wires the real observer, origin and ledger over a fake fetch, exactly as the
 * entry module does. Returns the records the ledger holds.
 */
function createPipeline({ enabled = true } = {}) {
    const chatId = 'chat-a';
    const metadata = {};
    let enabledNow = enabled;
    let response = jsonResponse({
        id: 'resp-1',
        model: 'model-a',
        usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
    });

    const target = {
        fetch: vi.fn(async () => response),
    };
    const originalFetch = target.fetch;
    const ledger = new UsageLedger({
        getChatId: () => chatId,
        getMetadata: () => metadata,
        saveMetadata: () => {},
    });
    ledger.loadChat(chatId);

    installUsageObserver({
        target,
        isEnabled: () => enabledNow,
        getChatId: () => chatId,
        handleRecord: (record) => ledger.add(record),
    });

    return {
        target,
        originalFetch,
        metadata,
        ledger,
        records: () => ledger.recordsFor(chatId),
        setResponse: (next) => { response = next; },
        setEnabled: (value) => { enabledNow = value; },
    };
}

async function send(pipeline, init = requestInit()) {
    return pipeline.target.fetch(GENERATE_URL, init);
}

async function waitForRecords(pipeline, count) {
    await vi.waitFor(() => expect(pipeline.records()).toHaveLength(count));
}

describe('Spendbook observer pipeline', () => {
    beforeEach(() => {
        noteGenerationEnded();
    });

    it('records one ordinary story turn as a measured row in chat_metadata', async () => {
        const pipeline = createPipeline();
        noteGenerationStarted('normal');

        const response = await send(pipeline);
        await response.json();
        await waitForRecords(pipeline, 1);

        const [row] = pipeline.records();
        expect(row).toMatchObject({
            chatId: 'chat-a',
            origin: 'story',
            label: null,
            provider: 'openai',
            model: 'model-a',
            responseId: 'resp-1',
            status: 'ok',
            httpStatus: 200,
            promptTokens: 100,
            completionTokens: 25,
            totalTokens: 125,
            usageSource: 'measured',
        });
        expect(pipeline.metadata[USAGE_CHAT_METADATA_KEY].records).toHaveLength(1);
    });

    it('returns the caller’s own response untouched', async () => {
        const pipeline = createPipeline();
        const sent = jsonResponse({
            id: 'resp-1',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
        pipeline.setResponse(sent);

        const received = await send(pipeline);

        expect(received).toBe(sent);
        await expect(received.json()).resolves.toMatchObject({ id: 'resp-1' });
    });

    it('does not wrap fetch at all while tracking is off', () => {
        const target = { fetch: vi.fn() };
        const original = target.fetch;

        const wrapper = installUsageObserver({ target, isEnabled: () => false });

        expect(wrapper).toBeNull();
        expect(target.fetch).toBe(original);
        expect(getUsageObserverHealth(target)).toBeNull();
    });

    it('records a marked call as internal with its label while a story generation is in flight', async () => {
        const pipeline = createPipeline();
        noteGenerationStarted('normal');

        await send(pipeline, markInternalRequest(requestInit(), 'Summarizer'));
        await send(pipeline, requestInit());
        await waitForRecords(pipeline, 2);

        expect(pipeline.records().map((row) => [row.origin, row.label])).toEqual([
            ['story', null],
            ['internal', 'Summarizer'],
        ]);
    });

    it('records a quiet generation as quiet', async () => {
        const pipeline = createPipeline();
        noteGenerationStarted('quiet');

        await send(pipeline);
        await waitForRecords(pipeline, 1);

        expect(pipeline.records()[0].origin).toBe('quiet');
    });

    it('records an unannounced, unmarked call as internal with a null label', async () => {
        const pipeline = createPipeline();

        await send(pipeline);
        await waitForRecords(pipeline, 1);

        expect(pipeline.records()[0]).toMatchObject({ origin: 'internal', label: null });
    });

    it('never mistakes an unrecognised generation type for the story reply', async () => {
        const pipeline = createPipeline();
        noteGenerationStarted('caption');

        await send(pipeline);
        await waitForRecords(pipeline, 1);

        expect(pipeline.records()[0]).toMatchObject({ origin: 'internal', label: null });
    });

    it('leaves requests outside the chat-completion path alone', async () => {
        const pipeline = createPipeline();

        await pipeline.target.fetch('/api/backends/other', requestInit());

        expect(pipeline.originalFetch).toHaveBeenCalledTimes(1);
        expect(pipeline.records()).toHaveLength(0);
        expect(getUsageObserverHealth(pipeline.target).matched).toBe(0);
    });

    it('captures once per request when installed again', async () => {
        const pipeline = createPipeline();

        installUsageObserver({
            target: pipeline.target,
            isEnabled: () => true,
            getChatId: () => 'chat-a',
            handleRecord: (record) => pipeline.ledger.add(record),
        });
        await send(pipeline);
        await waitForRecords(pipeline, 1);

        expect(pipeline.records()).toHaveLength(1);
    });

    it('counts a capture failure in the health counters without breaking the caller', async () => {
        const pipeline = createPipeline();
        const response = jsonResponse({ usage: { prompt_tokens: 1 } });
        response.clone = () => { throw new Error('clone failed'); };
        pipeline.setResponse(response);

        const received = await send(pipeline);
        await vi.waitFor(() => expect(getUsageObserverHealth(pipeline.target).errors).toBe(1));

        expect(received).toBe(response);
        expect(pipeline.records()).toHaveLength(0);
        expect(getUsageObserverHealth(pipeline.target).captured).toBe(0);
    });
});
