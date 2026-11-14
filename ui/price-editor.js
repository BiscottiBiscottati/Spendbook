/**
 * Spendbook price editor.
 *
 * The drawer's editable price table: one row per provider and model with the
 * per-million hit, miss, output and cache-write rates. It owns the table while
 * the drawer is mounted, so a change to one field repaints only the computed
 * results — never the field the user is typing in. Rows are rebuilt only when
 * the user adds or removes one.
 */

import {
    PRICE_FIELDS,
    PRICE_TEXT_FIELDS,
    createBlankPriceEntry,
    normalizePriceTable,
    parsePriceInput,
} from '../src/prices.js';

const FIELD_LABELS = Object.freeze({
    provider: 'Provider',
    model: 'Model',
    hit: 'Cache-hit price per million tokens',
    miss: 'Cache-miss price per million tokens',
    output: 'Output price per million tokens',
    cacheWrite: 'Cache-write price per million tokens',
});

/**
 * Mount the editor into its section of the drawer template.
 *
 * @param {object} options
 * @param {HTMLElement} options.section The `.spendbook-prices` section
 * @param {import('../src/prices.js').UsagePriceTable} options.prices Stored table, normalized on mount
 * @param {(prices: import('../src/prices.js').UsagePriceTable) => void} [options.onChange] Called with the edited table after every edit
 * @returns {{prices: import('../src/prices.js').UsagePriceTable, setPrices: (prices: import('../src/prices.js').UsagePriceTable) => void}} The live table, read by the results painter, and the way a stored table that changed underneath the drawer replaces it
 */
export function mountPriceEditor({ section, prices, onChange = () => {} }) {
    const rows = section?.querySelector('.spendbook-price-rows');
    const currencyInput = section?.querySelector('.spendbook-price-currency');
    const updatedInput = section?.querySelector('.spendbook-price-updated');
    const addButton = section?.querySelector('.spendbook-price-add');
    if (!rows || !currencyInput || !updatedInput || !addButton) {
        throw new Error('Spendbook: the settings template has no price table.');
    }

    let table = normalizePriceTable(prices);

    const renderRows = () => {
        rows.replaceChildren(...table.entries.map(renderRow));
    };

    currencyInput.value = table.currency;
    updatedInput.value = table.updated;
    renderRows();

    section.addEventListener('change', (event) => {
        const target = event.target;
        if (target === currencyInput) {
            table.currency = target.value;
            onChange(table);
            return;
        }
        if (target === updatedInput) {
            table.updated = target.value;
            onChange(table);
            return;
        }

        const index = Number(target?.dataset?.priceIndex);
        const field = target?.dataset?.priceField;
        const entry = table.entries[index];
        if (!entry || !field) return;

        entry[field] = PRICE_TEXT_FIELDS.includes(field) ? target.value : parsePriceInput(target.value);
        // A number field the parser could not read is cleared, so the drawer
        // never shows a rate while the maths holds none.
        if (PRICE_FIELDS.includes(field)) target.value = fieldValue(entry, field);
        // Normalize what was just typed before painting: a blank currency or a
        // stray space must not reach the formatters or the stored shape.
        table = normalizePriceTable(table);
        onChange(table);
    });

    section.addEventListener('click', (event) => {
        if (event.target?.closest?.('.spendbook-price-add')) {
            table.entries.push(createBlankPriceEntry());
            onChange(table);
            renderRows();
            // The new row is the only thing worth typing in next.
            rows.querySelectorAll('tr').item(table.entries.length - 1)
                ?.querySelector('input')
                ?.focus();
            return;
        }

        const removeButton = event.target?.closest?.('.spendbook-price-remove');
        if (!removeButton) return;
        const index = Number(removeButton.dataset.priceIndex);
        if (!Number.isInteger(index)) return;
        table.entries.splice(index, 1);
        onChange(table);
        renderRows();
    });

    return {
        // A getter, so the results painter always reads the table as it is now.
        get prices() {
            return table;
        },

        /**
         * Replace the whole table, as an import does. The rows are rebuilt
         * because every field of every row may have changed.
         *
         * @param {import('../src/prices.js').UsagePriceTable} prices
         */
        setPrices(prices) {
            table = normalizePriceTable(prices);
            currencyInput.value = table.currency;
            updatedInput.value = table.updated;
            renderRows();
        },
    };
}

function renderRow(entry, index) {
    const tr = document.createElement('tr');
    for (const field of [...PRICE_TEXT_FIELDS, ...PRICE_FIELDS]) {
        const cell = document.createElement('td');
        const isText = PRICE_TEXT_FIELDS.includes(field);
        const input = document.createElement('input');
        input.className = 'text_pole';
        input.type = isText ? 'text' : 'number';
        if (!isText) {
            input.min = '0';
            input.step = 'any';
        }
        input.dataset.priceIndex = String(index);
        input.dataset.priceField = field;
        input.setAttribute('aria-label', `${FIELD_LABELS[field]} (row ${index + 1})`);
        input.value = fieldValue(entry, field);
        cell.append(input);
        tr.append(cell);
    }

    const removeCell = document.createElement('td');
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'menu_button spendbook-price-remove';
    removeButton.dataset.priceIndex = String(index);
    removeButton.setAttribute('aria-label', `Remove price row ${index + 1}`);
    removeButton.textContent = 'Remove';
    removeCell.append(removeButton);
    tr.append(removeCell);
    return tr;
}

function fieldValue(entry, field) {
    const value = entry?.[field];
    if (PRICE_TEXT_FIELDS.includes(field)) return typeof value === 'string' ? value : '';
    return Number.isFinite(value) ? String(value) : '';
}
