/**
 * Message text: how one request message's content becomes the text the
 * prompt-token estimate counts. No text is stored; this is the only place that
 * decides what a message "says".
 */

import { describe, it, expect } from 'vitest';

import { messageText } from '../src/message.js';

describe('message text', () => {
    it('returns a plain string content unchanged', () => {
        expect(messageText({ role: 'user', content: 'hello world' })).toBe('hello world');
    });

    it('joins the text parts of multimodal content and drops the rest', () => {
        expect(messageText({
            role: 'user',
            content: [
                { type: 'text', text: 'first' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                { type: 'text', text: 'second' },
            ],
        })).toBe('first\nsecond');
    });

    it('skips an empty part rather than leaving a blank line', () => {
        expect(messageText({
            content: [{ type: 'text', text: '' }, { type: 'text', text: 'second' }],
        })).toBe('second');
    });

    it('returns no text for content that is neither a string nor text parts', () => {
        expect(messageText({ content: 42 })).toBe('');
        expect(messageText({ content: null })).toBe('');
        expect(messageText({})).toBe('');
        expect(messageText(null)).toBe('');
    });
});
