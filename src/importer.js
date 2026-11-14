/**
 * Spendbook importer — an existing VectFox user's history, moved in on request.
 *
 * VectFox keeps a chat's usage in `chat_metadata.vectfox_usage` and its price
 * table in `extension_settings.vectfox.usage_prices`. Spendbook keeps its own
 * namespaces and never reads another extension's state at runtime; this module
 * is the one exception, and it runs only when the user clicks Import. It reads
 * the old shapes and returns new ones; it never writes, and it never deletes or
 * edits a legacy key, so a rollback to VectFox still has its ledger.
 *
 * The old origin vocabulary is translated here, once: `vectfox-internal` becomes
 * `internal` and keeps its label, while `worker-profile` and `unknown` become
 * `internal` with no label — the new vocabulary has no worker origin, because
 * routing is a connection-profile fact rather than a cause of a request.
 */

import { normalizeConfigurationLabel } from './configuration.js';
import { normalizePriceTable, PRICE_FIELDS } from './prices.js';
import { normalizeUsageArchive } from './stats.js';

const LEGACY_CHAT_METADATA_KEY = 'vectfox_usage';
const LEGACY_SETTINGS_NAMESPACE = 'vectfox';
const LEGACY_PRICE_SETTINGS_KEY = 'usage_prices';

/** The origin vocabulary VectFox's records use, named once. */
const LEGACY_ORIGINS = Object.freeze({
    STORY: 'story',
    QUIET: 'quiet',
    WORKER_PROFILE: 'worker-profile',
    VECTFOX_INTERNAL: 'vectfox-internal',
    UNKNOWN: 'unknown',
});

/**
 * Reads one chat's legacy namespace and returns what the ledger can adopt.
 * Nothing is written: the caller applies the result and the legacy keys stay
 * exactly as they were.
 *
 * Only the shape VectFox actually persists is accepted: namespace version 1, a
 * records array, and an owner that is this chat. A version it never wrote, or a
 * namespace another chat owns, is not imported.
 *
 * @param {object} options
 * @param {object|null} options.metadata The open chat's live `chat_metadata`.
 * @param {string|null} options.chatId The open chat, and the only chat imported.
 *
 * @returns {{revision: number|null, records: object[], runs: object[], currentRunId: string|null, archived: object}|null}
 *   The import, or null when this chat has no legacy ledger to import (none,
 *   malformed, or a branch copy's). The runs are passed on as they were and the
 *   ledger gives them their shape, so run normalisation stays in one place.
 */
export function readLegacyChat({ metadata, chatId }) {
    if (!chatId || !metadata || typeof metadata !== 'object') return null;
    const raw = metadata[LEGACY_CHAT_METADATA_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.version !== 1 || !Array.isArray(raw.records)) return null;
    // A namespace whose owner is another chat is a branch or a file copy: the
    // rows belong to the chat it names, the same rule the ledger applies when it
    // opens a copied chat.
    if (typeof raw.ownerChatId === 'string' && raw.ownerChatId !== chatId) return null;

    return {
        // VectFox's content watermark. The ledger keeps it beside its own state
        // so a second click knows this record set is the one it already has.
        revision: Number.isFinite(raw.revision) ? raw.revision : null,
        records: raw.records
            .filter((entry) => isRecord(entry))
            .map((entry) => mapRecord(entry, chatId)),
        runs: Array.isArray(raw.runs) ? raw.runs : [],
        currentRunId: typeof raw.currentRunId === 'string' && raw.currentRunId ? raw.currentRunId : null,
        archived: mapArchive(raw.archived),
    };
}

/**
 * The counters of the rows the old cap folded. The origin groups need no
 * translation here: the archive normaliser already folds every origin it does
 * not know into `internal`, which is the mapping decided for the old background
 * work. Token counters the old archive never folded — cache writes, completion,
 * reasoning, totals — come over as zero rather than as invented numbers.
 *
 * @param {unknown} raw
 * @returns {object}
 */
function mapArchive(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const byConfiguration = Object.values(source.byConfiguration ?? {}).map((entry) => (
        entry && typeof entry === 'object'
            ? { configuration: mapConfiguration(entry.configuration), accumulator: entry.accumulator }
            : entry
    ));

    return normalizeUsageArchive({
        total: source.total,
        byOrigin: source.byOrigin,
        byConfiguration,
        byModel: Object.values(source.byModel ?? {})
            .filter((bucket) => bucket && typeof bucket === 'object')
            .map(mapModelBucket),
    });
}

/**
 * One old per-model group as Spendbook's archive holds it. The old bucket kept
 * one accumulator for the group, with the dollars the old table resolved at
 * eviction time next to the token counts; Spendbook keeps the token counts so a
 * later price edit can reprice them, and the provider-reported dollars apart.
 * A type of dollar the group has is not also folded as repricable, so the same
 * rows cannot be counted as both.
 *
 * The old group named no origin and no configuration, so those dollars join no
 * card here; the summary keeps them in the overall total rather than guessing.
 *
 * @param {object} bucket
 * @returns {object}
 */
function mapModelBucket(bucket) {
    const accumulated = bucket.accumulator && typeof bucket.accumulator === 'object' ? bucket.accumulator : {};
    const reportedCostRequests = nonNegativeOrNull(accumulated.costMeasuredRequests) ?? 0;
    const reportedSavingRequests = nonNegativeOrNull(accumulated.savingMeasuredRequests) ?? 0;

    return {
        provider: textOrNull(bucket.provider) ?? '',
        model: textOrNull(bucket.model) ?? '',
        origin: null,
        configuration: null,
        unpricedCost: reportedCostRequests > 0 ? {} : accumulated,
        unpricedSaving: reportedSavingRequests > 0 ? {} : accumulated,
        reportedCost: finiteNumber(accumulated.costMeasured) ?? 0,
        reportedCostRequests,
        reportedSaving: finiteNumber(accumulated.savingMeasured) ?? 0,
        reportedSavingRequests,
    };
}

/**
 * The old configuration snapshot as Spendbook's label. VectFox's records name a
 * ghosting snapshot rather than a label, and its own drawer showed it as the
 * one line below; a row whose snapshot the old code could not fill in keeps the
 * same "unknown" wording instead of collapsing into `default`.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function mapConfiguration(value) {
    if (typeof value === 'string') return normalizeConfigurationLabel(value);
    if (!value || typeof value !== 'object') return null;
    const state = value.ghostEnabled ? 'Ghosting on' : 'Ghosting off';
    const batch = Number.isFinite(value.ghostBatchSize) ? `batch ${value.ghostBatchSize}` : 'batch unknown';
    const keep = Number.isFinite(value.ghostKeepRecent) ? `keep ${value.ghostKeepRecent}` : 'keep unknown';
    return normalizeConfigurationLabel(`${state} · ${batch} · ${keep}`);
}

/**
 * One legacy record as Spendbook stores it. The old label field is renamed, the
 * origin is translated, and the transient prompt fingerprint is dropped — it is
 * a hash of prompt text, and no Spendbook record carries one. The fields read
 * here are the old vocabulary, which VectFox no longer grows; this is not a copy
 * of the live record shape, so it cannot drift away from one.
 *
 * @param {object} entry
 * @param {string} chatId
 * @returns {object}
 */
function mapRecord(entry, chatId) {
    const origin = mapLegacyOrigin(entry.origin);
    return {
        recordId: entry.recordId,
        timestamp: finiteNumber(entry.timestamp),
        chatId,
        runId: textOrNull(entry.runId),
        origin,
        // Only an internally marked call carried a label in the old vocabulary;
        // every other old origin maps to no label at all.
        label: entry.origin === LEGACY_ORIGINS.VECTFOX_INTERNAL ? textOrNull(entry.featureLabel) : null,
        configuration: mapConfiguration(entry.configuration),
        provider: textOrNull(entry.provider),
        model: textOrNull(entry.model),
        responseId: textOrNull(entry.responseId),
        stream: entry.stream === true,
        status: textOrNull(entry.status),
        httpStatus: nonNegativeOrNull(entry.httpStatus),
        latencyMs: nonNegativeOrNull(entry.latencyMs),
        messageCount: nonNegativeOrNull(entry.messageCount),
        promptTokens: nonNegativeOrNull(entry.promptTokens),
        hitTokens: nonNegativeOrNull(entry.hitTokens),
        missTokens: nonNegativeOrNull(entry.missTokens),
        cacheWriteTokens: nonNegativeOrNull(entry.cacheWriteTokens),
        completionTokens: nonNegativeOrNull(entry.completionTokens),
        reasoningTokens: nonNegativeOrNull(entry.reasoningTokens),
        totalTokens: nonNegativeOrNull(entry.totalTokens),
        // Reported dollars are kept sign-and-all, the same rule as a captured row.
        cost: finiteNumber(entry.cost),
        cacheDiscount: finiteNumber(entry.cacheDiscount),
        estimatedPromptTokens: nonNegativeOrNull(entry.estimatedPromptTokens),
        usageSource: textOrNull(entry.usageSource) ?? 'unavailable',
        sharedPrefixTokens: nonNegativeOrNull(entry.sharedPrefixTokens),
        possiblePrefixBreaker: entry.possiblePrefixBreaker === true,
    };
}

/**
 * The one-sentence result of a click, for the drawer's line. `found: false` is
 * its own sentence: a chat with no old ledger must not read as a failed import
 * of nothing.
 *
 * @param {object} result
 * @param {boolean} result.found Whether the chat had a legacy ledger to import.
 * @param {number} [result.added] Rows copied in.
 * @param {number} [result.alreadyPresent] Rows the chat already had.
 * @param {boolean} [result.pricesImported] Whether the old price table was stored.
 * @returns {string}
 */
export function describeImportResult({ found, added = 0, alreadyPresent = 0, pricesImported = false }) {
    const prices = pricesImported ? 'Prices imported.' : 'Prices not imported.';
    // The prices live outside the chat, so they are reported even when this chat
    // had no ledger of its own.
    if (!found) return `Nothing to import: this chat has no VectFox usage ledger. ${prices}`;
    const records = added === 1 ? '1 record' : `${added} records`;
    return `${records} added, ${alreadyPresent} already present. ${prices}`;
}

/**
 * The old price table, brought over only into an empty table. One entry of any
 * kind stops the import, so a row the user entered is never replaced; the old
 * table itself must hold something, or there is nothing to import. The tracking
 * flag is deliberately not imported — an install must never start tapping
 * because of a migration.
 *
 * @param {object} options
 * @param {object|null} options.extensionSettings SillyTavern's shared settings.
 * @param {import('./prices.js').UsagePriceTable|null} options.currentPrices
 * @returns {import('./prices.js').UsagePriceTable|null} The table to store, or
 *   null when nothing may be imported.
 */
export function importableLegacyPrices({ extensionSettings, currentPrices }) {
    if ((currentPrices?.entries ?? []).length > 0) return null;
    const raw = extensionSettings?.[LEGACY_SETTINGS_NAMESPACE]?.[LEGACY_PRICE_SETTINGS_KEY];
    if (!hasEnteredPrice(raw)) return null;
    return normalizePriceTable(raw);
}

/**
 * Whether a table holds anything the user actually put there: a provider, a
 * model, or a rate. A malformed value holds nothing.
 *
 * @param {unknown} table
 * @returns {boolean}
 */
function hasEnteredPrice(table) {
    const entries = Array.isArray(table?.entries) ? table.entries : [];
    return entries.some((entry) => !!entry && typeof entry === 'object' && (
        (typeof entry.provider === 'string' && entry.provider.trim() !== '')
        || (typeof entry.model === 'string' && entry.model.trim() !== '')
        || PRICE_FIELDS.some((field) => Number.isFinite(entry[field]))
    ));
}

/**
 * The old origin vocabulary onto the new one. An origin this importer does not
 * know — including a missing one — becomes `internal` with no label, which is
 * what the old code called background work.
 *
 * @param {unknown} origin
 * @returns {string}
 */
function mapLegacyOrigin(origin) {
    if (origin === LEGACY_ORIGINS.STORY || origin === LEGACY_ORIGINS.QUIET) return origin;
    return 'internal';
}

/**
 * @param {unknown} entry
 * @returns {boolean}
 */
function isRecord(entry) {
    return !!entry && typeof entry === 'object'
        && typeof entry.recordId === 'string' && entry.recordId !== '';
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function textOrNull(value) {
    return typeof value === 'string' ? value : null;
}

/**
 * A reported count, status code or latency as stored: a finite, non-negative
 * number, or null so a missing one never reads as zero.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function nonNegativeOrNull(value) {
    return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteNumber(value) {
    return Number.isFinite(value) ? value : null;
}
