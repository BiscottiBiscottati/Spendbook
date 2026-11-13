/**
 * Spendbook usage counters.
 *
 * Pure maths for the rows the retention cap removes from a chat: a row that is
 * evicted is folded into raw counters instead of dropped, so the chat's totals
 * keep counting. The same accumulator shape carries the all-time bucket of each
 * chat in local storage.
 *
 * Both the archive and a live summary read one record the same way, so a folded
 * row and a visible one can never disagree about what a completed request is.
 */

const ACCUMULATOR_FIELDS = Object.freeze([
    'requests',
    'measuredRequests',
    'estimatedRequests',
    'unavailableRequests',
    'excludedRequests',
    'ratedRequests',
    'coveredRequests',
    'estimatedPromptRequests',
    'promptTokens',
    'estimatedPromptTokens',
    'hitTokens',
    'ratedPromptTokens',
    'completionTokens',
    'reasoningTokens',
    'totalTokens',
]);

import { USAGE_ORIGINS } from './origin.js';

const COMPLETED_STATUSES = new Set(['ok', 'no-usage']);

const KNOWN_ORIGINS = new Set(Object.values(USAGE_ORIGINS));

/**
 * Zeroed counters for the rows folded into one bucket.
 *
 * @returns {object}
 */
export function createUsageAccumulator() {
    return Object.fromEntries(ACCUMULATOR_FIELDS.map((field) => [field, 0]));
}

/**
 * Coerces a persisted accumulator into finite counters.
 *
 * @param {object|null} value
 * @returns {object}
 */
export function normalizeUsageAccumulator(value) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(ACCUMULATOR_FIELDS.map((field) => [
        field,
        Number.isFinite(source[field]) ? source[field] : 0,
    ]));
}

/**
 * Folds one record into an accumulator: completed requests count by what the
 * provider reported, failed and aborted ones only in the excluded count.
 *
 * @param {object} accumulator
 * @param {object} record
 * @returns {object} The same accumulator.
 */
export function addRecordToUsageAccumulator(accumulator, record) {
    if (!accumulator || typeof accumulator !== 'object') return accumulator;
    if (!isCompleted(record)) {
        accumulator.excludedRequests += 1;
        return accumulator;
    }

    accumulator.requests += 1;
    if (isMeasured(record)) {
        accumulator.measuredRequests += 1;
        if (isTokenCount(record.promptTokens)) {
            accumulator.promptTokens += record.promptTokens;
            accumulator.coveredRequests += 1;
        }
    } else if (isEstimated(record)) {
        accumulator.estimatedRequests += 1;
        if (isTokenCount(record.estimatedPromptTokens)) {
            accumulator.estimatedPromptTokens += record.estimatedPromptTokens;
            accumulator.estimatedPromptRequests += 1;
        }
    } else {
        accumulator.unavailableRequests += 1;
    }

    // The hit-rate pair is only comparable when the provider reported both
    // counts, so a request without them never dilutes the rate.
    if (isTokenCount(record.promptTokens) && isTokenCount(record.hitTokens)) {
        accumulator.ratedRequests += 1;
        accumulator.ratedPromptTokens += record.promptTokens;
        accumulator.hitTokens += record.hitTokens;
    }
    // Output counts are summed as reported; a row without one adds nothing.
    if (isTokenCount(record.completionTokens)) accumulator.completionTokens += record.completionTokens;
    if (isTokenCount(record.reasoningTokens)) accumulator.reasoningTokens += record.reasoningTokens;
    if (isTokenCount(record.totalTokens)) accumulator.totalTokens += record.totalTokens;
    return accumulator;
}

/**
 * Sums two accumulators.
 *
 * @param {object|null} left
 * @param {object|null} right
 * @returns {object}
 */
export function mergeUsageAccumulators(left, right) {
    const merged = normalizeUsageAccumulator(left);
    const other = normalizeUsageAccumulator(right);
    for (const field of ACCUMULATOR_FIELDS) merged[field] += other[field];
    return merged;
}

/**
 * Subtracts one accumulator from another, clamping at zero: removing a chat
 * from the all-time total must never make the total negative.
 *
 * @param {object|null} left
 * @param {object|null} right
 * @returns {object}
 */
export function subtractUsageAccumulators(left, right) {
    const merged = normalizeUsageAccumulator(left);
    const other = normalizeUsageAccumulator(right);
    for (const field of ACCUMULATOR_FIELDS) merged[field] = Math.max(0, merged[field] - other[field]);
    return merged;
}

/**
 * True when an accumulator holds nothing worth persisting.
 *
 * @param {object|null} accumulator
 * @returns {boolean}
 */
export function isUsageAccumulatorEmpty(accumulator) {
    const normalized = normalizeUsageAccumulator(accumulator);
    return ACCUMULATOR_FIELDS.every((field) => normalized[field] === 0);
}

/**
 * The per-chat archive of the rows the retention cap has evicted: overall, per
 * origin and per configuration label.
 *
 * @returns {{total: object, byOrigin: object, byConfiguration: object}}
 */
export function createUsageArchive() {
    return { total: createUsageAccumulator(), byOrigin: {}, byConfiguration: {} };
}

/**
 * Coerces a persisted archive into the shape the totals expect.
 *
 * @param {object|null} value
 * @returns {{total: object, byOrigin: object, byConfiguration: object}}
 */
export function normalizeUsageArchive(value) {
    const archive = createUsageArchive();
    if (!value || typeof value !== 'object') return archive;
    archive.total = normalizeUsageAccumulator(value.total);
    for (const [origin, counters] of Object.entries(value.byOrigin ?? {})) {
        if (!counters || typeof counters !== 'object') continue;
        archive.byOrigin[origin] = normalizeUsageAccumulator(counters);
    }
    for (const [key, entry] of Object.entries(value.byConfiguration ?? {})) {
        if (!entry || typeof entry !== 'object') continue;
        archive.byConfiguration[key] = {
            configuration: typeof entry.configuration === 'string' ? entry.configuration : null,
            accumulator: normalizeUsageAccumulator(entry.accumulator),
        };
    }
    return archive;
}

/**
 * Folds one evicted record into the archive's total, its origin group and its
 * configuration group.
 *
 * @param {object} archive
 * @param {object} record
 * @returns {object} The same archive.
 */
export function addRecordToUsageArchive(archive, record) {
    if (!archive || typeof archive !== 'object' || !record || typeof record !== 'object') return archive;
    addRecordToUsageAccumulator(archive.total, record);

    const origin = normalizeUsageOrigin(record.origin);
    if (!archive.byOrigin[origin]) archive.byOrigin[origin] = createUsageAccumulator();
    addRecordToUsageAccumulator(archive.byOrigin[origin], record);

    const configuration = configurationLabel(record.configuration);
    const key = configuration ?? 'default';
    if (!archive.byConfiguration[key]) {
        archive.byConfiguration[key] = { configuration, accumulator: createUsageAccumulator() };
    }
    addRecordToUsageAccumulator(archive.byConfiguration[key].accumulator, record);
    return archive;
}

/**
 * Sums two archives counter by counter.
 *
 * @param {object|null} left
 * @param {object|null} right
 * @returns {object}
 */
export function mergeUsageArchives(left, right) {
    const target = normalizeUsageArchive(left);
    const source = normalizeUsageArchive(right);
    target.total = mergeUsageAccumulators(target.total, source.total);
    for (const [origin, counters] of Object.entries(source.byOrigin)) {
        target.byOrigin[origin] = mergeUsageAccumulators(target.byOrigin[origin] ?? null, counters);
    }
    for (const [key, entry] of Object.entries(source.byConfiguration)) {
        if (!target.byConfiguration[key]) {
            target.byConfiguration[key] = {
                configuration: entry.configuration,
                accumulator: createUsageAccumulator(),
            };
        }
        target.byConfiguration[key].accumulator = mergeUsageAccumulators(
            target.byConfiguration[key].accumulator,
            entry.accumulator,
        );
    }
    return target;
}

/**
 * True when an archive holds nothing worth persisting.
 *
 * @param {object|null} archive
 * @returns {boolean}
 */
export function isUsageArchiveEmpty(archive) {
    if (!archive) return true;
    if (!isUsageAccumulatorEmpty(archive.total)) return false;
    for (const counters of Object.values(archive.byOrigin ?? {})) {
        if (!isUsageAccumulatorEmpty(counters)) return false;
    }
    for (const entry of Object.values(archive.byConfiguration ?? {})) {
        if (!isUsageAccumulatorEmpty(entry?.accumulator)) return false;
    }
    return true;
}

/**
 * An origin the counters know. A request nobody identified is internal work,
 * so an unexpected value is counted there rather than inventing a group.
 *
 * @param {unknown} origin
 * @returns {string}
 */
function normalizeUsageOrigin(origin) {
    return KNOWN_ORIGINS.has(origin) ? origin : 'internal';
}

function configurationLabel(value) {
    return typeof value === 'string' && value.trim() ? value : null;
}

function isCompleted(record) {
    return !!record && COMPLETED_STATUSES.has(record.status);
}

function isMeasured(record) {
    return record?.usageSource === 'measured';
}

function isEstimated(record) {
    return record?.usageSource === 'estimated' || isTokenCount(record?.estimatedPromptTokens);
}

function isTokenCount(value) {
    return Number.isFinite(value) && value >= 0;
}
