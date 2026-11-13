#!/usr/bin/env node
/**
 * Parse-check every source file with `node --check`.
 *
 * The extension has no build step, so this is the closest thing to a
 * typecheck: a syntax error anywhere in the shipped modules fails here instead
 * of in a stranger's browser console.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['index.js', 'src', 'ui', 'scripts'];

/** @param {string} path @returns {string[]} */
function jsFiles(path) {
    const stats = statSync(path);
    if (!stats.isDirectory()) {
        return path.endsWith('.js') || path.endsWith('.mjs') ? [path] : [];
    }
    return readdirSync(path).flatMap(name => jsFiles(join(path, name)));
}

const files = ROOTS.flatMap(jsFiles);
let failed = false;

for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
        failed = true;
        process.stderr.write(`Syntax error in ${file}\n${error.stderr ?? error.message}\n`);
    }
}

if (failed) {
    process.exit(1);
}

console.log(`Checked ${files.length} files.`);
