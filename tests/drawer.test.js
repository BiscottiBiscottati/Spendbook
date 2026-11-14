/**
 * Drawer smoke: the template mounts into the extensions settings panel and the
 * tracking toggle reflects stored state.
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { mountSpendbookPanel } from '../ui/panel.js';
import { readSpendbookSettings, setTrackingEnabled } from '../src/settings.js';
import { addRecordToUsageArchive, createUsageArchive } from '../src/stats.js';
import { ACME_PRICES, ACME_PRICED_ROW } from './fixtures/prices.js';
import { CHAT_RUNS as RUNS } from './fixtures/runs.js';

const templateHtml = readFileSync(join(process.cwd(), 'settings.html'), 'utf8');

function mount({
    settings = {},
    onTrackingChange = () => {},
    getSnapshot = null,
    onResetChat = () => {},
    onResetAllTime = () => {},
    onPricesChange = () => {},
    onStartRun = () => null,
    confirmReset = () => true,
} = {}) {
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    const container = document.getElementById('extensions_settings2');
    const panel = mountSpendbookPanel({
        container,
        html: templateHtml,
        settings,
        onTrackingChange,
        getSnapshot,
        onResetChat,
        onResetAllTime,
        onPricesChange,
        onStartRun,
        confirmReset,
    });
    return { container, panel };
}

function row(overrides = {}) {
    return {
        recordId: 'r-1',
        timestamp: 1_700_000_000_000,
        origin: 'story',
        label: null,
        provider: 'openai',
        model: 'model-a',
        promptTokens: 1200,
        completionTokens: 340,
        latencyMs: 820,
        status: 'ok',
        usageSource: 'measured',
        ...overrides,
    };
}

// The shared rates price this row at $0.00032520, saving $0.00005880.
function pricedRow(overrides = {}) {
    return row({ ...ACME_PRICED_ROW, ...overrides });
}

describe('Spendbook drawer', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('mounts one Spendbook drawer with a tracking toggle and the privacy note', () => {
        const { container } = mount({ settings: { trackingEnabled: true } });

        expect(container.querySelectorAll('.inline-drawer')).toHaveLength(1);
        expect(container.querySelector('.inline-drawer').textContent).toContain('Spendbook');
        expect(container.querySelectorAll('#spendbook_tracking_enabled')).toHaveLength(1);
        expect(container.querySelector('.spendbook-privacy-note').textContent).toMatch(/never stores prompt text/i);
    });

    it('shows the stored tracking state', () => {
        const { container } = mount({ settings: { trackingEnabled: true } });

        expect(container.querySelector('#spendbook_tracking_enabled').checked).toBe(true);
    });

    it('persists the toggle in Spendbook’s namespace and restores it on the next mount', () => {
        const extensionSettings = { otherExtension: { someSetting: false } };
        const onTrackingChange = vi.fn(value => setTrackingEnabled(extensionSettings, value));
        const { container } = mount({ settings: readSpendbookSettings(extensionSettings), onTrackingChange });

        const toggle = container.querySelector('#spendbook_tracking_enabled');
        expect(toggle.checked).toBe(false);

        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(onTrackingChange).toHaveBeenCalledWith(true);
        expect(extensionSettings.spendbook).toEqual({ trackingEnabled: true });
        expect(extensionSettings.otherExtension).toEqual({ someSetting: false });

        const { container: remounted } = mount({ settings: readSpendbookSettings(extensionSettings) });
        expect(remounted.querySelector('#spendbook_tracking_enabled').checked).toBe(true);
    });
});

describe('Spendbook drawer table', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('renders a row with provider, model, tokens, latency, status, origin and label', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({ records: [row({ origin: 'internal', label: 'ExampleFeature' })], trackingEnabled: true, health: { matched: 1, captured: 1, errors: 0 } }),
        });

        const [rendered] = container.querySelectorAll('.spendbook-rows tr');
        expect(rendered.querySelector('.spendbook-cell-provider').textContent).toBe('openai');
        expect(rendered.querySelector('.spendbook-cell-model').textContent).toBe('model-a');
        expect(rendered.querySelector('.spendbook-cell-prompt').textContent).toBe('1,200');
        expect(rendered.querySelector('.spendbook-cell-completion').textContent).toBe('340');
        expect(rendered.querySelector('.spendbook-cell-latency').textContent).toBe('820 ms');
        expect(rendered.querySelector('.spendbook-cell-status').textContent).toBe('ok');
        expect(rendered.querySelector('.spendbook-cell-origin').textContent).toBe('internal');
        expect(rendered.querySelector('.spendbook-cell-label').textContent).toBe('ExampleFeature');
    });

    it('shows a placeholder, not zero, when the provider reported no token count', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                records: [row({ promptTokens: null, completionTokens: null, status: 'no-usage', usageSource: 'unavailable' })],
                trackingEnabled: true,
                health: { captured: 1 },
            }),
        });

        const [rendered] = container.querySelectorAll('.spendbook-rows tr');
        expect(rendered.querySelector('.spendbook-cell-prompt').textContent).toBe('—');
        expect(rendered.querySelector('.spendbook-cell-completion').textContent).toBe('—');
    });

    it('labels each row measured, estimated or unavailable', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                records: [
                    row({ recordId: 'r-measured' }),
                    row({
                        recordId: 'r-estimated',
                        promptTokens: null,
                        completionTokens: null,
                        status: 'no-usage',
                        estimatedPromptTokens: 240,
                        usageSource: 'estimated',
                    }),
                    row({
                        recordId: 'r-unavailable',
                        promptTokens: null,
                        completionTokens: null,
                        status: 'error',
                        usageSource: 'unavailable',
                    }),
                ],
                trackingEnabled: true,
                health: { captured: 3 },
            }),
        });

        const rows = [...container.querySelectorAll('.spendbook-rows tr')];
        expect(rows.map(rendered => rendered.querySelector('.spendbook-cell-source').textContent))
            .toEqual(['measured', 'estimated', 'unavailable']);
        expect(rows[0].querySelector('.spendbook-cell-prompt').textContent).toBe('1,200');
        expect(rows[1].querySelector('.spendbook-cell-prompt').textContent).toBe('~240');
        expect(rows[2].querySelector('.spendbook-cell-prompt').textContent).toBe('—');
    });

    it('shows a failed or aborted request by its status', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                records: [
                    row({ recordId: 'r-error', status: 'error', usageSource: 'unavailable' }),
                    row({ recordId: 'r-aborted', status: 'aborted', usageSource: 'unavailable' }),
                ],
                trackingEnabled: true,
                health: { captured: 2 },
            }),
        });

        const statuses = [...container.querySelectorAll('.spendbook-cell-status')]
            .map(cell => cell.textContent);
        expect(statuses).toEqual(['error', 'aborted']);
    });

    it('counts skipped captures in the health line', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({ records: [row()], trackingEnabled: true, health: { captured: 1, skipped: 2 } }),
        });

        expect(container.querySelector('.spendbook-health').textContent).toMatch(/2 requests skipped/i);
    });

    it('shows the empty state when tracking is off', () => {
        const { container } = mount({
            settings: { trackingEnabled: false },
            getSnapshot: () => ({ records: [], trackingEnabled: false, health: null }),
        });

        expect(container.querySelector('.spendbook-health').textContent).toMatch(/tracking is off/i);
        expect(container.querySelector('.spendbook-empty').textContent).toMatch(/turn on tracking/i);
        expect(container.querySelector('.spendbook-table').hidden).toBe(true);
    });

    it('shows the empty state when tracking is on but no request has arrived', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({ records: [], trackingEnabled: true, health: { matched: 0, captured: 0, errors: 0 } }),
        });

        expect(container.querySelector('.spendbook-health').textContent).toMatch(/no requests captured yet/i);
        expect(container.querySelector('.spendbook-empty').textContent).toMatch(/no requests recorded yet/i);
        expect(container.querySelector('.spendbook-table').hidden).toBe(true);
    });

    it('distinguishes captured requests and capture failures in the health line', () => {
        const captured = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({ records: [row()], trackingEnabled: true, health: { captured: 2, errors: 0 } }),
        });
        expect(captured.container.querySelector('.spendbook-health').textContent).toMatch(/2 requests captured/i);

        const failing = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({ records: [], trackingEnabled: true, health: { captured: 0, errors: 2 } }),
        });
        expect(failing.container.querySelector('.spendbook-health').textContent).toMatch(/observer error/i);
        expect(failing.container.querySelector('.spendbook-health').textContent).toMatch(/2 capture attempts failed/i);
    });

    it('refreshes the table from a new snapshot', () => {
        let records = [];
        const { container, panel } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({ records, trackingEnabled: true, health: { captured: records.length } }),
        });
        expect(container.querySelectorAll('.spendbook-rows tr')).toHaveLength(0);

        records = [row()];
        panel.refresh();

        expect(container.querySelectorAll('.spendbook-rows tr')).toHaveLength(1);
        expect(container.querySelector('.spendbook-table').hidden).toBe(false);
    });
});

describe('Spendbook drawer — retention and all-time', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('shows how many rows are retained and how many are folded into the totals', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                records: [row()],
                trackingEnabled: true,
                health: { captured: 1204 },
                retention: { limit: 500, retained: 500, total: 1204 },
            }),
        });

        expect(container.querySelector('.spendbook-retention').textContent).toBe(
            'Retention: showing the newest 500 of 1,204 requests — 704 older rows are folded into the totals.',
        );
    });

    it('says nothing is folded when the chat is under the cap', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                records: [row()],
                trackingEnabled: true,
                health: { captured: 12 },
                retention: { limit: 500, retained: 12, total: 12 },
            }),
        });

        expect(container.querySelector('.spendbook-retention').textContent).toBe(
            'Retention: 12 of up to 500 requests kept — nothing is folded into the totals yet.',
        );
    });

    it('shows the all-time summary across chats, measured tokens apart from estimates', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                records: [row()],
                trackingEnabled: true,
                health: { captured: 1 },
                allTime: {
                    totals: {
                        requests: 1204,
                        excludedRequests: 12,
                        promptTokens: 240000,
                        estimatedPromptTokens: 240,
                    },
                    chats: 3,
                },
            }),
        });

        expect(container.querySelector('.spendbook-alltime').textContent).toBe(
            'All time: 1,204 completed requests and 12 failed or stopped, across 3 chats · 240,000 prompt tokens · 240 estimated prompt tokens.',
        );
    });

    it('shows the all-time summary before anything has been recorded', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                records: [],
                trackingEnabled: true,
                health: { captured: 0 },
                allTime: { totals: { requests: 0, excludedRequests: 0 }, chats: 0 },
            }),
        });

        expect(container.querySelector('.spendbook-alltime').textContent).toBe(
            'All time: no requests recorded yet.',
        );
    });
});

describe('Spendbook drawer — reset actions', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('asks before resetting this chat, and does nothing when declined', () => {
        const onResetChat = vi.fn();
        const confirmReset = vi.fn(() => false);
        const { container } = mount({ settings: { trackingEnabled: true }, onResetChat, confirmReset });

        container.querySelector('.spendbook-reset-chat').click();

        expect(confirmReset).toHaveBeenCalledTimes(1);
        expect(confirmReset.mock.calls[0][0]).toMatch(/this chat/i);
        expect(onResetChat).not.toHaveBeenCalled();
    });

    it('resets this chat only after confirmation, and leaves all-time alone', () => {
        const onResetChat = vi.fn();
        const onResetAllTime = vi.fn();
        const { container } = mount({
            settings: { trackingEnabled: true },
            onResetChat,
            onResetAllTime,
            confirmReset: () => true,
        });

        container.querySelector('.spendbook-reset-chat').click();

        expect(onResetChat).toHaveBeenCalledTimes(1);
        expect(onResetAllTime).not.toHaveBeenCalled();
    });

    it('asks before resetting all time, and resets only the cross-chat totals', () => {
        const onResetChat = vi.fn();
        const onResetAllTime = vi.fn();
        const confirmReset = vi.fn(() => true);
        const { container } = mount({
            settings: { trackingEnabled: true },
            onResetChat,
            onResetAllTime,
            confirmReset,
        });

        container.querySelector('.spendbook-reset-alltime').click();

        expect(confirmReset.mock.calls[0][0]).toMatch(/all-time/i);
        expect(onResetAllTime).toHaveBeenCalledTimes(1);
        expect(onResetChat).not.toHaveBeenCalled();
    });
});

describe('Spendbook drawer — cards and help', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('draws the numbers above the table as one card per scope', () => {
        const { container } = mount({
            settings: { trackingEnabled: true, prices: ACME_PRICES },
            getSnapshot: () => ({
                records: [pricedRow()],
                trackingEnabled: true,
                health: { captured: 1 },
                retention: null,
                allTime: null,
                archive: null,
            }),
        });
        const cards = [...container.querySelectorAll('.spendbook-card')];

        expect(cards.map((card) => card.dataset.scope)).toEqual(['all', 'story']);
        expect(cards[0].querySelector('.spendbook-card-title').textContent).toBe('This chat');
        expect(cards[1].querySelector('.spendbook-card-title').textContent).toBe('Story');
        expect(cards[0].textContent).toContain('1 completed request');
        expect(cards[0].textContent).toContain('$0.00032520');
        expect(cards[0].textContent).toContain('33.3%');
    });

    it('draws an unavailable metric as a placeholder, not as a zero', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                records: [row({ usageSource: 'unavailable', promptTokens: null, completionTokens: null })],
                trackingEnabled: true,
                health: { captured: 1 },
            }),
        });

        const values = [...container.querySelectorAll('.spendbook-metric-prompt .spendbook-metric-value')];
        expect(values).toHaveLength(2);
        for (const value of values) expect(value.textContent).toBe('—');
    });

    it('explains measured, estimated, unavailable, the hit rate and coverage', () => {
        const { container } = mount({ settings: { trackingEnabled: true } });
        const help = container.querySelector('.spendbook-help');

        expect(help.textContent).toMatch(/Measured: the provider reported/);
        expect(help.textContent).toMatch(/Estimated: the provider reported no usage/);
        expect(help.textContent).toMatch(/tokenizer/);
        expect(help.textContent).toMatch(/Unavailable: neither the provider nor the tokenizer/);
        expect(help.textContent).toMatch(/never as 0/);
        expect(help.textContent).toMatch(/token-weighted/);
        expect(help.textContent).toMatch(/Coverage: the share of prompt tokens/);
        expect(help.textContent).toMatch(/reported no prompt count at all/);
    });
});

describe('Spendbook drawer — cost', () => {
    const prices = ACME_PRICES;

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('shows a placeholder in every cost cell and says the table is empty on a fresh install', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({ records: [row()], trackingEnabled: true, health: { captured: 1 } }),
        });

        const [rendered] = container.querySelectorAll('.spendbook-rows tr');
        expect(rendered.querySelector('.spendbook-cell-cost').textContent).toBe('—');
        expect(rendered.querySelector('.spendbook-cell-saving').textContent).toBe('—');
        expect(container.querySelector('.spendbook-cards').textContent).toMatch(/no cost — the price table is empty$/);
        expect(container.querySelectorAll('.spendbook-price-rows tr')).toHaveLength(0);
    });

    it('prices the rows and the chat totals once a matching row exists', () => {
        const { container } = mount({
            settings: { trackingEnabled: true, prices },
            getSnapshot: () => ({ records: [pricedRow()], trackingEnabled: true, health: { captured: 1 } }),
        });

        const [rendered] = container.querySelectorAll('.spendbook-rows tr');
        expect(rendered.querySelector('.spendbook-cell-cost').textContent).toBe('$0.00032520');
        expect(rendered.querySelector('.spendbook-cell-saving').textContent).toBe('$0.00005880');
        expect(container.querySelector('.spendbook-card[data-scope="all"]').textContent)
            .toContain('$0.00032520');
        expect(container.querySelector('.spendbook-card[data-scope="all"]').textContent)
            .toContain('$0.00005880');
    });

    it('repaints the results from an edited price without replacing the field being edited', () => {
        const onPricesChange = vi.fn();
        const { container } = mount({
            settings: { trackingEnabled: true, prices },
            getSnapshot: () => ({ records: [pricedRow()], trackingEnabled: true, health: { captured: 1 } }),
            onPricesChange,
        });
        const hitInput = container.querySelector('[data-price-index="0"][data-price-field="hit"]');

        hitInput.value = '0.01';
        hitInput.dispatchEvent(new Event('change', { bubbles: true }));

        expect(onPricesChange).toHaveBeenCalledTimes(1);
        expect(onPricesChange.mock.calls[0][0].entries[0].hit).toBe(0.01);
        // 400 * 0.01 + 800 * 0.15 + 340 * 0.6 = 328 micro-dollars.
        expect(container.querySelector('.spendbook-cell-cost').textContent).toBe('$0.00032800');
        expect(container.querySelector('[data-price-index="0"][data-price-field="hit"]')).toBe(hitInput);
    });

    it('adds a blank row, focuses it and persists it', () => {
        const onPricesChange = vi.fn();
        const { container } = mount({ settings: { trackingEnabled: true, prices }, onPricesChange });

        container.querySelector('.spendbook-price-add').click();

        const stored = onPricesChange.mock.calls[0][0];
        expect(stored.entries).toHaveLength(2);
        expect(stored.entries[1]).toEqual({ provider: '', model: '', hit: null, miss: null, output: null, cacheWrite: null });
        expect(container.querySelectorAll('.spendbook-price-rows tr')).toHaveLength(2);
        expect(document.activeElement).toBe(container.querySelector('[data-price-index="1"][data-price-field="provider"]'));
    });

    it('removes the row whose button was clicked and folds the cost away', () => {
        const onPricesChange = vi.fn();
        const { container } = mount({
            settings: { trackingEnabled: true, prices },
            getSnapshot: () => ({ records: [pricedRow()], trackingEnabled: true, health: { captured: 1 } }),
            onPricesChange,
        });

        container.querySelector('.spendbook-price-remove').click();

        expect(onPricesChange.mock.calls[0][0].entries).toHaveLength(0);
        expect(container.querySelectorAll('.spendbook-price-rows tr')).toHaveLength(0);
        expect(container.querySelector('.spendbook-cell-cost').textContent).toBe('—');
        expect(container.querySelector('.spendbook-cards').textContent).toMatch(/no cost — the price table is empty/);
    });

    it('clears a price field it cannot read, so the field never claims a rate', () => {
        const onPricesChange = vi.fn();
        const { container } = mount({
            settings: { trackingEnabled: true, prices },
            getSnapshot: () => ({ records: [pricedRow()], trackingEnabled: true, health: { captured: 1 } }),
            onPricesChange,
        });
        const hitInput = container.querySelector('[data-price-index="0"][data-price-field="hit"]');

        hitInput.value = 'abc';
        hitInput.dispatchEvent(new Event('change', { bubbles: true }));

        expect(onPricesChange.mock.calls[0][0].entries[0].hit).toBeNull();
        expect(hitInput.value).toBe('');
        // The 400 hit tokens can no longer be priced, and the drawer says so
        // instead of showing a confident number.
        expect(container.querySelector('.spendbook-cell-cost').textContent).toBe('—');
        expect(container.querySelector('.spendbook-cards').textContent).toMatch(/no cost — no complete price row for these requests/);
    });

    it('stores the currency the user types', () => {
        const onPricesChange = vi.fn();
        const { container } = mount({
            settings: { trackingEnabled: true, prices },
            getSnapshot: () => ({ records: [pricedRow()], trackingEnabled: true, health: { captured: 1 } }),
            onPricesChange,
        });
        const currencyInput = container.querySelector('.spendbook-price-currency');

        currencyInput.value = 'EUR';
        currencyInput.dispatchEvent(new Event('change', { bubbles: true }));

        expect(onPricesChange.mock.calls[0][0].currency).toBe('EUR');
        expect(container.querySelector('.spendbook-cell-cost').textContent.startsWith('€')).toBe(true);
    });
});

describe('Spendbook drawer — measurement runs', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    function runRows(container) {
        return [...container.querySelectorAll('.spendbook-rows tr')].map((tr) => tr.dataset.recordId);
    }

    it('lists every run, offers all runs and names the current one', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                chatId: 'chat-a',
                records: [pricedRow({ recordId: 'r-1', runId: 'run-2' })],
                trackingEnabled: true,
                runs: RUNS,
            }),
        });

        const select = container.querySelector('.spendbook-run-filter');
        expect([...select.options].map((option) => option.value)).toEqual(['', 'run-2', 'run-1']);
        expect([...select.options].map((option) => option.textContent)[1]).toMatch(/^after · /);
        expect(select.value).toBe('');
        expect(container.querySelector('.spendbook-run-current').textContent).toMatch(/^Current run: after · started /);
    });

    it('offers all runs before any run exists', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                chatId: 'chat-a',
                records: [pricedRow({ recordId: 'r-1' })],
                trackingEnabled: true,
                runs: { runs: [], currentRunId: null },
            }),
        });

        const select = container.querySelector('.spendbook-run-filter');
        expect([...select.options].map((option) => option.textContent)).toEqual(['All runs']);
        expect(select.disabled).toBe(true);
        expect(container.querySelector('.spendbook-run-current').textContent).toBe(
            'No run started yet — requests belong to no run until you start one.',
        );
    });

    it('starts a labelled run from the bar without changing what is shown', () => {
        let snapshot = {
            chatId: 'chat-a',
            records: [pricedRow({ recordId: 'r-old' })],
            trackingEnabled: true,
            runs: { runs: [], currentRunId: null },
        };
        const onStartRun = vi.fn((label) => {
            const run = { runId: 'run-new', label: label || 'Run 1', startedAt: 1_700_000_500_000 };
            snapshot = {
                ...snapshot,
                runs: { runs: [run], currentRunId: run.runId },
            };
            return run;
        });
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => snapshot,
            onStartRun,
        });

        const input = container.querySelector('.spendbook-run-label');
        input.value = 'batch 30';
        container.querySelector('.spendbook-run-start').click();

        expect(onStartRun).toHaveBeenCalledWith('batch 30');
        expect(input.value).toBe('');
        // The view stays where it was; the bar lists and names the new run.
        expect(container.querySelector('.spendbook-run-filter').value).toBe('');
        expect([...container.querySelectorAll('.spendbook-run-filter option')]).toHaveLength(2);
        expect(container.querySelector('.spendbook-run-current').textContent).toMatch(/^Current run: batch 30/);
        expect(runRows(container)).toEqual(['r-old']);
    });

    it('keeps a typed label when no run could be started', () => {
        const onStartRun = vi.fn(() => null);
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                chatId: 'chat-a',
                records: [pricedRow({ recordId: 'r-1' })],
                trackingEnabled: true,
                runs: { runs: [], currentRunId: null },
            }),
            onStartRun,
        });

        const input = container.querySelector('.spendbook-run-label');
        input.value = 'batch 30';
        container.querySelector('.spendbook-run-start').click();

        expect(input.value).toBe('batch 30');
    });

    it('narrows the table to the selected run and restores every run', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                chatId: 'chat-a',
                records: [
                    pricedRow({ recordId: 'r-run2', runId: 'run-2' }),
                    pricedRow({ recordId: 'r-run1', runId: 'run-1' }),
                    pricedRow({ recordId: 'r-before' }),
                ],
                trackingEnabled: true,
                runs: RUNS,
            }),
        });
        const select = container.querySelector('.spendbook-run-filter');
        expect(runRows(container)).toEqual(['r-run2', 'r-run1', 'r-before']);

        select.value = 'run-1';
        select.dispatchEvent(new Event('change'));

        expect(runRows(container)).toEqual(['r-run1']);
        // The bar keeps listing the run that is not being shown.
        expect([...container.querySelectorAll('.spendbook-run-filter option')]).toHaveLength(3);

        container.querySelector('.spendbook-run-filter').value = '';
        container.querySelector('.spendbook-run-filter').dispatchEvent(new Event('change'));

        expect(runRows(container)).toEqual(['r-run2', 'r-run1', 'r-before']);
    });

    it('leaves the folded counters out of a run and says so', () => {
        const archive = createUsageArchive();
        addRecordToUsageArchive(archive, pricedRow({ recordId: 'r-folded' }));
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                chatId: 'chat-a',
                records: [pricedRow({ recordId: 'r-run1', runId: 'run-1', promptTokens: 500, hitTokens: 100 })],
                trackingEnabled: true,
                archive,
                retention: { limit: 500, retained: 1, total: 2 },
                runs: RUNS,
            }),
        });
        const select = container.querySelector('.spendbook-run-filter');
        select.value = 'run-1';
        select.dispatchEvent(new Event('change'));

        // The folded copy of the fixture row would add 1,200 prompt tokens.
        expect(container.querySelector('.spendbook-metric-prompt dd').textContent).toBe('500');
        expect(container.querySelector('.spendbook-retention').textContent).toBe(
            'Retention: this view covers one run — 1 folded row cannot be attributed to a run, so it is left out.',
        );
    });

    it('resets the filter when another chat opens', () => {
        let snapshot = {
            chatId: 'chat-a',
            records: [pricedRow({ recordId: 'r-run1', runId: 'run-1' }), pricedRow({ recordId: 'r-before' })],
            trackingEnabled: true,
            runs: RUNS,
        };
        const { container, panel } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => snapshot,
        });
        const select = container.querySelector('.spendbook-run-filter');
        select.value = 'run-1';
        select.dispatchEvent(new Event('change'));
        expect(runRows(container)).toEqual(['r-run1']);

        snapshot = {
            chatId: 'chat-b',
            records: [pricedRow({ recordId: 'r-other-chat' })],
            trackingEnabled: true,
            runs: { runs: [], currentRunId: null },
        };
        panel.refresh();

        expect(container.querySelector('.spendbook-run-filter').value).toBe('');
        expect(runRows(container)).toEqual(['r-other-chat']);
        expect(container.querySelector('.spendbook-run-current').textContent).toMatch(/^No run started yet/);
    });
});

describe('Spendbook drawer — prefix diagnostics', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    function mountWith(records) {
        return mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                chatId: 'chat-a',
                records,
                trackingEnabled: true,
                health: { matched: 1, captured: 1, skipped: 0, errors: 0 },
                retention: null,
                allTime: null,
                archive: null,
                runs: null,
            }),
        });
    }

    it('has a shared-prefix column and names a suspected breaker in that row', () => {
        const { container } = mountWith([row({
            hitTokens: 0,
            sharedPrefixTokens: 2200,
            possiblePrefixBreaker: true,
        })]);

        const headers = [...container.querySelectorAll('.spendbook-table:not(.spendbook-price-table) thead th')]
            .map((header) => header.textContent.trim());
        expect(headers).toContain('Shared prefix');

        const [rendered] = container.querySelectorAll('.spendbook-rows tr');
        const cell = rendered.querySelector('.spendbook-cell-prefix');
        expect(cell.textContent).toContain('~2,200');
        expect(cell.querySelector('.spendbook-prefix-flag').textContent).toBe('Possible prefix breaker');
    });

    it('shows a placeholder and no flag when there is no comparable prior request', () => {
        const { container } = mountWith([row({ sharedPrefixTokens: null })]);

        const [rendered] = container.querySelectorAll('.spendbook-rows tr');
        const cell = rendered.querySelector('.spendbook-cell-prefix');
        expect(cell.textContent).toBe('—');
        expect(cell.querySelector('.spendbook-prefix-flag')).toBeNull();
    });
});

describe('Spendbook drawer — configuration comparison', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('compares the labelled configurations side by side, default first', () => {
        const { container } = mount({
            settings: { trackingEnabled: true, prices: ACME_PRICES },
            getSnapshot: () => ({
                records: [
                    pricedRow({ recordId: 'r-1', configuration: null }),
                    pricedRow({ recordId: 'r-2', configuration: null }),
                    pricedRow({ recordId: 'r-3', configuration: 'batch-8' }),
                ],
                trackingEnabled: true,
                health: { captured: 3 },
            }),
        });

        const rows = container.querySelectorAll('.spendbook-configuration-rows tr');
        expect(rows).toHaveLength(2);
        expect(rows[0].querySelector('.spendbook-configuration-cell-configuration').textContent).toBe('default');
        expect(rows[0].dataset.default).toBe('true');
        expect(rows[0].querySelector('.spendbook-configuration-cell-requests').textContent).toBe('2 completed requests');
        expect(rows[0].querySelector('.spendbook-configuration-cell-hitRate').textContent).toBe('33.3%');
        expect(rows[0].querySelector('.spendbook-configuration-cell-cost').textContent).toBe('$0.00065040');

        expect(rows[1].querySelector('.spendbook-configuration-cell-configuration').textContent).toBe('batch-8');
        expect(rows[1].dataset.default).toBeUndefined();
        expect(rows[1].querySelector('.spendbook-configuration-cell-requests').textContent).toBe('1 completed request');
        expect(rows[1].querySelector('.spendbook-configuration-cell-cost').textContent).toBe('$0.00032520');
    });

    it('shows no comparison table while nothing is recorded', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({ records: [], trackingEnabled: true, health: { captured: 0 } }),
        });

        expect(container.querySelector('.spendbook-configuration-table').hidden).toBe(true);
        expect(container.querySelector('.spendbook-configuration-rows').children).toHaveLength(0);
    });

    it('names the configuration on each request row, default when unlabelled', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                records: [
                    row({ recordId: 'r-1', configuration: null }),
                    row({ recordId: 'r-2', configuration: 'batch-8' }),
                ],
                trackingEnabled: true,
                health: { captured: 2 },
            }),
        });

        const cells = [...container.querySelectorAll('.spendbook-rows .spendbook-cell-configuration')];
        expect(cells.map((cell) => cell.textContent)).toEqual(['default', 'batch-8']);
    });

    it('documents the host call in the drawer and in the help', () => {
        const { container } = mount({ settings: { trackingEnabled: true } });

        expect(container.querySelector('.spendbook-configurations').textContent)
            .toContain('globalThis.Spendbook.setConfigurationLabel()');
        expect(container.querySelector('.spendbook-help').textContent)
            .toMatch(/Configuration: the label a host extension set/);
    });
});

describe('Spendbook drawer — configuration row sources', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('marks a comparison figure estimated or unavailable, never as measured', () => {
        const { container } = mount({
            settings: { trackingEnabled: true },
            getSnapshot: () => ({
                records: [row({
                    configuration: 'batch-8',
                    usageSource: 'estimated',
                    promptTokens: null,
                    estimatedPromptTokens: 900,
                    hitTokens: null,
                    completionTokens: 100,
                    cacheWriteTokens: null,
                    reasoningTokens: null,
                    totalTokens: null,
                })],
                trackingEnabled: true,
                health: { captured: 1 },
            }),
        });

        const [configRow] = container.querySelectorAll('.spendbook-configuration-rows tr');
        const promptCell = configRow.querySelector('.spendbook-configuration-cell-prompt');
        expect(promptCell.textContent).toBe('~900');
        expect(promptCell.dataset.source).toBe('estimated');

        // No price row matches, so the cost is unavailable rather than zero.
        const costCell = configRow.querySelector('.spendbook-configuration-cell-cost');
        expect(costCell.textContent).toBe('—');
        expect(costCell.dataset.source).toBe('unavailable');
    });
});
