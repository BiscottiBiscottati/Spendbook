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

const templateHtml = readFileSync(join(process.cwd(), 'settings.html'), 'utf8');

function mount({
    settings = {},
    onTrackingChange = () => {},
    getSnapshot = null,
    onResetChat = () => {},
    onResetAllTime = () => {},
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
