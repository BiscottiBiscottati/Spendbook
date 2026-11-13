/**
 * Spendbook prices.
 *
 * The user's price table and the dollars it resolves. Nothing here seeds a
 * provider rate: an install starts with an empty table, so a cost appears only
 * for a provider and model the user priced themselves. A price the provider
 * reported on the response wins over the table and is never recomputed, and a
 * reported discount is shown as reported — OpenRouter reports credits, so it is
 * never converted into the table's currency.
 *
 * Rates are entered per **million** tokens.
 */

const MILLION = 1_000_000;

/** Every column of a price row, in the order the editor shows them. */
export const PRICE_FIELDS = Object.freeze(['hit', 'miss', 'output', 'cacheWrite']);

/** The columns that hold a name rather than a rate. */
export const PRICE_TEXT_FIELDS = Object.freeze(['provider', 'model']);

/**
 * @typedef {object} UsagePriceEntry
 * @property {string} provider
 * @property {string} model
 * @property {number|null} hit Cache-hit input rate
 * @property {number|null} miss Uncached input rate
 * @property {number|null} output Output rate
 * @property {number|null} cacheWrite Cache-write rate; null bills writes at the miss rate
 */

/**
 * @typedef {object} UsagePriceTable
 * @property {string} currency Currency code the user priced in
 * @property {string} updated Free-form date the user last edited the table
 * @property {UsagePriceEntry[]} entries
 */

/**
 * Coerces a persisted table into the shape the editor and the maths expect. A
 * missing or malformed value yields an empty table; a malformed entry yields a
 * blank editable row rather than dropping what the user typed.
 *
 * @param {unknown} value
 * @returns {UsagePriceTable}
 */
export function normalizePriceTable(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const entries = Array.isArray(source.entries) ? source.entries : [];

    return {
        currency: nonEmptyString(source.currency) ?? 'USD',
        updated: typeof source.updated === 'string' ? source.updated : '',
        entries: entries.map(normalizePriceEntry),
    };
}

/**
 * A price row with nothing filled in, for the editor's add button.
 *
 * @returns {UsagePriceEntry}
 */
export function createBlankPriceEntry() {
    return normalizePriceEntry(null);
}

/**
 * Reads one editor field as a rate. A blank or unusable field means "no price",
 * which the editor shows empty and the maths treats as unknown rather than free.
 *
 * @param {string} value Text the user typed into the field
 * @returns {number|null}
 */
export function parsePriceInput(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    return finiteNonNegative(Number(value));
}

/**
 * Resolves one row's cost and cache saving.
 *
 * A provider-reported cost or cache discount wins and is labelled `measured`.
 * Any other figure comes from the matching table row and is labelled
 * `estimated`: the prompt is billed once — hit tokens at the hit rate, cache
 * writes at the write rate (falling back to miss), the remaining prompt at the
 * miss rate — and output at the output rate. The saving is the hit tokens times
 * the miss-minus-hit difference, so output tokens never count as a saving.
 *
 * A rate is only required for a group the row actually has tokens in, so a row
 * with no cached tokens is priced without the user knowing a hit rate, and an
 * entry without an output rate still yields its saving.
 *
 * A row that reported no cache counts is priced as if nothing was cached, which
 * can overstate its cost; that is why the figure is an estimate, never a
 * measurement.
 *
 * @param {object} record
 * @param {UsagePriceTable|null} prices
 * @returns {{cost: number|null, costSource: string, saving: number|null, savingSource: string}}
 */
export function resolveUsageCost(record, prices = null) {
    // Reported figures are kept exactly as the provider sent them, sign
    // included: recomputing one from the table is what this rule exists to stop.
    const reportedCost = finiteOrNull(record?.cost);
    const reportedSaving = finiteOrNull(record?.cacheDiscount);
    const entry = findPriceEntry(prices, record);
    const estimatedCost = entry ? estimateCost(record, entry) : null;
    const estimatedSaving = entry ? estimateSaving(record, entry) : null;

    const cost = reportedCost ?? estimatedCost;
    const saving = reportedSaving ?? estimatedSaving;

    return {
        cost,
        costSource: sourceFor(reportedCost, cost),
        saving,
        savingSource: sourceFor(reportedSaving, saving),
    };
}

/**
 * The table row for a record's provider and model, matched case-insensitively.
 *
 * @param {UsagePriceTable|null} prices
 * @param {object} record
 * @returns {UsagePriceEntry|null}
 */
function findPriceEntry(prices, record) {
    const entries = Array.isArray(prices?.entries) ? prices.entries : [];
    const provider = normalizeKey(record?.provider);
    const model = normalizeKey(record?.model);
    if (!provider || !model) return null;

    return entries.find((entry) => (
        normalizeKey(entry?.provider) === provider && normalizeKey(entry?.model) === model
    )) ?? null;
}

/**
 * Bills every described token group once. The reported prompt already includes
 * the cache-write tokens, so the uncached remainder is what the miss rate covers.
 *
 * @param {object} record
 * @param {UsagePriceEntry} entry
 * @returns {number|null}
 */
function estimateCost(record, entry) {
    const promptTokens = finiteNonNegative(record?.promptTokens);
    if (promptTokens == null) return null;
    if (entry.miss == null || entry.output == null) return null;

    const hitTokens = finiteNonNegative(record?.hitTokens) ?? 0;
    // A rate is only needed for a group that has tokens in it.
    if (hitTokens > 0 && entry.hit == null) return null;

    const cacheWriteTokens = finiteNonNegative(record?.cacheWriteTokens) ?? 0;
    const completionTokens = finiteNonNegative(record?.completionTokens) ?? 0;
    const cacheWriteRate = entry.cacheWrite ?? entry.miss;

    const uncachedTokens = Math.max(0, promptTokens - hitTokens - cacheWriteTokens);
    const microDollars = hitTokens * (entry.hit ?? 0)
        + cacheWriteTokens * cacheWriteRate
        + uncachedTokens * entry.miss
        + completionTokens * entry.output;
    return microDollars / MILLION;
}

/**
 * What the cache saved: the hit tokens would have cost the miss rate.
 *
 * @param {object} record
 * @param {UsagePriceEntry} entry
 * @returns {number|null}
 */
function estimateSaving(record, entry) {
    const hitTokens = finiteNonNegative(record?.hitTokens);
    if (hitTokens == null || entry.hit == null || entry.miss == null) return null;
    return hitTokens * (entry.miss - entry.hit) / MILLION;
}

/**
 * @param {unknown} entry
 * @returns {UsagePriceEntry}
 */
function normalizePriceEntry(entry) {
    const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
    /** @type {UsagePriceEntry} */
    const normalized = {
        provider: typeof source.provider === 'string' ? source.provider.trim() : '',
        model: typeof source.model === 'string' ? source.model.trim() : '',
        hit: null,
        miss: null,
        output: null,
        cacheWrite: null,
    };
    for (const field of PRICE_FIELDS) normalized[field] = finiteNonNegative(source[field]);
    return normalized;
}

function sourceFor(reported, resolved) {
    if (reported != null) return 'measured';
    return resolved != null ? 'estimated' : 'unavailable';
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function finiteNonNegative(value) {
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeKey(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
