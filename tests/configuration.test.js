/**
 * Configuration-label seam: the page-lifetime label a host sets, and the shape
 * it takes before it reaches a row. The label is free-form, so normalization is
 * where a host's text becomes Spendbook's: trimmed, single-spaced, capped, and
 * empty means no label at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
    CONFIGURATION_LABEL_MAX_LENGTH,
    DEFAULT_CONFIGURATION_LABEL,
    getConfigurationLabel,
    normalizeConfigurationLabel,
    setConfigurationLabel,
} from '../src/configuration.js';

describe('Spendbook configuration label — normalization', () => {
    it('trims the ends and collapses inner whitespace', () => {
        expect(normalizeConfigurationLabel('  gpt-4o  ')).toBe('gpt-4o');
        expect(normalizeConfigurationLabel('gpt-4o\t  temp 0.8\n')).toBe('gpt-4o temp 0.8');
        expect(normalizeConfigurationLabel('a   b')).toBe('a b');
    });

    it('treats an empty or blank label as no label', () => {
        expect(normalizeConfigurationLabel('')).toBeNull();
        expect(normalizeConfigurationLabel('   \t\n ')).toBeNull();
    });

    it('treats a value that is not text as no label', () => {
        expect(normalizeConfigurationLabel(null)).toBeNull();
        expect(normalizeConfigurationLabel(undefined)).toBeNull();
        expect(normalizeConfigurationLabel(42)).toBeNull();
        expect(normalizeConfigurationLabel({ label: 'x' })).toBeNull();
    });

    it('caps a long label without leaving a trailing space', () => {
        const long = 'x'.repeat(CONFIGURATION_LABEL_MAX_LENGTH + 20);
        expect(normalizeConfigurationLabel(long)).toBe('x'.repeat(CONFIGURATION_LABEL_MAX_LENGTH));

        // The cap lands on the space before the next word, and trimming the
        // slice keeps the label from ending on whitespace.
        const spaced = `${'a'.repeat(CONFIGURATION_LABEL_MAX_LENGTH - 1)} bbbbb`;
        expect(normalizeConfigurationLabel(spaced)).toBe('a'.repeat(CONFIGURATION_LABEL_MAX_LENGTH - 1));
    });
});

describe('Spendbook configuration label — set and clear', () => {
    beforeEach(() => {
        setConfigurationLabel(null);
    });

    it('starts with no label, which reads as the default group', () => {
        expect(getConfigurationLabel()).toBeNull();
        expect(DEFAULT_CONFIGURATION_LABEL).toBe('default');
    });

    it('stores the normalized label for the page', () => {
        expect(setConfigurationLabel('  gpt-4o   high temp ')).toBe('gpt-4o high temp');
        expect(getConfigurationLabel()).toBe('gpt-4o high temp');
    });

    it('clears with null or an empty label', () => {
        setConfigurationLabel('after');
        setConfigurationLabel(null);
        expect(getConfigurationLabel()).toBeNull();

        setConfigurationLabel('after');
        setConfigurationLabel('   ');
        expect(getConfigurationLabel()).toBeNull();
    });
});
