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

function sseResponse(parts, { status = 200, contentType = 'text/event-stream' } = {}) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            for (const part of parts) controller.enqueue(encoder.encode(part));
            controller.close();
        },
    });
    return new Response(stream, {
        status,
        headers: contentType ? { 'content-type': contentType } : {},
    });
}

/**
 * Wires the real observer, origin and ledger over a fake fetch, exactly as the
 * entry module does. Returns the records the ledger holds.
 */
function createPipeline({ enabled = true, observerOptions = {} } = {}) {
    const chatId = 'chat-a';
    const metadata = {};
    let enabledNow = enabled;
    let failure = null;
    let response = jsonResponse({
        id: 'resp-1',
        model: 'model-a',
        usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
    });

    const target = {
        fetch: vi.fn(async () => {
            if (failure) throw failure;
            return response;
        }),
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
        ...observerOptions,
    });

    return {
        target,
        originalFetch,
        metadata,
        ledger,
        records: () => ledger.recordsFor(chatId),
        setResponse: (next) => { response = next; },
        setFailure: (next) => { failure = next; },
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

        await send(pipeline, markInternalRequest(requestInit(), 'ExampleFeature'));
        await send(pipeline, requestInit());
        await waitForRecords(pipeline, 2);

        expect(pipeline.records().map((row) => [row.origin, row.label])).toEqual([
            ['story', null],
            ['internal', 'ExampleFeature'],
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

    it('records a streamed reply from the usage in its SSE tail', async () => {
        const pipeline = createPipeline();
        const chunks = [
            'data: {"id":"gen-9","model":"model-a","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
            'data: {"id":"gen-9","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280}}\n\n',
            'data: [DONE]\n\n',
        ];
        const response = sseResponse(chunks);
        pipeline.setResponse(response);
        noteGenerationStarted('normal');

        const returned = await send(pipeline, requestInit({ stream: true }));
        await waitForRecords(pipeline, 1);

        expect(returned).toBe(response);
        await expect(returned.text()).resolves.toBe(chunks.join(''));
        expect(pipeline.records()[0]).toMatchObject({
            responseId: 'gen-9',
            stream: true,
            status: 'ok',
            httpStatus: 200,
            promptTokens: 1200,
            completionTokens: 80,
            totalTokens: 1280,
            usageSource: 'measured',
        });
    });

    it('parses a usage frame split across reads', async () => {
        const pipeline = createPipeline();
        const full = [
            'data: {"id":"gen-10","model":"model-a","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
            'data: {"id":"gen-10","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":5,"total_tokens":55}}\n\n',
            'data: [DONE]\n\n',
        ].join('');
        const cuts = [17, 61, 140];
        pipeline.setResponse(sseResponse([
            full.slice(0, cuts[0]),
            full.slice(cuts[0], cuts[1]),
            full.slice(cuts[1], cuts[2]),
            full.slice(cuts[2]),
        ]));

        await send(pipeline, requestInit({ stream: true }));
        await waitForRecords(pipeline, 1);

        expect(pipeline.records()[0]).toMatchObject({
            status: 'ok',
            promptTokens: 50,
            completionTokens: 5,
            totalTokens: 55,
            usageSource: 'measured',
        });
    });

    it('records a stream that ends without its terminal marker as an error, not a completed reply', async () => {
        const pipeline = createPipeline();
        pipeline.setResponse(sseResponse([
            'data: {"id":"gen-12","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
        ]));

        const returned = await send(pipeline, requestInit({ stream: true }));
        await waitForRecords(pipeline, 1);

        expect(returned).toBeInstanceOf(Response);
        expect(pipeline.records()[0]).toMatchObject({
            status: 'error',
            httpStatus: 200,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            usageSource: 'unavailable',
        });
    });

    it('records a non-OK response with its status and no token numbers', async () => {
        const pipeline = createPipeline();
        const payload = { error: { message: 'rate limited' } };
        const response = jsonResponse(payload, { status: 429 });
        pipeline.setResponse(response);

        const returned = await send(pipeline);
        await waitForRecords(pipeline, 1);

        expect(returned).toBe(response);
        expect(pipeline.records()[0]).toMatchObject({
            status: 'error',
            httpStatus: 429,
            stream: false,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            usageSource: 'unavailable',
        });
        // The caller's error response is still readable, byte for byte.
        await expect(returned.json()).resolves.toEqual(payload);
    });

    it('records a rejected request and hands the caller the original rejection', async () => {
        const pipeline = createPipeline();
        const networkError = new TypeError('Failed to fetch');
        pipeline.setFailure(networkError);

        await expect(send(pipeline)).rejects.toBe(networkError);
        await waitForRecords(pipeline, 1);

        expect(pipeline.records()[0]).toMatchObject({
            status: 'error',
            httpStatus: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            usageSource: 'unavailable',
        });
    });

    it('records an aborted request as aborted rather than as a failed reply', async () => {
        const pipeline = createPipeline();
        const abortError = new DOMException('The user aborted a request.', 'AbortError');
        pipeline.setFailure(abortError);
        const controller = new AbortController();
        controller.abort();

        await expect(send(pipeline, { ...requestInit(), signal: controller.signal }))
            .rejects.toBe(abortError);
        await waitForRecords(pipeline, 1);

        expect(pipeline.records()[0]).toMatchObject({
            status: 'aborted',
            httpStatus: null,
            promptTokens: null,
            usageSource: 'unavailable',
        });
    });

    it('captures a stream when the proxy omits the content type', async () => {
        const pipeline = createPipeline();
        pipeline.setResponse(sseResponse([
            'data: {"id":"gen-11","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
            'data: {"id":"gen-11","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1674,"completion_tokens":105,"total_tokens":1779}}\n\n',
            'data: [DONE]\n\n',
        ], { contentType: null }));

        await send(pipeline, requestInit({ stream: true }));
        await waitForRecords(pipeline, 1);

        expect(pipeline.records()[0]).toMatchObject({
            status: 'ok',
            promptTokens: 1674,
            completionTokens: 105,
            usageSource: 'measured',
        });
    });

    it('keeps the last non-null usage chunk in the tail', async () => {
        const pipeline = createPipeline();
        pipeline.setResponse(sseResponse([
            'data: {"usage":{"prompt_tokens":10,"total_tokens":10}}\n\n',
            'data: {"usage":null}\n\n',
            'data: {"usage":{"prompt_tokens":20,"completion_tokens":0,"total_tokens":20}}\n\n',
            'data: [DONE]\n\n',
        ]));

        await send(pipeline, requestInit({ stream: true }));
        await waitForRecords(pipeline, 1);

        expect(pipeline.records()[0]).toMatchObject({
            status: 'ok',
            promptTokens: 20,
            totalTokens: 20,
            usageSource: 'measured',
        });
    });

    it('records an error frame as an error and keeps a later usage', async () => {
        const pipeline = createPipeline();
        pipeline.setResponse(sseResponse([
            'data: not-json\n\n',
            'data: {"error":{"message":"upstream failed"}}\n\n',
            'data: {"usage":{"prompt_tokens":10,"completion_tokens":0,"total_tokens":10}}\n\n',
            'data: [DONE]\n\n',
        ]));

        await send(pipeline, requestInit({ stream: true }));
        await waitForRecords(pipeline, 1);

        expect(pipeline.records()[0]).toMatchObject({
            status: 'error',
            promptTokens: 10,
            usageSource: 'measured',
        });
    });

    it('records an aborted stream as aborted and keeps what was measured', async () => {
        const pipeline = createPipeline();
        const encoder = new TextEncoder();
        const controller = new AbortController();
        pipeline.setResponse(new Response(new ReadableStream({
            start(streamController) {
                streamController.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":10,"total_tokens":10}}\n\n'));
                // Abort after the usage frame has been read, as a stop button would.
                setTimeout(() => {
                    controller.abort();
                    streamController.error(new DOMException('The user aborted a request.', 'AbortError'));
                }, 5);
            },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));

        const returned = await send(pipeline, { ...requestInit({ stream: true }), signal: controller.signal });
        await waitForRecords(pipeline, 1);

        expect(returned).toBeInstanceOf(Response);
        expect(pipeline.records()[0]).toMatchObject({
            status: 'aborted',
            stream: true,
            httpStatus: 200,
            promptTokens: 10,
            totalTokens: 10,
            usageSource: 'measured',
        });
    });

    it('counts a request with no readable body as skipped instead of guessing', async () => {
        const pipeline = createPipeline();

        await send(pipeline, { method: 'POST', body: new FormData() });
        await vi.waitFor(() => expect(getUsageObserverHealth(pipeline.target).skipped).toBe(1));

        expect(pipeline.records()).toHaveLength(0);
        expect(pipeline.originalFetch).toHaveBeenCalledTimes(1);
    });

    it('estimates prompt tokens when a JSON response omits usage', async () => {
        const estimator = vi.fn(async () => 240);
        const pipeline = createPipeline({ observerOptions: { estimatePromptTokens: estimator } });
        pipeline.setResponse(jsonResponse({ id: 'gen-1', model: 'model-a', choices: [] }));

        await send(pipeline);
        await waitForRecords(pipeline, 1);

        expect(estimator).toHaveBeenCalledWith([{ role: 'user', content: 'hello' }]);
        expect(pipeline.records()[0]).toMatchObject({
            status: 'no-usage',
            usageSource: 'estimated',
            promptTokens: null,
            estimatedPromptTokens: 240,
            completionTokens: null,
            totalTokens: null,
        });
    });

    it('estimates a completed stream that carried no usage', async () => {
        const estimator = vi.fn(async () => 75);
        const pipeline = createPipeline({ observerOptions: { estimatePromptTokens: estimator } });
        pipeline.setResponse(sseResponse([
            'data: {"id":"gen-2","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
            'data: [DONE]\n\n',
        ]));

        await send(pipeline, requestInit({ stream: true }));
        await waitForRecords(pipeline, 1);

        expect(pipeline.records()[0]).toMatchObject({
            status: 'no-usage',
            usageSource: 'estimated',
            promptTokens: null,
            estimatedPromptTokens: 75,
        });
    });

    it('does not estimate when the provider reported usage', async () => {
        const estimator = vi.fn(async () => 999);
        const pipeline = createPipeline({ observerOptions: { estimatePromptTokens: estimator } });

        await send(pipeline);
        await waitForRecords(pipeline, 1);

        expect(estimator).not.toHaveBeenCalled();
        expect(pipeline.records()[0]).toMatchObject({
            status: 'ok',
            usageSource: 'measured',
            promptTokens: 100,
            estimatedPromptTokens: null,
        });
    });

    it('leaves the row unavailable when the tokenizer cannot produce a count', async () => {
        const estimator = vi.fn(async () => null);
        const pipeline = createPipeline({ observerOptions: { estimatePromptTokens: estimator } });
        pipeline.setResponse(jsonResponse({ id: 'gen-3', choices: [] }));

        await send(pipeline);
        await waitForRecords(pipeline, 1);

        expect(pipeline.records()[0]).toMatchObject({
            status: 'no-usage',
            usageSource: 'unavailable',
            promptTokens: null,
            estimatedPromptTokens: null,
            completionTokens: null,
            totalTokens: null,
        });
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
