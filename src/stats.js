/**
 * Spendbook usage counters.
 *
 * Pure maths for the rows the retention cap removes from a chat: a row that is
 * evicted is folded into raw counters instead of dropped, so the chat's totals
 * keep counting. The same accumulator shape carries the all-time bucket of each
 * chat in local storage.
 *
 * Counters are price-independent on purpose. A folded row is gone, so what it
 * would cost has to be recoverable: its token counts are kept per provider and
 * model, next to the dollars the provider itself reported, and every dollar
 * figure is resolved against the price table the user has when the drawer is
 * painted. Editing or deleting a price therefore reprices folded rows and
 * visible rows alike, and no figure is frozen in a currency the table has since
 * changed.
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
    'cacheWriteTokens',
    'completionTokens',
    'reasoningTokens',
    'totalTokens',
]);

import { USAGE_ORIGINS } from './origin.js';
import { resolveUsageCost } from './prices.js';

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
    if (!isCompletedUsageRecord(record)) {
        accumulator.excludedRequests += 1;
        return accumulator;
    }

    accumulator.requests += 1;
    if (isMeasured(record)) {
        accumulator.measuredRequests += 1;
        if (isNonNegativeNumber(record.promptTokens)) {
            accumulator.promptTokens += record.promptTokens;
            accumulator.coveredRequests += 1;
        }
    } else if (isEstimated(record)) {
        accumulator.estimatedRequests += 1;
        if (isNonNegativeNumber(record.estimatedPromptTokens)) {
            accumulator.estimatedPromptTokens += record.estimatedPromptTokens;
            accumulator.estimatedPromptRequests += 1;
        }
    } else {
        accumulator.unavailableRequests += 1;
    }

    // The hit-rate pair is only comparable when the provider reported both
    // counts, so a request without them never dilutes the rate.
    if (isNonNegativeNumber(record.promptTokens) && isNonNegativeNumber(record.hitTokens)) {
        accumulator.ratedRequests += 1;
        accumulator.ratedPromptTokens += record.promptTokens;
        accumulator.hitTokens += record.hitTokens;
    }
    // Output and cache-write counts are summed as reported; a row without one
    // adds nothing. Cache writes are kept because the price table bills them at
    // their own rate, and a folded row must price like a visible one.
    if (isNonNegativeNumber(record.cacheWriteTokens)) accumulator.cacheWriteTokens += record.cacheWriteTokens;
    if (isNonNegativeNumber(record.completionTokens)) accumulator.completionTokens += record.completionTokens;
    if (isNonNegativeNumber(record.reasoningTokens)) accumulator.reasoningTokens += record.reasoningTokens;
    if (isNonNegativeNumber(record.totalTokens)) accumulator.totalTokens += record.totalTokens;
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
 * The per-chat archive of the rows the retention cap has evicted: token
 * counters overall, per origin and per configuration label; the price inputs —
 * token counts per provider and model — and the dollars a provider reported,
 * which no price table can reproduce.
 *
 * @returns {{total: object, byOrigin: object, byConfiguration: object, byModel: object}}
 */
export function createUsageArchive() {
    return { total: createUsageAccumulator(), byOrigin: {}, byConfiguration: {}, byModel: {} };
}

/**
 * Coerces a persisted archive into the shape the totals expect.
 *
 * @param {object|null} value
 * @returns {{total: object, byOrigin: object, byConfiguration: object, byModel: object}}
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
    for (const [key, entry] of Object.entries(value.byModel ?? {})) {
        if (!entry || typeof entry !== 'object') continue;
        archive.byModel[key] = normalizeModelBucket(entry);
    }
    return archive;
}

/**
 * Folds one evicted record into the archive: its token counters into the
 * overall, origin and configuration groups, and its price inputs into its
 * provider-and-model group so the dollars can still be resolved later.
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

    if (!isCompletedUsageRecord(record)) return archive;
    addRecordToModelBucket(archive, record);
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
            target.byConfiguration[key] = { configuration: entry.configuration, accumulator: createUsageAccumulator() };
        }
        target.byConfiguration[key].accumulator = mergeUsageAccumulators(
            target.byConfiguration[key].accumulator,
            entry.accumulator,
        );
    }
    for (const [key, bucket] of Object.entries(source.byModel)) {
        const merged = target.byModel[key] ?? createModelBucket(bucket.provider, bucket.model);
        merged.unpricedCost = mergeUsageAccumulators(merged.unpricedCost, bucket.unpricedCost);
        merged.unpricedSaving = mergeUsageAccumulators(merged.unpricedSaving, bucket.unpricedSaving);
        merged.reportedCost += bucket.reportedCost;
        merged.reportedCostRequests += bucket.reportedCostRequests;
        merged.reportedSaving += bucket.reportedSaving;
        merged.reportedSavingRequests += bucket.reportedSavingRequests;
        target.byModel[key] = merged;
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
    for (const bucket of Object.values(archive.byModel ?? {})) {
        if (bucket?.reportedCostRequests || bucket?.reportedSavingRequests) return false;
        if (!isUsageAccumulatorEmpty(bucket?.unpricedCost)) return false;
        if (!isUsageAccumulatorEmpty(bucket?.unpricedSaving)) return false;
    }
    return true;
}

/**
 * The whole picture for one chat: visible rows plus the folded counters, with
 * every dollar figure resolved against the given price table. Dollars stay
 * split by source — a provider-reported amount and a table-derived one are not
 * the same unit and are never added together here.
 *
 * @param {object} [options]
 * @param {object[]} [options.records] Retained records for one chat.
 * @param {{total?: object, byModel?: object}|null} [options.archive] Counters of the folded rows.
 * @param {import('./prices.js').UsagePriceTable|null} [options.prices] Table in force now
 * @returns {{
 *   counters: object,
 *   cost: {measured: number, measuredRequests: number, estimated: number, estimatedRequests: number, requests: number},
 *   saving: {measured: number, measuredRequests: number, estimated: number, estimatedRequests: number, requests: number},
 * }}
 */
export function sumUsageRecords({ records = [], archive = null, prices = null } = {}) {
    const counters = createUsageAccumulator();
    const cost = createDollarTotals();
    const saving = createDollarTotals();

    for (const record of Array.isArray(records) ? records : []) {
        addRecordToUsageAccumulator(counters, record);
        if (!isCompletedUsageRecord(record)) continue;
        const resolved = resolveUsageCost(record, prices);
        addDollarFigure(cost, resolved.cost, resolved.costSource);
        addDollarFigure(saving, resolved.saving, resolved.savingSource);
    }

    const folded = normalizeUsageArchive(archive);
    for (const bucket of Object.values(folded.byModel)) {
        addFoldedDollars(bucket, prices, cost, saving);
    }

    return {
        counters: mergeUsageAccumulators(counters, folded.total),
        cost: finishDollarTotals(cost),
        saving: finishDollarTotals(saving),
    };
}

/**
 * Adds one folded model group's dollars: the amounts the provider reported, plus
 * the table's price for the rows that reported nothing.
 *
 * @param {object} bucket
 * @param {import('./prices.js').UsagePriceTable|null} prices
 * @param {object} cost
 * @param {object} saving
 */
function addFoldedDollars(bucket, prices, cost, saving) {
    if (bucket.reportedCostRequests > 0) {
        cost.measured += bucket.reportedCost;
        cost.measuredRequests += bucket.reportedCostRequests;
    }
    if (bucket.reportedSavingRequests > 0) {
        saving.measured += bucket.reportedSaving;
        saving.measuredRequests += bucket.reportedSavingRequests;
    }
    if (!prices) return;

    // Only rows the estimator can use are folded, and only a group with rows in
    // it is priced: a counter that never arrived must not read as a zero.
    if (bucket.unpricedCost.requests > 0) {
        const unpriced = resolveUsageCost(asPriceInputs(bucket, bucket.unpricedCost), prices);
        if (unpriced.cost != null) {
            cost.estimated += unpriced.cost;
            cost.estimatedRequests += bucket.unpricedCost.requests;
        }
    }
    if (bucket.unpricedSaving.requests > 0) {
        const unpriced = resolveUsageCost(asPriceInputs(bucket, bucket.unpricedSaving), prices);
        if (unpriced.saving != null) {
            saving.estimated += unpriced.saving;
            saving.estimatedRequests += bucket.unpricedSaving.requests;
        }
    }
}

/**
 * The price inputs of one folded group: the token counts the estimator reads,
 * with the group's provider and model so it resolves against the right row.
 *
 * @param {object} bucket
 * @param {object} counters
 * @returns {object}
 */
function asPriceInputs(bucket, counters) {
    return {
        provider: bucket.provider,
        model: bucket.model,
        promptTokens: counters.promptTokens,
        hitTokens: counters.hitTokens,
        cacheWriteTokens: counters.cacheWriteTokens,
        completionTokens: counters.completionTokens,
    };
}

/**
 * Puts one completed record into its provider-and-model group: tokens of the
 * rows the table must price, and the amounts the provider reported itself.
 *
 * @param {object} archive
 * @param {object} record
 */
function addRecordToModelBucket(archive, record) {
    const provider = modelKeyPart(record.provider) || 'unknown';
    const model = modelKeyPart(record.model) || 'unknown';
    const key = `${provider}\u0000${model}`;
    if (!archive.byModel) archive.byModel = {};
    if (!archive.byModel[key]) archive.byModel[key] = createModelBucket(provider, model);
    const bucket = archive.byModel[key];

    // A row without a reported figure is the one the table has to price — but
    // only a row the estimator can price is folded. A row with no prompt count
    // (or no cache count to save from) stays out: on screen it shows no dollar
    // figure, and folding its zeros would invent one.
    const resolved = resolveUsageCost(record, null);
    if (resolved.costSource === 'measured') {
        bucket.reportedCost += resolved.cost;
        bucket.reportedCostRequests += 1;
    } else if (isNonNegativeNumber(record.promptTokens)) {
        addRecordToUsageAccumulator(bucket.unpricedCost, record);
    }
    if (resolved.savingSource === 'measured') {
        bucket.reportedSaving += resolved.saving;
        bucket.reportedSavingRequests += 1;
    } else if (isNonNegativeNumber(record.hitTokens)) {
        addRecordToUsageAccumulator(bucket.unpricedSaving, record);
    }
}

/**
 * @param {string} provider
 * @param {string} model
 * @returns {object}
 */
function createModelBucket(provider, model) {
    return {
        provider,
        model,
        unpricedCost: createUsageAccumulator(),
        unpricedSaving: createUsageAccumulator(),
        reportedCost: 0,
        reportedCostRequests: 0,
        reportedSaving: 0,
        reportedSavingRequests: 0,
    };
}

/**
 * @param {object} entry
 * @returns {object}
 */
function normalizeModelBucket(entry) {
    const bucket = createModelBucket(
        modelKeyPart(entry.provider) || 'unknown',
        modelKeyPart(entry.model) || 'unknown',
    );
    bucket.unpricedCost = normalizeUsageAccumulator(entry.unpricedCost);
    bucket.unpricedSaving = normalizeUsageAccumulator(entry.unpricedSaving);
    bucket.reportedCost = isNonNegativeNumber(entry.reportedCost) ? entry.reportedCost : 0;
    bucket.reportedCostRequests = isNonNegativeNumber(entry.reportedCostRequests) ? entry.reportedCostRequests : 0;
    bucket.reportedSaving = isNonNegativeNumber(entry.reportedSaving) ? entry.reportedSaving : 0;
    bucket.reportedSavingRequests = isNonNegativeNumber(entry.reportedSavingRequests) ? entry.reportedSavingRequests : 0;
    return bucket;
}

function createDollarTotals() {
    return { measured: 0, measuredRequests: 0, estimated: 0, estimatedRequests: 0 };
}

function addDollarFigure(totals, value, source) {
    if (!Number.isFinite(value) || source === 'unavailable') return;
    if (source === 'measured') {
        totals.measured += value;
        totals.measuredRequests += 1;
    } else {
        totals.estimated += value;
        totals.estimatedRequests += 1;
    }
}

function finishDollarTotals(totals) {
    return { ...totals, requests: totals.measuredRequests + totals.estimatedRequests };
}

function modelKeyPart(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
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

/**
 * True for a record that completed. Failed and aborted rows are counted apart
 * from the totals and can never carry dollars, so both the aggregates and the
 * drawer read the same rule.
 *
 * @param {object} record
 * @returns {boolean}
 */
export function isCompletedUsageRecord(record) {
    return !!record && COMPLETED_STATUSES.has(record.status);
}

function isMeasured(record) {
    return record?.usageSource === 'measured';
}

function isEstimated(record) {
    return record?.usageSource === 'estimated' || isNonNegativeNumber(record?.estimatedPromptTokens);
}

function isNonNegativeNumber(value) {
    return Number.isFinite(value) && value >= 0;
}
