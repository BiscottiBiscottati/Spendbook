/**
 * Estimator: prompt-token counts for providers that omit usage.
 *
 * The observer only estimates the prompt when the provider reported nothing;
 * SillyTavern's tokenizer is loaded lazily through an injected loader, so an
 * unavailable tokenizer leaves the row "unavailable" instead of breaking the
 * extension or inventing a zero.
 */

import { describe, it, expect, vi } from 'vitest';

import { createMessageTokenEstimator, createPromptTokenEstimator } from '../src/estimator.js';

function fakeTokenizer(countByText) {
    return {
        getTokenCountAsync: vi.fn(async (text) => countByText[text] ?? 0),
    };
}

describe('prompt-token estimator', () => {
    it('counts each non-empty message through the injected tokenizer', async () => {
        const tokenizer = fakeTokenizer({ hello: 10, world: 25 });
        const estimate = createPromptTokenEstimator({ loadTokenizer: async () => tokenizer });

        await expect(estimate([
            { role: 'system', content: 'hello' },
            { role: 'user', content: 'world' },
            { role: 'assistant', content: '' },
        ])).resolves.toBe(35);

        expect(tokenizer.getTokenCountAsync).toHaveBeenCalledTimes(2);
    });

    it('flattens multimodal message content to its text parts', async () => {
        const tokenizer = fakeTokenizer({ 'first\nsecond': 7 });
        const estimate = createPromptTokenEstimator({ loadTokenizer: async () => tokenizer });

        await expect(estimate([
            { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
        ])).resolves.toBe(7);
    });

    it('imports the tokenizer once for several estimates', async () => {
        const tokenizer = fakeTokenizer({ hi: 1 });
        const loadTokenizer = vi.fn(async () => tokenizer);
        const estimate = createPromptTokenEstimator({ loadTokenizer });

        await estimate([{ content: 'hi' }]);
        await estimate([{ content: 'hi' }]);

        expect(loadTokenizer).toHaveBeenCalledTimes(1);
    });

    it('stays unavailable when the tokenizer cannot be loaded or cannot count', async () => {
        const missing = createPromptTokenEstimator({ loadTokenizer: async () => null });
        await expect(missing([{ content: 'hi' }])).resolves.toBeNull();

        const faulty = createPromptTokenEstimator({
            loadTokenizer: async () => ({
                getTokenCountAsync: async () => {
                    throw new Error('tokenizer failed');
                },
            }),
        });
        await expect(faulty([{ content: 'hi' }])).resolves.toBeNull();

        const throwingLoader = createPromptTokenEstimator({
            loadTokenizer: async () => {
                throw new Error('module unavailable');
            },
        });
        await expect(throwingLoader([{ content: 'hi' }])).resolves.toBeNull();
    });

    it('stays unavailable without messages or without a usable count', async () => {
        const tokenizer = fakeTokenizer({});
        const estimate = createPromptTokenEstimator({ loadTokenizer: async () => tokenizer });

        await expect(estimate(null)).resolves.toBeNull();
        await expect(estimate([{ content: '' }])).resolves.toBeNull();
    });
});

describe('per-message token estimator', () => {
    it('counts every message in order, keeping an empty one as a measured zero', async () => {
        const tokenizer = fakeTokenizer({ hello: 10, world: 25 });
        const estimate = createMessageTokenEstimator({ loadTokenizer: async () => tokenizer });

        // An empty message is a real position in a shared prefix, so it is 0
        // rather than unavailable.
        await expect(estimate([
            { role: 'system', content: 'hello' },
            { role: 'assistant', content: '' },
            { role: 'user', content: 'world' },
        ])).resolves.toEqual([10, 0, 25]);
    });

    it('leaves the whole array unavailable when one message cannot be counted', async () => {
        const estimate = createMessageTokenEstimator({
            loadTokenizer: async () => ({
                getTokenCountAsync: async () => {
                    throw new Error('tokenizer failed');
                },
            }),
        });

        // A partial array would sum to a shorter prefix and hide a real break.
        await expect(estimate([{ content: 'hello' }])).resolves.toBeNull();
    });

    it('stays unavailable without a tokenizer or messages', async () => {
        const missing = createMessageTokenEstimator({ loadTokenizer: async () => null });

        await expect(missing([{ content: 'hi' }])).resolves.toBeNull();
        await expect(missing(null)).resolves.toBeNull();
    });
});
