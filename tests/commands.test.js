/**
 * Slash-command seam: the ledger is reachable from the chat bar without the
 * drawer, and no command changes whether observation is on.
 *
 * The parser and command class are SillyTavern's; here they are stood in for so
 * the registration is checked by what it hands the parser, and each handler by
 * what it returns and which of its injected callbacks it uses.
 */

import { describe, it, expect, vi } from 'vitest';

import { registerSpendbookCommands } from '../src/commands.js';
import { ACME_PRICES } from './fixtures/prices.js';
import { createAcmeRecord } from './fixtures/records.js';
import { CHAT_RUNS } from './fixtures/runs.js';

class FakeCommand {
    static fromProps(props) {
        return Object.assign(new FakeCommand(), props);
    }
}

function createParser() {
    const commands = [];
    return {
        commands,
        addCommandObject(command) {
            commands.push(command);
        },
    };
}

function snapshot(overrides = {}) {
    return {
        chatId: 'Seraphina - 2026-11-13T10-00-00',
        records: [createAcmeRecord()],
        trackingEnabled: true,
        health: { matched: 1, captured: 1, skipped: 0, errors: 0 },
        retention: { limit: 500, retained: 1, total: 1 },
        allTime: { totals: { requests: 1, promptTokens: 1200 }, chats: 1 },
        archive: null,
        runs: CHAT_RUNS,
        prices: ACME_PRICES,
        ...overrides,
    };
}

function register(overrides = {}) {
    const parser = createParser();
    const dependencies = {
        parser,
        commandClass: FakeCommand,
        getSnapshot: () => snapshot(),
        getExport: vi.fn(() => ({ fileName: 'spendbook-usage-2026-11-13T02-24-00.json', content: '{"version":1}' })),
        startRun: vi.fn(() => ({ runId: 'run-3', label: 'Run 3', startedAt: 1_700_000_200_000 })),
        refresh: vi.fn(),
        saveFile: vi.fn(),
        notify: vi.fn(),
        ...overrides,
    };
    registerSpendbookCommands(dependencies);
    const command = (name) => parser.commands.find((entry) => entry.name === name);
    return { ...dependencies, parser, command };
}

describe('Spendbook slash commands — registration', () => {
    it('registers the three commands the ledger is reached through', () => {
        const { parser } = register();

        expect(parser.commands.map((entry) => entry.name)).toEqual([
            'spendbook',
            'spendbook-run',
            'spendbook-export',
        ]);
        for (const command of parser.commands) {
            expect(typeof command.callback).toBe('function');
            expect(command.helpString.length).toBeGreaterThan(0);
        }
    });

    it('registers nothing when SillyTavern has no parser to register with', () => {
        const parser = createParser();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(registerSpendbookCommands({ parser: null, commandClass: FakeCommand })).toEqual([]);
        expect(parser.commands).toEqual([]);
        warn.mockRestore();
    });
});

describe('Spendbook slash commands — /spendbook', () => {
    it('prints tracking state, health, both summaries and the current run', () => {
        const { command, notify } = register();

        const report = command('spendbook').callback({}, '');
        const lines = report.split('\n');

        expect(lines[0]).toBe('Tracking: on.');
        expect(lines[1]).toBe('Observer installed — 1 request captured.');
        // $0.00032520 is the ACME fixture's worked example, not a re-run of the
        // view's own arithmetic.
        expect(lines[2]).toBe('This chat: 1 completed request · prompt 1,200 · cached 400 · hit rate 33.3% · completion 340 · coverage 100% · cost $0.00032520 · cache saving $0.00005880.');
        expect(lines[3]).toBe('All time: 1 completed request, across 1 chat · 1,200 prompt tokens. Cost is per chat.');
        expect(lines[4]).toMatch(/^Current run: after · started /);
        expect(lines).toHaveLength(5);
        expect(notify).toHaveBeenCalledWith(report);
    });

    it('says so when tracking is off and nothing has been recorded', () => {
        const { command } = register({
            getSnapshot: () => snapshot({
                records: [],
                trackingEnabled: false,
                health: null,
                allTime: null,
                runs: { runs: [], currentRunId: null },
            }),
        });

        const report = command('spendbook').callback({}, '');

        expect(report).toContain('Tracking: off.');
        expect(report).toContain('Tracking is off — the observer is not installed.');
        expect(report).toContain('This chat: no requests recorded yet.');
        expect(report).toContain('All time: no requests recorded yet.');
        expect(report).toContain('No run started yet');
    });

    it('reads only: it starts no run and saves no file', () => {
        const { command, startRun, saveFile } = register();

        command('spendbook').callback({}, '');

        expect(startRun).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
    });
});

describe('Spendbook slash commands — /spendbook-run', () => {
    it('starts a run in the open chat and repaints the run bar', () => {
        const { command, startRun, refresh, notify } = register();

        const message = command('spendbook-run').callback({}, '');

        expect(startRun).toHaveBeenCalledTimes(1);
        expect(startRun).toHaveBeenCalledWith();
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(message).toBe('Started run “Run 3”.');
        expect(notify).toHaveBeenCalledWith(message);
    });

    it('starts nothing when no chat is open', () => {
        const { command, startRun, refresh, notify } = register();
        startRun.mockReturnValue(null);

        const message = command('spendbook-run').callback({}, '');

        expect(refresh).not.toHaveBeenCalled();
        expect(message).toContain('No chat is open');
        expect(notify).toHaveBeenCalledWith(message);
    });
});

describe('Spendbook slash commands — /spendbook-export', () => {
    it('downloads the same export the drawer button does, with names forced off', () => {
        const file = { fileName: 'spendbook-usage-2026-11-13T02-24-00.json', content: '{"version":1}' };
        const { command, getExport, saveFile, notify } = register({
            getExport: vi.fn(() => file),
        });

        const message = command('spendbook-export').callback({}, '');

        // The command never asks for the chat-name opt-in, whatever the setting
        // says now: a command must not be the way a chat name leaves the browser.
        expect(getExport).toHaveBeenCalledWith({ includeChatNames: false });
        expect(saveFile).toHaveBeenCalledWith(file.fileName, file.content);
        expect(message).toBe('Exported spendbook-usage-2026-11-13T02-24-00.json.');
        expect(notify).toHaveBeenCalledWith(message);
    });

    it('says so when the browser cannot start the download', () => {
        const { command, notify, saveFile } = register({ saveFile: vi.fn(() => false) });

        const message = command('spendbook-export').callback({}, '');

        expect(saveFile).toHaveBeenCalledTimes(1);
        expect(message).toBe('Could not download spendbook-usage-2026-11-13T02-24-00.json in this browser.');
        expect(notify).toHaveBeenCalledWith(message);
    });

    it('downloads nothing when the export could not be built', () => {
        const { command, saveFile } = register({ getExport: vi.fn(() => null) });

        expect(command('spendbook-export').callback({}, '')).toBe('');
        expect(saveFile).not.toHaveBeenCalled();
    });
});
