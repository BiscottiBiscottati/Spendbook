/**
 * Spendbook view model.
 *
 * Pure: records, tracking state and observer health in; labels and numbers out.
 * The panel renders this and nothing else, so the drawer's text is testable
 * without a DOM and a format change cannot reach into the ledger.
 */

import { USAGE_ORIGINS } from '../src/origin.js';

const PLACEHOLDER = '—';
const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

const KNOWN_ORIGINS = new Set(Object.values(USAGE_ORIGINS));

const STATUS_LABELS = Object.freeze({
    ok: 'ok',
    'no-usage': 'no usage',
    error: 'error',
    aborted: 'aborted',
});

const SOURCE_LABELS = Object.freeze({
    measured: 'measured',
    estimated: 'estimated',
    unavailable: 'unavailable',
});


/**
 * Turns ledger records and observer state into the labels the drawer renders.
 *
 * @param {object} [options]
 * @param {object[]} [options.records] Newest-first records for the active chat.
 * @param {boolean} [options.trackingEnabled] Whether the observer is capturing.
 * @param {object|null} [options.health] Observer health counters, when installed.
 * @param {{limit: number, retained: number, total: number}|null} [options.retention] Row counts for the active chat.
 * @param {{totals: object, chats: number}|null} [options.allTime] Cross-chat aggregate.
 * @returns {{
 *   trackingEnabled: boolean,
 *   health: {state: string, label: string},
 *   retention: {limit: number, retained: number, total: number, folded: number, label: string},
 *   allTime: {requests: number, excluded: number, chats: number, label: string},
 *   empty: boolean,
 *   emptyMessage: string,
 *   rows: object[],
 * }}
 */
export function buildUsageView({
    records = [],
    trackingEnabled = false,
    health = null,
    retention = null,
    allTime = null,
} = {}) {
    const rows = (Array.isArray(records) ? records : []).map(buildRow);

    return {
        trackingEnabled,
        health: describeObserverHealth({ trackingEnabled, health }),
        retention: describeRetention(retention),
        allTime: describeAllTime(allTime),
        empty: rows.length === 0,
        emptyMessage: trackingEnabled
            ? 'No requests recorded yet. Send a message with tracking on to start the table.'
            : 'Tracking is off. Turn on tracking to record requests in this chat.',
        rows,
    };
}

/**
 * The retention note: how many rows the table holds and how many older rows
 * the counters include after the cap folded them.
 *
 * @param {{limit?: number, retained?: number, total?: number}|null} [retention]
 * @returns {{limit: number, retained: number, total: number, folded: number, label: string}}
 */
export function describeRetention(retention = {}) {
    const limit = toCount(retention?.limit);
    const retained = toCount(retention?.retained);
    const total = Math.max(retained, toCount(retention?.total));
    const folded = total - retained;
    const summary = { limit, retained, total, folded };

    if (total === 0) {
        return {
            ...summary,
            label: limit > 0
                ? `Retention: the newest ${formatCount(limit)} requests are kept per chat.`
                : 'Retention: older rows are folded into the totals when a chat reaches its cap.',
        };
    }
    if (folded > 0) {
        return {
            ...summary,
            label: `Retention: showing the newest ${formatCount(retained)} of ${formatCount(total)} requests — ${formatCount(folded)} older rows are folded into the totals.`,
        };
    }
    const cap = limit > 0 ? ` of up to ${formatCount(limit)}` : '';
    return {
        ...summary,
        label: `Retention: ${formatCount(retained)}${cap} requests kept — nothing is folded into the totals yet.`,
    };
}

/**
 * The all-time line: completed and excluded requests across every chat whose
 * bucket local storage still holds.
 *
 * @param {{totals?: object, chats?: number}|null} [allTime]
 * @returns {{requests: number, excluded: number, chats: number, promptTokens: number, estimatedPromptTokens: number, label: string}}
 */
export function describeAllTime(allTime = {}) {
    const requests = toCount(allTime?.totals?.requests);
    const excluded = toCount(allTime?.totals?.excludedRequests);
    const promptTokens = toCount(allTime?.totals?.promptTokens);
    const estimatedPromptTokens = toCount(allTime?.totals?.estimatedPromptTokens);
    const chats = toCount(allTime?.chats);

    if (requests + excluded === 0 || chats === 0) {
        return {
            requests: 0,
            excluded: 0,
            chats: 0,
            promptTokens: 0,
            estimatedPromptTokens: 0,
            label: 'All time: no requests recorded yet.',
        };
    }

    const stopped = excluded > 0 ? ` and ${formatCount(excluded)} failed or stopped` : '';
    // Measured and estimated prompt tokens never share one number: the drawer
    // must not make an estimate look like a provider count.
    const measured = promptTokens > 0 ? ` · ${formatCount(promptTokens)} prompt tokens` : '';
    const estimated = estimatedPromptTokens > 0
        ? ` · ${formatCount(estimatedPromptTokens)} estimated prompt tokens`
        : '';
    return {
        requests,
        excluded,
        chats,
        promptTokens,
        estimatedPromptTokens,
        label: `All time: ${formatCountLabel(requests, 'completed request')}${stopped}, across ${formatCountLabel(chats, 'chat')}${measured}${estimated}.`,
    };
}

/**
 * Separates "tracking is off", "observer installed but nothing captured yet"
 * and "the observer is failing", so an empty table is never ambiguous.
 *
 * @param {{trackingEnabled: boolean, health: object|null}} options
 * @returns {{state: string, label: string}}
 */
export function describeObserverHealth({ trackingEnabled = false, health = null } = {}) {
    if (!trackingEnabled) {
        return { state: 'off', label: 'Tracking is off — the observer is not installed.' };
    }
    if (!health) {
        return { state: 'not-installed', label: 'Tracking is on, but the observer is not installed yet.' };
    }

    // A skipped body is an observable gap in the table, so it is reported even
    // when the capture itself succeeded.
    const skippedCount = Number(health.skipped) || 0;
    const skipped = skippedCount > 0
        ? `, ${formatCountLabel(skippedCount, 'request')} skipped`
        : '';

    const errorCount = Number(health.errors) || 0;
    if (errorCount > 0) {
        return {
            state: 'error',
            label: `Observer error — ${formatCountLabel(errorCount, 'capture attempt')} failed${skipped}. Rows may be missing.`,
        };
    }

    const captured = Number(health.captured) || 0;
    if (captured === 0) {
        return { state: 'idle', label: `Observer installed — no requests captured yet${skipped}.` };
    }
    return {
        state: 'ok',
        label: `Observer installed — ${formatCountLabel(captured, 'request')} captured${skipped}.`,
    };
}

function buildRow(record) {
    const measuredPrompt = Number.isFinite(record.promptTokens) ? record.promptTokens : null;
    const estimatedPrompt = Number.isFinite(record.estimatedPromptTokens) ? record.estimatedPromptTokens : null;
    const prompt = measuredPrompt ?? estimatedPrompt;

    return {
        recordId: record.recordId ?? '',
        timeLabel: formatTime(record.timestamp),
        originLabel: KNOWN_ORIGINS.has(record.origin) ? record.origin : PLACEHOLDER,
        labelLabel: record.label || PLACEHOLDER,
        providerLabel: record.provider || 'unknown',
        modelLabel: record.model || 'unknown',
        promptLabel: prompt == null
            ? PLACEHOLDER
            : `${measuredPrompt == null ? '~' : ''}${formatCount(prompt)}`,
        completionLabel: formatCount(record.completionTokens),
        latencyLabel: formatLatency(record.latencyMs),
        statusLabel: STATUS_LABELS[record.status] ?? PLACEHOLDER,
        sourceLabel: SOURCE_LABELS[record.usageSource] ?? SOURCE_LABELS.unavailable,
    };
}

function formatTime(timestamp) {
    if (!Number.isFinite(timestamp)) return PLACEHOLDER;
    const date = new Date(timestamp);
    const pad = (part) => String(part).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatLatency(latencyMs) {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return PLACEHOLDER;
    if (latencyMs < 1000) return `${Math.round(latencyMs)} ms`;
    return `${(latencyMs / 1000).toFixed(1)} s`;
}

function formatCount(value) {
    return Number.isFinite(value) ? NUMBER_FORMAT.format(value) : PLACEHOLDER;
}

function formatCountLabel(count, noun) {
    return `${NUMBER_FORMAT.format(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function toCount(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
