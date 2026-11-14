/**
 * Spendbook export.
 *
 * Builds the versioned JSON file the drawer downloads: one file for a bug
 * report, holding the open chat's records, its measurement runs, the counters of
 * the rows the retention cap folded, and the all-time totals — and nothing else.
 *
 * The export is a projection, not a dump. That is the privacy guarantee: no chat
 * identifier, no prompt text, no request body and no key has a field in the
 * output, so a future record field cannot ride along by accident. The shape is
 * owned here, and so is the one chat-shaped value the file may carry: the name
 * the user opted in to. It is resolved from SillyTavern's live context — the
 * character, or the group in a group chat — and never from the chat id, which is
 * the chat's file name.
 */

import { DEFAULT_CONFIGURATION_LABEL, normalizeConfigurationLabel } from './configuration.js';
import { normalizeUsageAccumulator } from './stats.js';

export const USAGE_EXPORT_VERSION = 1;
export const USAGE_EXPORT_KIND = 'spendbook-usage-export';

/**
 * The record fields the export publishes, in the order a reader meets them.
 * A record's `chatId` is deliberately absent: the file must not say which chat
 * it came from.
 */
const EXPORT_RECORD_FIELDS = Object.freeze([
    'recordId',
    'timestamp',
    'runId',
    'origin',
    'label',
    'configuration',
    'provider',
    'model',
    'responseId',
    'stream',
    'status',
    'httpStatus',
    'latencyMs',
    'messageCount',
    'promptTokens',
    'hitTokens',
    'missTokens',
    'cacheWriteTokens',
    'completionTokens',
    'reasoningTokens',
    'totalTokens',
    'cost',
    'cacheDiscount',
    'estimatedPromptTokens',
    'usageSource',
    'sharedPrefixTokens',
    'possiblePrefixBreaker',
]);

/**
 * Builds the export object from one chat's snapshot. The caller stringifies and
 * downloads it.
 *
 * @param {object} [options]
 * @param {number} [options.now] Export time, injected for tests.
 * @param {object|null} [options.snapshot] Output of
 *   `UsageLedger.exportSnapshotFor`: `{ records, runs, archived, allTime }`.
 * @param {object|null} [options.chatContext] SillyTavern's `getContext()`, read
 *   for the open chat's name. The export resolves the name itself, so a caller
 *   cannot hand in a chat file name instead.
 * @param {boolean} [options.includeChatNames] The user's opt-in; off by default.
 * @returns {object}
 */
export function buildUsageExport({
    now = Date.now(),
    snapshot = null,
    chatContext = null,
    includeChatNames = false,
} = {}) {
    const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const chatName = exportChatName({ chatContext, includeChatNames });

    return {
        version: USAGE_EXPORT_VERSION,
        kind: USAGE_EXPORT_KIND,
        exportedAt: toIsoString(now),
        ...(chatName ? { chatName } : {}),
        records: (Array.isArray(source.records) ? source.records : [])
            .filter((entry) => entry && typeof entry === 'object')
            .map(projectRecord),
        runs: projectRuns(source.runs),
        aggregates: {
            archived: projectArchive(source.archived),
            allTime: projectAllTime(source.allTime),
        },
    };
}

/**
 * A download name that is safe on every platform and says which chat and which
 * moment the file came from. It names the chat by the same rule the contents use
 * — the character, or the group in a group chat — and never by chat id, which is
 * the chat's file name. The name is not part of the opt-in: it is what tells two
 * downloads apart, and a user who wants the name out of the contents still needs
 * the file to be findable.
 *
 * @param {object} [options]
 * @param {number} [options.now] Export time, injected for tests.
 * @param {object|null} [options.chatContext] SillyTavern's `getContext()`.
 * @returns {string}
 */
export function usageExportFileName({ now = Date.now(), chatContext = null } = {}) {
    const name = resolveChatName(chatContext);
    const slug = name ? chatNameSlug(name) : '';
    return `spendbook-usage-${slug ? `${slug}-` : ''}${exportStamp(now)}.json`;
}

/**
 * The one place the opt-in and the name rule meet: a name is published only when
 * the user asked for it, and it is always the name SillyTavern shows for the open
 * chat. Both the file's contents and its file name go through here, so the two
 * cannot disagree about whether the chat may be named.
 *
 * @param {object} options
 * @param {object|null} options.chatContext
 * @param {boolean} options.includeChatNames
 * @returns {string|null}
 */
function exportChatName({ chatContext, includeChatNames }) {
    if (includeChatNames !== true) return null;
    return resolveChatName(chatContext);
}

/**
 * The name of the chat open in SillyTavern, or null when there is none to give.
 *
 * In a group chat `name2` is whichever member is currently speaking, so the
 * group's own name is read from `groups`; a one-on-one chat is named by its
 * character. The chat id is read only to answer whether a chat is open at all —
 * outside a chat `name2` still holds the default assistant, which names no chat.
 *
 * @param {object|null} context `getContext()` from SillyTavern's extension API.
 * @returns {string|null}
 */
function resolveChatName(context) {
    if (!context || typeof context !== 'object') return null;
    if (typeof context.chatId !== 'string' || context.chatId === '') return null;

    const raw = isGroupChat(context) ? groupName(context) : context.name2;
    if (typeof raw !== 'string') return null;
    const name = raw.trim();
    return name ? name : null;
}

/**
 * @param {object} context
 * @returns {boolean}
 */
function isGroupChat(context) {
    return context.groupId !== null && context.groupId !== undefined && context.groupId !== '';
}

/**
 * The group the open chat belongs to, or null when the context does not list it.
 * A group chat never falls back to a character name: that would name one member
 * as if it were the chat.
 *
 * @param {object} context
 * @returns {string|null}
 */
function groupName(context) {
    const groups = Array.isArray(context.groups) ? context.groups : [];
    const group = groups.find((entry) => entry && entry.id === context.groupId);
    return typeof group?.name === 'string' ? group.name : null;
}

/**
 * One record cut down to the published field list. A field the record does not
 * carry is published as `null`, so the shape never changes with the data.
 *
 * @param {object} record
 * @returns {object}
 */
function projectRecord(record) {
    const projected = {};
    for (const field of EXPORT_RECORD_FIELDS) {
        projected[field] = field in record ? (record[field] ?? null) : null;
    }
    return projected;
}

/**
 * A chat's measurement runs, newest first as the ledger lists them. A run is its
 * own marker, not a chat identifier: the id, the label the user typed and the
 * time it started are what a reader needs to place a record in a window.
 *
 * @param {object[]|null} runs
 * @returns {object[]}
 */
function projectRuns(runs) {
    return (Array.isArray(runs) ? runs : [])
        .filter((run) => run && typeof run === 'object' && typeof run.runId === 'string' && run.runId)
        .map((run) => ({
            runId: run.runId,
            label: textOrNull(run.label),
            startedAt: Number.isFinite(run.startedAt) ? run.startedAt : null,
        }));
}

/**
 * The counters of the rows the retention cap folded away. Token counters are
 * published through the accumulator normaliser, so a field the accumulator does
 * not name cannot ride along here either.
 *
 * @param {object|null} archive
 * @returns {{total: object, byOrigin: object, byConfiguration: object, byModel: object[]}}
 */
function projectArchive(archive) {
    const source = archive && typeof archive === 'object' ? archive : {};

    const byOrigin = {};
    for (const [origin, counters] of Object.entries(source.byOrigin ?? {})) {
        defineGroup(byOrigin, origin, normalizeUsageAccumulator(counters));
    }

    const byConfiguration = {};
    for (const entry of Object.values(source.byConfiguration ?? {})) {
        if (!entry || typeof entry !== 'object') continue;
        const configuration = normalizeConfigurationLabel(entry.configuration);
        // A host label is free text, so a label spelled `__proto__` has to become
        // a group of its own rather than writing through an inherited member.
        defineGroup(byConfiguration, configuration ?? DEFAULT_CONFIGURATION_LABEL, {
            configuration,
            accumulator: normalizeUsageAccumulator(entry.accumulator),
        });
    }

    // The archive keys its model groups by a separator-joined string; the export
    // publishes them as a list, so no key has to encode a provider, a model, an
    // origin and a label at once.
    const buckets = Object.values(source.byModel ?? {});

    return {
        total: normalizeUsageAccumulator(source.total),
        byOrigin,
        byConfiguration,
        byModel: buckets.filter((bucket) => bucket && typeof bucket === 'object').map(projectModelBucket),
    };
}

/**
 * One price-input group of the folded rows: which provider, model, origin and
 * configuration it describes, the token counters a price table still has to
 * resolve, and the dollars the provider reported itself.
 *
 * @param {object} bucket
 * @returns {object}
 */
function projectModelBucket(bucket) {
    return {
        provider: textOrNull(bucket.provider),
        model: textOrNull(bucket.model),
        origin: textOrNull(bucket.origin),
        configuration: normalizeConfigurationLabel(bucket.configuration),
        unpricedCost: normalizeUsageAccumulator(bucket.unpricedCost),
        unpricedSaving: normalizeUsageAccumulator(bucket.unpricedSaving),
        reportedCost: numberOrZero(bucket.reportedCost),
        reportedCostRequests: numberOrZero(bucket.reportedCostRequests),
        reportedSaving: numberOrZero(bucket.reportedSaving),
        reportedSavingRequests: numberOrZero(bucket.reportedSavingRequests),
    };
}

/**
 * The all-time totals across chats — the counters, never the per-chat buckets
 * they were accumulated in: those are keyed by chat id, and no chat identifier
 * belongs in this file.
 *
 * @param {{totals?: object}|null} allTime
 * @returns {object}
 */
function projectAllTime(allTime) {
    return normalizeUsageAccumulator(allTime?.totals);
}

/**
 * Defines one group as an own enumerable property, whatever the key spells.
 *
 * @param {object} groups
 * @param {string} key
 * @param {object} group
 */
function defineGroup(groups, key, group) {
    Object.defineProperty(groups, key, {
        value: group,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}

/**
 * The chat name as a file-name segment: path-hostile characters and control
 * characters become dashes, whitespace is collapsed, and the segment is capped
 * so a paragraph-long name cannot push the timestamp out of sight.
 *
 * @param {string} name
 * @returns {string}
 */
function chatNameSlug(name) {
    return name
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[.]+$/g, '')
        .slice(0, 60)
        .replace(/[-.]+$/, '');
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function textOrNull(value) {
    return typeof value === 'string' ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function numberOrZero(value) {
    return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * An ISO timestamp for the export time.
 *
 * @param {number} value
 * @returns {string}
 */
function toIsoString(value) {
    const timestamp = Number.isFinite(value) ? value : Date.now();
    return new Date(timestamp).toISOString();
}

/**
 * @param {number} value
 * @returns {string} `YYYYMMDD-HHmmss` in UTC, so two exports sort by name.
 */
function exportStamp(value) {
    const date = new Date(Number.isFinite(value) ? value : Date.now());
    const pad = (part) => String(part).padStart(2, '0');
    return [
        date.getUTCFullYear(),
        pad(date.getUTCMonth() + 1),
        pad(date.getUTCDate()),
        '-',
        pad(date.getUTCHours()),
        pad(date.getUTCMinutes()),
        pad(date.getUTCSeconds()),
    ].join('');
}
