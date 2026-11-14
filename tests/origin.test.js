import { describe, it, expect, beforeEach } from 'vitest';

import {
    noteGenerationEnded,
    noteGenerationStarted,
    resolveUsageOrigin,
} from '../src/origin.js';

const MARK = Symbol.for('spendbook.internal-request');

describe('Spendbook origin attribution', () => {
    beforeEach(() => {
        noteGenerationEnded();
    });

    it('records an unannounced call as internal with no label', () => {
        expect(resolveUsageOrigin()).toEqual({ origin: 'internal', label: null });
    });

    it('records a marked call as internal with its label, even during a story generation', () => {
        noteGenerationStarted('normal');
        const init = { [MARK]: { label: 'ExampleFeature' } };

        expect(resolveUsageOrigin(init)).toEqual({ origin: 'internal', label: 'ExampleFeature' });
    });

    it('does not let a marked call in flight steal the story request sent during it', () => {
        noteGenerationStarted('normal');
        const internalInit = { [MARK]: { label: 'ExampleFeature' } };
        const storyInit = {};

        expect(resolveUsageOrigin(internalInit)).toEqual({ origin: 'internal', label: 'ExampleFeature' });
        expect(resolveUsageOrigin(storyInit)).toEqual({ origin: 'story', label: null });
    });

    it('treats a mark with no label as internal with a null label', () => {
        expect(resolveUsageOrigin({ [MARK]: {} })).toEqual({ origin: 'internal', label: null });
    });

    // The mark's documented value is `{ label: string | null }`, but a host may
    // write the symbol itself and skip the helper that normalizes. The label
    // reaches the drawer and the export, so the reader normalizes too.
    it('ignores a hand-written label that is not a non-empty string', () => {
        for (const label of ['', 42, {}, ['a'], true]) {
            expect(resolveUsageOrigin({ [MARK]: { label } })).toEqual({ origin: 'internal', label: null });
        }
    });

    it('records a quiet generation whose result is handed back as quiet', () => {
        noteGenerationStarted('quiet');

        expect(resolveUsageOrigin()).toEqual({ origin: 'quiet', label: null });
    });

    it('records a quiet-to-loud generation as the story reply', () => {
        noteGenerationStarted('quiet', { quietToLoud: true });

        expect(resolveUsageOrigin()).toEqual({ origin: 'story', label: null });
    });

    it.each(['normal', 'regenerate', 'swipe', 'continue', 'impersonate'])(
        'records the %s generation type as story',
        (type) => {
            noteGenerationStarted(type);

            expect(resolveUsageOrigin()).toEqual({ origin: 'story', label: null });
        },
    );

    it('records a generation type it does not recognise as internal, never story', () => {
        noteGenerationStarted('caption');

        expect(resolveUsageOrigin()).toEqual({ origin: 'internal', label: null });
    });

    it('clears the in-flight generation when it ends', () => {
        noteGenerationStarted('normal');
        noteGenerationEnded();

        expect(resolveUsageOrigin()).toEqual({ origin: 'internal', label: null });
    });
});
