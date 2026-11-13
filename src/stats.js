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
    'completionTokenRequests',
    'reasoningTokens',
    'totalTokens',
    'totalTokenRequests',
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
    if (isNonNegativeNumber(record.completionTokens)) {
        accumulator.completionTokens += record.completionTokens;
        accumulator.completionTokenRequests += 1;
    }
    if (isNonNegativeNumber(record.reasoningTokens)) accumulator.reasoningTokens += record.reasoningTokens;
    if (isNonNegativeNumber(record.totalTokens)) {
        accumulator.totalTokens += record.totalTokens;
        accumulator.totalTokenRequests += 1;
    }
    return accumulator;
}

/**
 * The cache-hit rate of a set of requests: cached prompt tokens over the
 * provider-reported prompt tokens of the requests that reported both counts.
 *
 * Token-weighted on purpose. The mean of per-request percentages would let one
 * small turn outvote a large one, so the percentage would not match what was
 * billed. A row missing either count is left out of both the numerator and the
 * denominator rather than counted as a miss.
 *
 * @param {object|null} counters
 * @returns {number|null} 0..1, or null when no request carried both counts
 */
export function hitRateFor(counters) {
    const counts = normalizeUsageAccumulator(counters);
    if (counts.ratedPromptTokens <= 0) return null;
    return counts.hitTokens / counts.ratedPromptTokens;
}

/**
 * The share of prompt tokens the provider actually reported.
 *
 * An estimate is prompt the provider did not describe, so it counts as
 * uncovered. Failed and aborted requests are already outside the completed
 * counters, so they never enter a denominator. A completed request that
 * reported no prompt size at all caps the figure at the share of requests that
 * did report one: the missing prompt has a size, it is just unknown, so the
 * data cannot claim full coverage.
 *
 * @param {object|null} counters
 * @returns {number|null} 0..1, or null when nothing has a prompt size yet
 */
export function coverageFor(counters) {
    const counts = normalizeUsageAccumulator(counters);
    const knownPromptTokens = counts.promptTokens + counts.estimatedPromptTokens;
    if (knownPromptTokens <= 0) return null;

    const tokenShare = counts.promptTokens / knownPromptTokens;
    const requestShare = counts.unavailableRequests > 0 && counts.requests > 0
        ? counts.coveredRequests / counts.requests
        : 1;
    return Math.min(1, tokenShare, requestShare);
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
 * token counts per provider, model and origin — and the dollars a provider
 * reported, which no price table can reproduce.
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
        // The same rule as a record's origin: an unknown key is background work
        // rather than a new group, so the groups stay one fixed vocabulary and a
        // persisted key cannot invent an origin.
        const known = normalizeUsageOrigin(origin);
        archive.byOrigin[known] = archive.byOrigin[known]
            ? mergeUsageAccumulators(archive.byOrigin[known], counters)
            : normalizeUsageAccumulator(counters);
    }
    for (const [key, entry] of Object.entries(value.byConfiguration ?? {})) {
        if (!entry || typeof entry !== 'object') continue;
        archive.byConfiguration[key] = {
            configuration: typeof entry.configuration === 'string' ? entry.configuration : null,
            accumulator: normalizeUsageAccumulator(entry.accumulator),
        };
    }
    for (const entry of Object.values(value.byModel ?? {})) {
        if (!entry || typeof entry !== 'object') continue;
        // The key is rebuilt from the fields the bucket carries, so a persisted
        // key that disagrees with them cannot hide a group, and two entries
        // that describe one group are merged rather than one overwriting the
        // other.
        modelBucketSlot(archive.byModel, normalizeModelBucket(entry));
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
    for (const bucket of Object.values(source.byModel)) {
        modelBucketSlot(target.byModel, bucket);
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
 * every dollar figure resolved against the given price table — overall and per
 * origin, so a card above the table describes the same requests the table below
 * it shows, including the rows the retention cap folded. Dollars stay split by
 * source — a provider-reported amount and a table-derived one are not the same
 * unit and are never added together here.
 *
 * @param {object} [options]
 * @param {object[]} [options.records] Retained records for one chat.
 * @param {{total?: object, byOrigin?: object, byModel?: object}|null} [options.archive] Counters of the folded rows.
 * @param {import('./prices.js').UsagePriceTable|null} [options.prices] Table in force now
 * @returns {{
 *   counters: object,
 *   cost: {measured: number, measuredRequests: number, estimated: number, estimatedRequests: number, requests: number},
 *   saving: {measured: number, measuredRequests: number, estimated: number, estimatedRequests: number, requests: number},
 *   byOrigin: Object<string, {counters: object, cost: object, saving: object}>,
 * }}
 */
export function sumUsageRecords({ records = [], archive = null, prices = null } = {}) {
    const overall = createSummaryTotals();
    const byOrigin = new Map();

    for (const record of Array.isArray(records) ? records : []) {
        const origin = normalizeUsageOrigin(record?.origin);
        addRecordToSummaries([overall, summaryFor(byOrigin, origin)], record, prices);
    }

    const folded = normalizeUsageArchive(archive);
    overall.counters = mergeUsageAccumulators(overall.counters, folded.total);
    for (const [origin, counters] of Object.entries(folded.byOrigin)) {
        const summary = summaryFor(byOrigin, origin);
        summary.counters = mergeUsageAccumulators(summary.counters, counters);
    }
    for (const bucket of Object.values(folded.byModel)) {
        const targets = [overall];
        // A group folded before the archive recorded origins has no origin to
        // name, so its dollars stay in the overall total rather than being
        // attributed to a guess.
        if (bucket.origin) targets.push(summaryFor(byOrigin, bucket.origin));
        addFoldedDollars(bucket, prices, targets);
    }

    return {
        counters: overall.counters,
        cost: finishDollarTotals(overall.cost),
        saving: finishDollarTotals(overall.saving),
        byOrigin: Object.fromEntries([...byOrigin].map(([origin, summary]) => [origin, {
            counters: summary.counters,
            cost: finishDollarTotals(summary.cost),
            saving: finishDollarTotals(summary.saving),
        }])),
    };
}

/**
 * One group's running totals: the counters, and the two dollar figures kept
 * apart by source.
 *
 * @returns {{counters: object, cost: object, saving: object}}
 */
function createSummaryTotals() {
    return { counters: createUsageAccumulator(), cost: createDollarTotals(), saving: createDollarTotals() };
}

/**
 * One origin's summary, created on first use so a group that only appears in
 * the archive or only in the rows is priced like any other.
 *
 * @param {Map<string, object>} byOrigin
 * @param {string} origin
 * @returns {object}
 */
function summaryFor(byOrigin, origin) {
    if (!byOrigin.has(origin)) byOrigin.set(origin, createSummaryTotals());
    return byOrigin.get(origin);
}

/**
 * Folds one record into every group it belongs to — the overall total and its
 * origin — resolving its dollars once.
 *
 * @param {object[]} targets
 * @param {object} record
 * @param {import('./prices.js').UsagePriceTable|null} prices
 */
function addRecordToSummaries(targets, record, prices) {
    for (const target of targets) addRecordToUsageAccumulator(target.counters, record);
    if (!isCompletedUsageRecord(record)) return;

    const resolved = resolveUsageCost(record, prices);
    for (const target of targets) {
        addDollarFigure(target.cost, resolved.cost, resolved.costSource);
        addDollarFigure(target.saving, resolved.saving, resolved.savingSource);
    }
}

/**
 * Adds one folded model group's dollars to every group it belongs to: the
 * amounts the provider reported, plus the table's price for the rows that
 * reported nothing.
 *
 * @param {object} bucket
 * @param {import('./prices.js').UsagePriceTable|null} prices
 * @param {object[]} targets
 */
function addFoldedDollars(bucket, prices, targets) {
    for (const target of targets) {
        if (bucket.reportedCostRequests > 0) {
            target.cost.measured += bucket.reportedCost;
            target.cost.measuredRequests += bucket.reportedCostRequests;
        }
        if (bucket.reportedSavingRequests > 0) {
            target.saving.measured += bucket.reportedSaving;
            target.saving.measuredRequests += bucket.reportedSavingRequests;
        }
    }
    if (!prices) return;

    // Only rows the estimator can use are folded, and only a group with rows in
    // it is priced: a counter that never arrived must not read as a zero.
    if (bucket.unpricedCost.requests > 0) {
        const priced = resolveUsageCost(asPriceInputs(bucket, bucket.unpricedCost), prices);
        if (priced.cost != null) {
            for (const target of targets) {
                target.cost.estimated += priced.cost;
                target.cost.estimatedRequests += bucket.unpricedCost.requests;
            }
        }
    }
    if (bucket.unpricedSaving.requests > 0) {
        const discounted = resolveUsageCost(asPriceInputs(bucket, bucket.unpricedSaving), prices);
        if (discounted.saving != null) {
            for (const target of targets) {
                target.saving.estimated += discounted.saving;
                target.saving.estimatedRequests += bucket.unpricedSaving.requests;
            }
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
    const origin = normalizeUsageOrigin(record.origin);
    const key = modelBucketKey(provider, model, origin);
    if (!archive.byModel) archive.byModel = {};
    if (!archive.byModel[key]) archive.byModel[key] = createModelBucket(provider, model, origin);
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
 * The key of one provider-and-model group, split per origin as well: a folded
 * row's dollars have to land on the card of the work that sent it.
 *
 * @param {string} provider
 * @param {string} model
 * @param {string|null} origin
 * @returns {string}
 */
function modelBucketKey(provider, model, origin) {
    return origin ? `${provider}\u0000${model}\u0000${origin}` : `${provider}\u0000${model}`;
}

/**
 * @param {string} provider
 * @param {string} model
 * @param {string|null} [origin]
 * @returns {object}
 */
function createModelBucket(provider, model, origin = null) {
    return {
        provider,
        model,
        origin,
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
        // An archive written before origins were recorded has none: null keeps
        // those dollars in the overall total instead of guessing a card.
        KNOWN_ORIGINS.has(entry.origin) ? entry.origin : null,
    );
    bucket.unpricedCost = normalizeUsageAccumulator(entry.unpricedCost);
    bucket.unpricedSaving = normalizeUsageAccumulator(entry.unpricedSaving);
    bucket.reportedCost = isNonNegativeNumber(entry.reportedCost) ? entry.reportedCost : 0;
    bucket.reportedCostRequests = isNonNegativeNumber(entry.reportedCostRequests) ? entry.reportedCostRequests : 0;
    bucket.reportedSaving = isNonNegativeNumber(entry.reportedSaving) ? entry.reportedSaving : 0;
    bucket.reportedSavingRequests = isNonNegativeNumber(entry.reportedSavingRequests) ? entry.reportedSavingRequests : 0;
    return bucket;
}

/**
 * Puts a model group into a map, merging it with a group that already
 * describes the same provider, model and origin. The key is rebuilt from the
 * group's own fields so a persisted key can never disagree with it.
 *
 * @param {object} byModel
 * @param {object} bucket
 * @returns {object} The same map.
 */
function modelBucketSlot(byModel, bucket) {
    const key = modelBucketKey(bucket.provider, bucket.model, bucket.origin);
    byModel[key] = byModel[key] ? mergeModelBuckets(byModel[key], bucket) : bucket;
    return byModel;
}

/**
 * Adds one model group to another, for a merge or for two persisted entries
 * that turned out to describe one group.
 *
 * @param {object} target
 * @param {object} source
 * @returns {object} The target.
 */
function mergeModelBuckets(target, source) {
    target.unpricedCost = mergeUsageAccumulators(target.unpricedCost, source.unpricedCost);
    target.unpricedSaving = mergeUsageAccumulators(target.unpricedSaving, source.unpricedSaving);
    target.reportedCost += source.reportedCost;
    target.reportedCostRequests += source.reportedCostRequests;
    target.reportedSaving += source.reportedSaving;
    target.reportedSavingRequests += source.reportedSavingRequests;
    return target;
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
