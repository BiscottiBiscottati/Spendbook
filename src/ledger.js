/**
 * Spendbook ledger.
 *
 * The only owner of persisted usage state. This ticket keeps the per-chat
 * record list: records are written into SillyTavern's `chat_metadata` under
 * Spendbook's own namespace and read back when the chat is opened. Retention,
 * the all-time aggregate and the delete/rename lifecycle arrive with their own
 * ticket; nothing here reaches beyond the namespace it owns.
 */

export const USAGE_CHAT_METADATA_KEY = 'spendbook_usage';

const NAMESPACE_VERSION = 1;

export class UsageLedger {
    /** @type {Map<string|null, {chatId: string|null, ownerChatId: string|null, records: object[], revision: number}>} */
    #byChat = new Map();

    #getChatId;
    #getMetadata;
    #saveMetadata;

    /**
     * @param {object} [options]
     * @param {() => (string|null)} [options.getChatId] Chat currently open in
     *   SillyTavern, used to decide whether a namespace can be written.
     * @param {() => (object|null)} [options.getMetadata] Live `chat_metadata`
     *   object. Without it the ledger stays in memory only.
     * @param {(() => (Promise|void))|null} [options.saveMetadata] Persists the
     *   live chat metadata after a record is written into it.
     */
    constructor({
        getChatId = () => null,
        getMetadata = () => null,
        saveMetadata = null,
    } = {}) {
        this.#getChatId = getChatId;
        this.#getMetadata = getMetadata;
        this.#saveMetadata = saveMetadata;
    }

    /**
     * Appends one record to the chat it was sent from. When that chat is open,
     * the namespace is written through to the live metadata immediately, so any
     * SillyTavern chat save carries it, and the metadata save is requested.
     *
     * @param {object} record
     */
    add(record) {
        if (!record || typeof record !== 'object') return;
        const chatId = record.chatId ?? null;
        const state = this.#ensureState(chatId);
        state.records.push(record);
        state.revision += 1;

        if (this.#isActiveChat(chatId) && this.#getMetadata()) {
            state.ownerChatId = chatId;
            this.#writeNamespace(state);
            this.#requestSave();
        }
    }

    /**
     * Newest-first records for one chat.
     *
     * @param {string|null} chatId
     * @returns {object[]}
     */
    recordsFor(chatId) {
        return [...(this.#byChat.get(chatId ?? null)?.records ?? [])].reverse();
    }

    /**
     * Loads one chat's persisted namespace. A namespace owned by a different
     * chat is a copy (a branch or a manual copy) and is not adopted; that
     * lifecycle is completed where chats are deleted and renamed.
     *
     * @param {string|null} chatId
     */
    loadChat(chatId) {
        const state = this.#ensureState(chatId);
        const metadata = this.#isActiveChat(chatId) ? this.#getMetadata() : null;
        const raw = metadata?.[USAGE_CHAT_METADATA_KEY];
        const persisted = normalizeNamespace(raw);
        if (!persisted || persisted.ownerChatId !== chatId) {
            if (raw != null && metadata) delete metadata[USAGE_CHAT_METADATA_KEY];
            return;
        }
        if (state.revision > 0 && state.revision >= persisted.revision) return;

        state.records = persisted.records.map(record => ({ ...record }));
        state.revision = persisted.revision;
        state.ownerChatId = chatId;
    }

    /**
     * Handles SillyTavern's chat switch by adopting the new chat's namespace.
     *
     * @param {string|null} chatId
     */
    handleChatChanged(chatId) {
        this.loadChat(chatId);
    }

    #ensureState(chatId) {
        const key = chatId ?? null;
        if (!this.#byChat.has(key)) {
            this.#byChat.set(key, { chatId: key, ownerChatId: null, records: [], revision: 0 });
        }
        return this.#byChat.get(key);
    }

    #isActiveChat(chatId) {
        return chatId != null && this.#getChatId() === chatId;
    }

    #writeNamespace(state) {
        const metadata = this.#getMetadata();
        if (!metadata) return;
        metadata[USAGE_CHAT_METADATA_KEY] = {
            version: NAMESPACE_VERSION,
            ownerChatId: state.chatId,
            revision: state.revision,
            records: [...state.records],
        };
    }

    #requestSave() {
        if (typeof this.#saveMetadata !== 'function') return;
        try {
            const pending = this.#saveMetadata();
            if (pending && typeof pending.catch === 'function') {
                pending.catch((error) => console.error('Spendbook: failed to save chat metadata.', error));
            }
        } catch (error) {
            console.error('Spendbook: failed to save chat metadata.', error);
        }
    }
}

function normalizeNamespace(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!Array.isArray(raw.records)) return null;
    return {
        ownerChatId: typeof raw.ownerChatId === 'string' ? raw.ownerChatId : null,
        revision: Number.isFinite(raw.revision) ? raw.revision : 0,
        records: raw.records.filter(record => record && typeof record === 'object'),
    };
}
