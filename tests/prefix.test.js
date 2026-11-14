/**
 * Prefix diagnostics: the transient fingerprint that says how much of a prompt
 * a request shares with its comparable predecessor, and the rule that turns a
 * zero-hit row with a long prefix into a suspected cache breaker.
 *
 * A fingerprint is hashes and token counts only; no message text ever reaches
 * it, and nothing here is persisted: the ledger keeps one baseline per identity.
 */

import { describe, it, expect } from 'vitest';

import {
    comparePromptFingerprints,
    createPromptFingerprint,
    isPossiblePrefixBreaker,
} from '../src/prefix.js';

function messages() {
    return [
        { role: 'system', content: 'you are a helpful assistant' },
        { role: 'user', content: 'hello there' },
    ];
}

describe('prefix fingerprint', () => {
    it('keeps a hash and a token count per message and drops the text', () => {
        const fingerprint = createPromptFingerprint({
            provider: 'deepseek',
            model: 'deepseek-flash',
            origin: 'story',
            messages: messages(),
            tokenCounts: [1500, 600],
        });

        expect(fingerprint.provider).toBe('deepseek');
        expect(fingerprint.model).toBe('deepseek-flash');
        expect(fingerprint.origin).toBe('story');
        expect(fingerprint.messages.map((message) => message.tokens)).toEqual([1500, 600]);
        expect(fingerprint.messages.every((message) => Number.isFinite(message.hash))).toBe(true);
        expect(JSON.stringify(fingerprint)).not.toContain('helpful assistant');
    });

    it('shares the token sum of the messages that match from the start', () => {
        const previous = createPromptFingerprint({
            origin: 'story',
            messages: messages(),
            tokenCounts: [1500, 600],
        });
        const current = createPromptFingerprint({
            origin: 'story',
            messages: [...messages(), { role: 'assistant', content: 'hi' }],
            tokenCounts: [1500, 600, 30],
        });

        // 1500 + 600: the appended message is not shared, so its count is not.
        expect(comparePromptFingerprints(previous, current)).toBe(2100);
    });

    it('reports no comparison across providers, models or origins', () => {
        const story = createPromptFingerprint({
            provider: 'deepseek',
            model: 'deepseek-flash',
            origin: 'story',
            messages: messages(),
            tokenCounts: [1500, 600],
        });
        const otherModel = createPromptFingerprint({
            provider: 'deepseek',
            model: 'deepseek-pro',
            origin: 'story',
            messages: messages(),
            tokenCounts: [1500, 600],
        });
        const quiet = createPromptFingerprint({
            provider: 'deepseek',
            model: 'deepseek-flash',
            origin: 'quiet',
            messages: messages(),
            tokenCounts: [1500, 600],
        });

        expect(comparePromptFingerprints(story, otherModel)).toBeNull();
        expect(comparePromptFingerprints(story, quiet)).toBeNull();
        expect(comparePromptFingerprints(null, story)).toBeNull();
    });

    it('reports 0 when the very first message already differs', () => {
        const previous = createPromptFingerprint({ messages: messages(), tokenCounts: [1500, 600] });
        const edited = createPromptFingerprint({
            messages: [
                { role: 'system', content: 'you are a terse assistant' },
                { role: 'user', content: 'hello there' },
            ],
            tokenCounts: [1400, 600],
        });

        expect(comparePromptFingerprints(previous, edited)).toBe(0);
    });

    it('reports the comparison unavailable when a shared message has no count', () => {
        const previous = createPromptFingerprint({ messages: messages(), tokenCounts: [1500, 600] });
        const unmeasured = createPromptFingerprint({ messages: messages() });

        // Not 0: a missing count must not pass as a short, flag-safe prefix.
        expect(comparePromptFingerprints(previous, unmeasured)).toBeNull();
    });
});

describe('prefix-breaker rule', () => {
    it('flags a zero-hit row at exactly 2,048 shared tokens', () => {
        expect(isPossiblePrefixBreaker({ sharedPrefixTokens: 2048, hitTokens: 0 })).toBe(true);
    });

    it('does not flag a zero-hit row at 2,047 shared tokens', () => {
        expect(isPossiblePrefixBreaker({ sharedPrefixTokens: 2047, hitTokens: 0 })).toBe(false);
    });

    it('never flags a row that reported cached tokens', () => {
        expect(isPossiblePrefixBreaker({ sharedPrefixTokens: 5000, hitTokens: 1 })).toBe(false);
    });

    it('never flags a row whose hit count or prefix is unavailable', () => {
        // A provider that reported nothing is not a cache miss, and a missing
        // prefix must not stand in for a long one.
        expect(isPossiblePrefixBreaker({ sharedPrefixTokens: 5000, hitTokens: null })).toBe(false);
        expect(isPossiblePrefixBreaker({ sharedPrefixTokens: null, hitTokens: 0 })).toBe(false);
        expect(isPossiblePrefixBreaker()).toBe(false);
    });
});
