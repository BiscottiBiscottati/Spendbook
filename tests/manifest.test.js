import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

const manifest = JSON.parse(readFileSync(join(process.cwd(), 'manifest.json'), 'utf8'));

describe('extension manifest', () => {
    it('identifies Spendbook and its entry files', () => {
        expect(manifest.display_name).toBe('Spendbook');
        expect(manifest.loading_order).toBe(50);
        expect(manifest.js).toBe('index.js');
        expect(manifest.css).toBe('styles/spendbook.css');
        expect(manifest.version).toBe('1.0.0');
        expect(manifest.auto_update).toBe(true);
        expect(manifest.description).toBeTruthy();
        expect(manifest.author).toBeTruthy();
    });

    it('declares no interceptor, no i18n and no dependency on another extension', () => {
        expect(manifest).not.toHaveProperty('generate_interceptor');
        expect(manifest).not.toHaveProperty('i18n');
        expect(manifest).not.toHaveProperty('dependencies');
        expect(manifest).not.toHaveProperty('requires');
    });
});
