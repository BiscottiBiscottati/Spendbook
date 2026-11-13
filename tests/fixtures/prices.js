/**
 * One price table for every test that needs dollars. The provider and model are
 * fictional on purpose: this repo ships no real provider's rates.
 *
 * $0.003 per million cache-hit tokens, $0.15 per million cache-miss tokens,
 * $0.60 per million output tokens — the table `ACME_PRICED_ROW` is worked out
 * against below.
 */

export const ACME_PRICES = Object.freeze({
    currency: 'USD',
    updated: '2026-11-13',
    entries: Object.freeze([
        Object.freeze({ provider: 'acme', model: 'm1', hit: 0.003, miss: 0.15, output: 0.6, cacheWrite: null }),
    ]),
});

/**
 * The token shape those rates price: 400 cache-hit tokens, 800 uncached prompt
 * tokens and 340 output tokens. That is 400 * 0.003 + 800 * 0.15 + 340 * 0.6 =
 * 325.2 micro-dollars of cost and 400 * (0.15 - 0.003) = 58.8 micro-dollars of
 * cache saving.
 */
export const ACME_PRICED_ROW = Object.freeze({
    provider: 'acme',
    model: 'm1',
    promptTokens: 1200,
    hitTokens: 400,
    completionTokens: 340,
});
