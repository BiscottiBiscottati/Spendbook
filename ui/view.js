/**
 * Spendbook view model.
 *
 * Pure: records, the folded counters, the price table, tracking state, observer
 * health and the aggregates in; labels and numbers out. The panel renders this
 * and nothing else, so the drawer's text is testable without a DOM and a format
 * change cannot reach into the ledger.
 */

import { DEFAULT_CONFIGURATION_LABEL, normalizeConfigurationLabel } from '../src/configuration.js';
import { USAGE_ORIGINS } from '../src/origin.js';
import { resolveUsageCost } from '../src/prices.js';
import { coverageFor, hitRateFor, isCompletedUsageRecord, sumUsageRecords } from '../src/stats.js';

const PLACEHOLDER = '—';
const NUMBER_FORMAT = new Intl.NumberFormat('en-US');
// A provider-reported figure is shown as reported, never converted: OpenRouter
// reports credits, not the price table's currency.
const REPORTED_FORMAT = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
});
const COST_FORMATTERS = new Map();
const PERCENT_FORMAT = new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
});
// A run is a marker the user comes back to later, so its time carries the day:
// a filtered view of yesterday's run must not read like this morning's.
const RUN_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

const KNOWN_ORIGINS = new Set(Object.values(USAGE_ORIGINS));

// The cards read in the order the origins are listed, so a comparison between
// them does not move around as requests arrive.
const ORIGIN_ORDER = Object.values(USAGE_ORIGINS);
const ORIGIN_CARD_TITLES = Object.freeze({
    [USAGE_ORIGINS.STORY]: 'Story',
    [USAGE_ORIGINS.QUIET]: 'Quiet',
    [USAGE_ORIGINS.INTERNAL]: 'Internal',
});

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
 * @param {{total?: object, byOrigin?: object, byModel?: object}|null} [options.archive] Counters of the rows the retention cap folded.
 * @param {import('../src/prices.js').UsagePriceTable|null} [options.prices] User-entered price table.
 * @param {{runs?: object[], currentRunId?: string|null}|null} [options.runs] The chat's measurement runs.
 * @param {string|null} [options.selectedRunId] Run the user filtered to, if any.
 * @returns {{
 *   trackingEnabled: boolean,
 *   health: {state: string, label: string},
 *   retention: {limit: number, retained: number, total: number, folded: number, label: string},
 *   allTime: {requests: number, excluded: number, chats: number, label: string},
 *   runs: {items: object[], selectedRunId: string|null, currentLabel: string},
 *   cards: object[],
 *   configurations: {groups: object[], empty: boolean},
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
    archive = null,
    prices = null,
    runs = null,
    selectedRunId = null,
} = {}) {
    const runView = describeRuns(runs, selectedRunId);
    const filtered = !!runView.selectedRunId;
    // One filtered list feeds every results surface, so the cards, the rows and
    // the comparison cannot describe different requests.
    const allRecords = Array.isArray(records) ? records : [];
    const visibleRecords = filtered
        ? allRecords.filter((record) => record?.runId === runView.selectedRunId)
        : allRecords;
    const rows = visibleRecords.map((record) => buildRow(record, prices));
    // A folded row carries no run id, so a run's view cannot include the
    // retention counters.
    const usage = sumUsageRecords({ records: visibleRecords, archive: filtered ? null : archive, prices });

    return {
        trackingEnabled,
        health: describeObserverHealth({ trackingEnabled, health }),
        retention: describeRetention(retention, { filtered }),
        allTime: describeAllTime(allTime, { hasPrices: hasPriceEntries(prices) }),
        runs: runView,
        cards: buildCards(usage, prices, { filtered }),
        configurations: buildConfigurationGroups(usage, prices),
        empty: rows.length === 0,
        emptyMessage: describeEmptyMessage({ trackingEnabled, filtered }),
        rows,
    };
}

/**
 * What an empty table means, which is not the same before a first request, with
 * tracking off, and inside a run that has not recorded anything yet.
 *
 * @param {{trackingEnabled: boolean, filtered: boolean}} options
 * @returns {string}
 */
function describeEmptyMessage({ trackingEnabled, filtered }) {
    if (!trackingEnabled) return 'Tracking is off. Turn on tracking to record requests in this chat.';
    if (filtered) return 'No requests recorded in this run yet. Send a message while the run is open to fill the table.';
    return 'No requests recorded yet. Send a message with tracking on to start the table.';
}

/**
 * The run bar: every run the chat keeps, newest first, with the current one
 * marked so a new run can be started without losing sight of it. A run that is
 * not listed cannot be filtered to, so a stale selection resolves to none.
 *
 * @param {{runs?: object[], currentRunId?: string|null}|null} runs
 * @param {string|null} selectedRunId
 * @returns {{items: object[], selectedRunId: string|null, currentLabel: string}}
 */
export function describeRuns(runs, selectedRunId = null) {
    const items = [];
    for (const run of Array.isArray(runs?.runs) ? runs.runs : []) {
        if (!run || typeof run.runId !== 'string' || !run.runId) continue;
        const label = run.label || run.runId;
        const timeLabel = formatRunTime(run.startedAt);
        items.push({
            runId: run.runId,
            label,
            timeLabel,
            optionLabel: `${label} · ${timeLabel}`,
            isCurrent: run.runId === runs.currentRunId,
        });
    }
    const selected = items.find((item) => item.runId === selectedRunId) ?? null;
    const current = items.find((item) => item.isCurrent) ?? null;

    return {
        items,
        selectedRunId: selected?.runId ?? null,
        // A listed run with no current one is possible (a merge older than this
        // shape, a hand-edited file), and it must not read as "no run started".
        currentLabel: current
            ? `Current run: ${current.label} · started ${current.timeLabel}.`
            : (items.length > 0
                ? 'No current run — requests belong to no run until you start one.'
                : 'No run started yet — requests belong to no run until you start one.'),
    };
}

/**
 * The retention note: how many rows the table holds and how many older rows
 * the counters include after the cap folded them. The counters describe the
 * chat, and a folded row carries no run id, so a view of one run excludes them
 * and the note says why rather than leaving rows unexplained.
 *
 * @param {{limit?: number, retained?: number, total?: number}|null} [retention]
 * @param {{filtered?: boolean}} [options]
 * @returns {{limit: number, retained: number, total: number, folded: number, label: string}}
 */
export function describeRetention(retention = {}, { filtered = false } = {}) {
    const limit = toCount(retention?.limit);
    const retained = toCount(retention?.retained);
    const total = Math.max(retained, toCount(retention?.total));
    const folded = total - retained;
    const summary = { limit, retained, total, folded };

    if (filtered) {
        // Without the counters the note cannot claim how many were folded, so it
        // states the rule instead of a count it does not have.
        const label = folded > 0
            ? `Retention: this view covers one run — ${formatCountLabel(folded, 'folded row')} cannot be attributed to a run, so ${folded === 1 ? 'it is' : 'they are'} left out.`
            : 'Retention: this view covers one run — rows the cap folds cannot be attributed to a run, so a run’s view leaves them out.';
        return { ...summary, label };
    }

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
 * bucket local storage still holds. The cross-chat aggregate counts tokens; a
 * priced install is told so, because the drawer's only money is per chat.
 *
 * @param {{totals?: object, chats?: number}|null} [allTime]
 * @param {{hasPrices?: boolean}} [options]
 * @returns {{requests: number, excluded: number, chats: number, promptTokens: number, estimatedPromptTokens: number, label: string}}
 */
export function describeAllTime(allTime = {}, { hasPrices = false } = {}) {
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
    const costNote = hasPrices ? ' Cost is per chat.' : '';
    return {
        requests,
        excluded,
        chats,
        promptTokens,
        estimatedPromptTokens,
        label: `All time: ${formatCountLabel(requests, 'completed request')}${stopped}, across ${formatCountLabel(chats, 'chat')}${measured}${estimated}.${costNote}`,
    };
}

/**
 * The comparison below the cards: one row per configuration label, side by
 * side, so a labelled change can be told from an unlabelled one. The rows come
 * from the same summary the cards use — visible rows folded with the rows the
 * retention cap evicted, priced with the table in force now — so a comparison
 * row and the table under it never describe different requests.
 *
 * `default` is the baseline, so it is always the first row; the labelled groups
 * follow alphabetically, which keeps a group's row in place as requests arrive.
 *
 * @param {{byConfiguration: Object<string, {configuration: string|null, counters: object, cost: object, saving: object}>}} usage
 * @param {import('../src/prices.js').UsagePriceTable|null} prices
 * @returns {{groups: object[], empty: boolean}}
 */
function buildConfigurationGroups(usage, prices) {
    const groups = Object.entries(usage.byConfiguration ?? {}).map(([key, group]) => {
        const counters = group.counters;
        const requests = toCount(counters.requests);
        const excluded = toCount(counters.excludedRequests);
        const measuredPrompt = toCount(counters.promptTokens);
        const estimatedPrompt = toCount(counters.estimatedPromptTokens);
        const knownPrompt = measuredPrompt + estimatedPrompt;
        const rate = hitRateFor(counters);
        const cost = describeDollars(group.cost, prices?.currency);

        return {
            key,
            label: group.configuration ?? DEFAULT_CONFIGURATION_LABEL,
            isDefault: group.configuration === null,
            // A group with only failed rows says so instead of reading as an
            // empty configuration.
            requestsLabel: requests > 0
                ? formatCountLabel(requests, 'completed request')
                : formatCountLabel(excluded, 'failed or stopped request'),
            detailLabel: requests > 0 && excluded > 0
                ? formatCountLabel(excluded, 'failed or stopped request')
                : '',
            metrics: [
                promptMetric(counters, { measuredPrompt, estimatedPrompt }),
                tokenMetric('completion', 'Completion', counters.completionTokens, counters.completionTokenRequests),
                {
                    key: 'hitRate',
                    label: 'Hit rate',
                    value: formatPercent(rate),
                    source: rate == null ? 'unavailable' : 'measured',
                    note: ratedNote(counters, knownPrompt),
                },
                dollarsMetric('cost', 'Cost', group.cost, requests, cost),
            ],
        };
    });

    groups.sort((left, right) => {
        if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
        if (left.label === right.label) return 0;
        return left.label < right.label ? -1 : 1;
    });

    return { groups, empty: groups.length === 0 };
}

/**
 * The cards above the table: one for the whole chat, then one per origin that
 * completed a request, in a fixed order. A card is built from the same summary
 * the rows are — visible rows folded with the rows the retention cap evicted and
 * priced with the table in force now — so the card and the table can never
 * describe different requests.
 *
 * @param {{counters: object, cost: object, saving: object, byOrigin: object}} usage
 * @param {import('../src/prices.js').UsagePriceTable|null} prices
 * @param {{filtered?: boolean}} [options] Whether the sums cover one run instead
 *   of the whole chat, so the overall card names what it describes.
 * @returns {object[]}
 */
function buildCards(usage, prices, { filtered = false } = {}) {
    const cards = [];
    // A chat whose only requests failed still has rows in the table, so the
    // overall card reports them: the numbers above the table never leave a row
    // unaccounted for.
    if (toCount(usage.counters.requests) + toCount(usage.counters.excludedRequests) > 0) {
        cards.push(buildCard('all', usage, prices, { filtered }));
    }

    for (const origin of ORIGIN_ORDER) {
        const summary = usage.byOrigin[origin];
        // An origin whose only rows failed has nothing to report: its failures
        // are counted on the overall card and it is out of every denominator.
        if (!summary || toCount(summary.counters.requests) === 0) continue;
        cards.push(buildCard(origin, summary, prices));
    }
    return cards;
}

/**
 * One card. Every metric carries the source of its number, so an unavailable
 * figure is drawn as a placeholder and a reader is never handed a confident
 * zero the provider never sent.
 *
 * @param {string} scope 'all' or an origin
 * @param {{counters: object, cost: object, saving: object}} summary
 * @param {import('../src/prices.js').UsagePriceTable|null} prices
 * @param {{filtered?: boolean}} [options]
 * @returns {object}
 */
function buildCard(scope, summary, prices, { filtered = false } = {}) {
    const counters = summary.counters;
    const requests = toCount(counters.requests);
    const excluded = toCount(counters.excludedRequests);
    const measuredPrompt = toCount(counters.promptTokens);
    const estimatedPrompt = toCount(counters.estimatedPromptTokens);
    const knownPrompt = measuredPrompt + estimatedPrompt;
    const currency = prices?.currency;
    const rate = hitRateFor(counters);
    const coverage = coverageFor(counters);
    const cost = describeDollars(summary.cost, currency);
    const saving = describeDollars(summary.saving, currency);

    // A chat with no completed request has only failures to report, so its
    // header carries them instead of claiming zero completed requests.
    const head = requests > 0
        ? formatCountLabel(requests, 'completed request')
        : formatCountLabel(excluded, 'failed or stopped request');
    const stopped = requests > 0 && excluded > 0 ? formatCountLabel(excluded, 'failed or stopped request') : '';

    return {
        scope,
        title: scope === 'all' ? (filtered ? 'This run' : 'This chat') : ORIGIN_CARD_TITLES[scope],
        requestsLabel: head,
        detailLabel: stopped,
        // A card with no money says why: a metric showing a placeholder leaves
        // the reader to guess whether the table or the provider is at fault. A
        // chat with no completed request has no cost to explain.
        note: cost || requests === 0 ? '' : describeMissingCost({ prices, promptTokens: measuredPrompt }),
        metrics: [
            promptMetric(counters, { measuredPrompt, estimatedPrompt }),
            tokenMetric('cached', 'Cached', counters.hitTokens, counters.ratedRequests),
            {
                key: 'hitRate',
                label: 'Hit rate',
                value: formatPercent(rate),
                source: rate == null ? 'unavailable' : 'measured',
                note: ratedNote(counters, knownPrompt),
            },
            tokenMetric('completion', 'Completion', counters.completionTokens, counters.completionTokenRequests),
            tokenMetric('total', 'Total tokens', counters.totalTokens, counters.totalTokenRequests),
            {
                key: 'coverage',
                label: 'Coverage',
                value: formatPercent(coverage),
                source: coverage == null
                    ? 'unavailable'
                    : (estimatedPrompt > 0 || counters.unavailableRequests > 0 ? 'estimated' : 'measured'),
                note: '',
            },
            dollarsMetric('cost', 'Cost', summary.cost, requests, cost),
            dollarsMetric('saving', 'Cache saving', summary.saving, requests, saving),
        ],
    };
}

/**
 * The prompt column: the provider's own count when it sent one, the tokenizer's
 * estimate marked with a tilde when it did not, and the estimate as a note when
 * both exist — one number must never read as the other.
 *
 * @param {object} counters
 * @param {{measuredPrompt: number, estimatedPrompt: number}} prompts
 * @returns {object}
 */
function promptMetric(counters, { measuredPrompt, estimatedPrompt }) {
    const reported = toCount(counters.coveredRequests) > 0;
    const estimatedLabel = `~${formatCount(estimatedPrompt)}`;

    return {
        key: 'prompt',
        label: 'Prompt',
        value: reported
            ? formatCount(measuredPrompt)
            : (estimatedPrompt > 0 ? estimatedLabel : PLACEHOLDER),
        source: reported ? 'measured' : (estimatedPrompt > 0 ? 'estimated' : 'unavailable'),
        note: reported && estimatedPrompt > 0 ? `${estimatedLabel} estimated` : '',
    };
}

/**
 * One token column: the sum of the counts that arrived, and a placeholder when
 * none did. A total of zero from no requests counted is not the same statement
 * as a zero the provider reported.
 *
 * @param {string} key
 * @param {string} label
 * @param {number} total
 * @param {number} countedRequests Requests that reported this count
 * @returns {object}
 */
function tokenMetric(key, label, total, countedRequests) {
    // The count says how many requests reported this number, and the sum says
    // they did: a persisted counter from an older shape can lack the count but
    // never the total it already carried.
    const counted = toCount(countedRequests) > 0 || total > 0;
    return {
        key,
        label,
        value: counted ? formatCount(total) : PLACEHOLDER,
        source: counted ? 'measured' : 'unavailable',
        note: '',
    };
}

/**
 * One dollar column. A provider-reported figure and a table-derived one are
 * shown exactly as `describeDollars` wrote them — side by side, never added —
 * and the note says how many requests the figure covers.
 *
 * @param {string} key
 * @param {string} label
 * @param {{measured: number, measuredRequests: number, estimated: number, estimatedRequests: number, requests: number}} figures
 * @param {number} requests
 * @param {string|null} value
 * @returns {object}
 */
function dollarsMetric(key, label, figures, requests, value) {
    const covered = figures.requests > 0;
    return {
        key,
        label,
        value: value ?? PLACEHOLDER,
        source: !covered ? 'unavailable' : (figures.estimatedRequests > 0 ? 'estimated' : 'measured'),
        note: describeDollarCoverage(figures, requests),
    };
}

/**
 * How much of the prompt the hit rate was computed over, when it is not all of
 * it: a rate over part of a set must not look like the rate of the whole set.
 *
 * @param {object} counters
 * @param {number} knownPrompt Reported plus estimated prompt tokens
 * @returns {string}
 */
function ratedNote(counters, knownPrompt) {
    const rated = toCount(counters.ratedPromptTokens);
    if (rated === 0 || rated >= knownPrompt) return '';
    return `${formatCount(rated)} of ${formatCount(knownPrompt)} prompt tokens`;
}

/**
 * Why a card has no cost. The three reasons read differently because they ask
 * the user for different things: a price row, or a request that reports its
 * prompt tokens at all.
 *
 * @param {{prices: import('../src/prices.js').UsagePriceTable|null, promptTokens: number}} options
 * @returns {string}
 */
function describeMissingCost({ prices, promptTokens }) {
    if (!hasPriceEntries(prices)) return 'no cost — the price table is empty';
    if (promptTokens === 0) return 'no cost — these requests reported no prompt count';
    return 'no cost — no complete price row for these requests';
}

/**
 * One dollar amount as text: a reported figure is shown as reported and never
 * converted, a table-derived one in the table's currency, and both side by side
 * when the requests split across the two — never added together, because
 * reported credits and priced dollars are not the same unit.
 *
 * @param {{measured: number, measuredRequests: number, estimated: number, estimatedRequests: number}} figures
 * @param {string} currency
 * @returns {string|null}
 */
function describeDollars(figures, currency) {
    const reported = figures.measuredRequests > 0;
    const estimated = figures.estimatedRequests > 0;
    if (!reported && !estimated) return null;

    if (reported && estimated) {
        return `${formatCost(figures.measured, currency, 'measured')} and `
            + `${formatCost(figures.estimated, currency, 'estimated')} estimated`;
    }
    if (reported) return formatCost(figures.measured, currency, 'measured');
    return formatCost(figures.estimated, currency, 'estimated');
}

/**
 * How many requests a dollar figure actually covers, so a partial price cannot
 * look like a complete one.
 *
 * @param {{measuredRequests: number, estimatedRequests: number}} figures
 * @param {number} requests
 * @returns {string}
 */
function describeDollarCoverage(figures, requests) {
    if (figures.requests >= requests) return '';
    return `for ${formatCount(figures.requests)} of ${formatCount(requests)} requests`;
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

/**
 * One table row. The shared prefix is the tokenizer's estimate — the provider
 * never reports it — so it carries the same tilde an estimated prompt does. The
 * breaker flag is spelled out rather than drawn as an icon: a reader who does
 * not know the rule still learns what the row suspects.
 *
 * @param {object} record
 * @param {import('../src/prices.js').UsagePriceTable|null} prices
 * @returns {object}
 */
function buildRow(record, prices) {
    const measuredPrompt = Number.isFinite(record.promptTokens) ? record.promptTokens : null;
    const estimatedPrompt = Number.isFinite(record.estimatedPromptTokens) ? record.estimatedPromptTokens : null;
    const prompt = measuredPrompt ?? estimatedPrompt;
    const sharedPrefix = Number.isFinite(record.sharedPrefixTokens) ? record.sharedPrefixTokens : null;
    // A failed or aborted row never contributes to a total, so it must not
    // show a dollar figure the total ignores.
    const resolved = isCompletedUsageRecord(record)
        ? resolveUsageCost(record, prices)
        : { cost: null, costSource: 'unavailable', saving: null, savingSource: 'unavailable' };
    const currency = prices?.currency;

    return {
        recordId: record.recordId ?? '',
        timeLabel: formatTime(record.timestamp),
        originLabel: KNOWN_ORIGINS.has(record.origin) ? record.origin : PLACEHOLDER,
        labelLabel: record.label || PLACEHOLDER,
        // The row's own configuration: what was in force when it was sent, not
        // what the page has now. An unlabelled row is a `default` row.
        configurationLabel: normalizeConfigurationLabel(record.configuration) ?? DEFAULT_CONFIGURATION_LABEL,
        providerLabel: record.provider || 'unknown',
        modelLabel: record.model || 'unknown',
        promptLabel: prompt == null
            ? PLACEHOLDER
            : `${measuredPrompt == null ? '~' : ''}${formatCount(prompt)}`,
        completionLabel: formatCount(record.completionTokens),
        costLabel: formatCost(resolved.cost, currency, resolved.costSource),
        savingLabel: formatCost(resolved.saving, currency, resolved.savingSource),
        sharedPrefixLabel: sharedPrefix == null ? PLACEHOLDER : `~${formatCount(sharedPrefix)}`,
        prefixBreakerLabel: record.possiblePrefixBreaker ? 'Possible prefix breaker' : '',
        latencyLabel: formatLatency(record.latencyMs),
        statusLabel: STATUS_LABELS[record.status] ?? PLACEHOLDER,
        sourceLabel: SOURCE_LABELS[record.usageSource] ?? SOURCE_LABELS.unavailable,
    };
}

function formatRunTime(timestamp) {
    if (!Number.isFinite(timestamp)) return PLACEHOLDER;
    return RUN_TIME_FORMAT.format(new Date(timestamp));
}

function formatTime(timestamp) {
    if (!Number.isFinite(timestamp)) return PLACEHOLDER;
    const date = new Date(timestamp);
    const pad = (part) => String(part).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * One resolved dollar figure. A provider-reported figure is shown as reported
 * and never converted into the table's currency; a table-derived one carries
 * enough decimals to be read when a single turn costs a fraction of a cent.
 *
 * @param {number|null} value
 * @param {string} currency
 * @param {string} [source]
 * @returns {string}
 */
function formatCost(value, currency, source = 'estimated') {
    if (!Number.isFinite(value)) return PLACEHOLDER;
    if (source === 'measured') return `${REPORTED_FORMAT.format(value)} reported`;

    const digits = value !== 0 && Math.abs(value) < 0.01 ? 8 : 2;
    const code = currency || 'USD';
    const key = `${code}:${digits}`;
    try {
        if (!COST_FORMATTERS.has(key)) {
            COST_FORMATTERS.set(key, new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: code,
                minimumFractionDigits: digits,
                maximumFractionDigits: digits,
            }));
        }
        return COST_FORMATTERS.get(key).format(value);
    } catch {
        return `${NUMBER_FORMAT.format(value)} ${code}`;
    }
}

function hasPriceEntries(prices) {
    return Array.isArray(prices?.entries) && prices.entries.length > 0;
}

function formatLatency(latencyMs) {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return PLACEHOLDER;
    if (latencyMs < 1000) return `${Math.round(latencyMs)} ms`;
    return `${(latencyMs / 1000).toFixed(1)} s`;
}

function formatCount(value) {
    return Number.isFinite(value) ? NUMBER_FORMAT.format(value) : PLACEHOLDER;
}

function formatPercent(value) {
    return Number.isFinite(value) ? PERCENT_FORMAT.format(value) : PLACEHOLDER;
}

function formatCountLabel(count, noun) {
    return `${NUMBER_FORMAT.format(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function toCount(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
