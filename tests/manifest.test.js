import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

const readRepoFile = (name) => readFileSync(join(process.cwd(), name), 'utf8');
const manifest = JSON.parse(readRepoFile('manifest.json'));
const packageJson = JSON.parse(readRepoFile('package.json'));
const changelog = readRepoFile('CHANGELOG.md');
const readme = readRepoFile('README.md');

/** A version is text, not a pattern: `1.0.0+build` must not match `1x0x0`. */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('release number', () => {
    // SillyTavern only displays the manifest version and updates through git, so
    // the number is a promise to humans: the changelog and the README must not
    // tell a stranger a different story than the manifest does.
    it('agrees across the manifest and the package', () => {
        expect(packageJson.version).toBe(manifest.version);
    });

    it('has a dated entry in the changelog', () => {
        const version = escapeRegExp(manifest.version);
        expect(changelog).toMatch(new RegExp(`^## \\[${version}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
    });

    it('is the version the README shows a stranger', () => {
        // Not pinned to the bold markup: a README reformat must not fail CI,
        // but the number a stranger reads must be the manifest's.
        expect(readme).toMatch(new RegExp(`\\bVersion ${escapeRegExp(manifest.version)}\\b`));
    });
});

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
