/**
 * Spendbook ledger.
 *
 * The only owner of persisted usage state:
 *
 * - the per-chat namespace in SillyTavern's `chat_metadata`, written through on
 *   every record and saved through ST's metadata save after a debounce;
 * - a short-lived pending copy of unsaved records in local storage, replayed
 *   when a chat is opened so a switch inside the debounce cannot lose them, and
 *   flushed on page hide;
 * - the all-time aggregate, one bucket per chat, kept in local storage.
 *
 * Records are capped at the newest 500 per chat. An evicted row is folded into
 * counters (overall, per origin and per configuration label) rather than
 * dropped, so the chat's totals keep counting while the chat file stays small.
 *
 * Lifecycle: deleting a chat removes its state, pending copy and bucket;
 * renaming moves them; a namespace whose owner id is not the open chat is a copy
 * (a branch or a manual copy) and is discarded, so the chat starts clean.
 */

import {
    addRecordToUsageAccumulator,
    addRecordToUsageArchive,
    createUsageAccumulator,
    createUsageArchive,
    isUsageAccumulatorEmpty,
    mergeUsageAccumulators,
    mergeUsageArchives,
    normalizeUsageAccumulator,
    normalizeUsageArchive,
    subtractUsageAccumulators,
} from './stats.js';

export const USAGE_CHAT_METADATA_KEY = 'spendbook_usage';
export const USAGE_ALL_TIME_STORAGE_KEY = 'spendbook_usage_alltime';
export const USAGE_PENDING_STORAGE_KEY = 'spendbook_usage_pending';
export const USAGE_RECORD_LIMIT = 500;

const NAMESPACE_VERSION = 1;
const ALL_TIME_VERSION = 1;
const PENDING_VERSION = 1;

export class UsageLedger {
    /** @type {Map<string|null, object>} */
    #byChat = new Map();
    #allTime = createAllTime();
    #pendingBackup = createPendingBackup();
    #pendingChatIds = new Set();
    #pendingTimer = null;

    #getChatId;
    #getMetadata;
    #saveMetadata;
    #storage;
    #sanitizeChatFileName;
    #now;
    #debounceMs;

    /**
     * @param {object} [options]
     * @param {() => (string|null)} [options.getChatId] Chat currently open in
     *   SillyTavern, used to decide whether a namespace can be written.
     * @param {() => (object|null)} [options.getMetadata] Live `chat_metadata`
     *   object. Without it the ledger stays in memory only.
     * @param {(() => (Promise|void))|null} [options.saveMetadata] Persists the
     *   live chat metadata. Called after the debounce and by {@link flush}.
     * @param {object|null} [options.storage] localStorage-like backend for the
     *   all-time aggregate and the pending-record copy.
     * @param {((name: string) => (string|Promise<string>))|null} [options.sanitizeChatFileName]
     *   Resolves SillyTavern's server-side file-name sanitization, used to key
     *   a renamed chat that is not open by the name the server actually created.
     * @param {() => number} [options.now] Clock, injected for tests.
     * @param {number} [options.debounceMs] Delay before a pending save runs.
     */
    constructor({
        getChatId = () => null,
        getMetadata = () => null,
        saveMetadata = null,
        storage = null,
        sanitizeChatFileName = null,
        now = () => Date.now(),
        debounceMs = 1000,
    } = {}) {
        this.#getChatId = getChatId;
        this.#getMetadata = getMetadata;
        this.#saveMetadata = saveMetadata;
        this.#storage = storage;
        this.#sanitizeChatFileName = sanitizeChatFileName;
        this.#now = now;
        this.#debounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : 1000;
        this.#allTime = readAllTime(storage);
        this.#pendingBackup = readPendingBackup(storage);
    }

    /**
     * Appends one record to the chat it was sent from. The namespace is written
     * through to the live metadata immediately (so any SillyTavern chat save
     * carries it), the pending copy is staged for replay, and the explicit
     * metadata save is debounced.
     *
     * @param {object} record
     */
    add(record) {
        if (!record || typeof record !== 'object') return;
        const chatId = record.chatId ?? null;
        const state = this.#ensureState(chatId);

        state.records.push(record);
        state.revision += 1;
        this.#evictOverflow(state);
        this.#addToAllTime(record);
        // The all-time total is written with the record rather than after the
        // save debounce: a tab killed before the flush would otherwise replay
        // the row from the pending copy without ever counting it.
        this.#persistAllTime();

        if (this.#isActiveChat(chatId) && this.#getMetadata()) {
            state.ownerChatId = chatId;
            this.#writeNamespace(state);
        }
        this.#stagePendingBackup(chatId, state);
        this.#scheduleSave(chatId);
    }

    /**
     * Newest-first records for one chat.
     *
     * @param {string|null} chatId
     * @returns {object[]}
     */
    recordsFor(chatId) {
        return [...(this.#byChat.get(chatKey(chatId))?.records ?? [])].reverse();
    }

    /**
     * Archived counters for the rows the cap has evicted from one chat.
     *
     * @param {string|null} chatId
     * @returns {{total: object, byOrigin: object, byConfiguration: object}}
     */
    archivedFor(chatId) {
        return normalizeUsageArchive(this.#byChat.get(chatKey(chatId))?.archived);
    }

    /**
     * How many rows the table can show and how many the counters include.
     *
     * @param {string|null} chatId
     * @returns {{limit: number, retained: number, total: number}}
     */
    retentionFor(chatId) {
        const state = this.#byChat.get(chatKey(chatId));
        const retained = state?.records.length ?? 0;
        const archived = normalizeUsageArchive(state?.archived);
        const evicted = archived.total.requests + archived.total.excludedRequests;
        return { limit: USAGE_RECORD_LIMIT, retained, total: retained + evicted };
    }

    /**
     * The all-time aggregate across chats, plus how many chat buckets it holds.
     *
     * @returns {{totals: object, chats: number}}
     */
    allTimeForView() {
        return {
            totals: normalizeUsageAccumulator(this.#allTime.totals),
            chats: Object.keys(this.#allTime.chats).length,
        };
    }

    /**
     * Loads (or re-adopts) one chat's namespace. A pending copy left by a save
     * that never ran is replayed when it is newer than the persisted namespace,
     * so a switch inside the debounce does not lose the records; a pending copy
     * the namespace has caught up with is dropped.
     *
     * A namespace whose owner is a different chat is normally a copy — a branch
     * or a manual file copy — so it is removed and the chat starts clean. The
     * exception is a chat renamed while it was not open this session: its file
     * still names the old id, and the recorded old→new alias proves the rows
     * belong here rather than to a copy.
     *
     * @param {string|null} chatId
     */
    loadChat(chatId) {
        const key = chatKey(chatId);
        const metadata = this.#isActiveChat(chatId) ? this.#getMetadata() : null;
        const raw = metadata ? metadata[USAGE_CHAT_METADATA_KEY] : null;
        const persisted = normalizeNamespace(raw);
        const pendingKey = chatKey(chatId);
        const pending = pendingKey ? normalizeNamespace(this.#pendingBackup.chats[pendingKey]) : null;
        const persistedOwned = !!persisted && persisted.ownerChatId === chatId;
        const pendingAuthoritative = !!pending && (!persistedOwned || pending.revision > persisted.revision);
        const renamedFrom = !!persisted && !persistedOwned
            && renamedAncestorIds(chatId, this.#pendingBackup.renames).has(persisted.ownerChatId);
        // Reading the namespace back at an equal-or-newer revision is the only
        // reliable proof that the chat file actually saved it.
        if (persistedOwned && pending && persisted.revision >= pending.revision) {
            delete this.#pendingBackup.chats[pendingKey];
            this.#persistPendingBackup();
        }
        if (persistedOwned) this.#forgetRenames(chatId);

        const existing = this.#byChat.get(key);
        let adoptedOutside = false;
        if (pendingAuthoritative && pending.revision >= (existing?.revision ?? 0)) {
            this.#byChat.set(key, { ...stateFromNamespace(pending), ownerChatId: chatId });
            adoptedOutside = true;
        } else if (renamedFrom) {
            const adopted = { ...stateFromNamespace(persisted), ownerChatId: chatId };
            if (existing) this.#mergeMovedState(existing, adopted);
            else this.#byChat.set(key, adopted);
            adoptedOutside = true;
        } else if (persistedOwned && (!existing || persisted.revision > existing.revision)) {
            this.#byChat.set(key, { ...stateFromNamespace(persisted), ownerChatId: chatId });
        } else if (persistedOwned && existing.revision > persisted.revision
            && this.#isActiveChat(chatId) && metadata) {
            // A record that landed for this chat while another one was open is
            // newer than the file, so write it through on the first open.
            this.#writeNamespace(existing);
            this.#scheduleSave(chatId);
        } else if (!persistedOwned) {
            // Copied namespace: it belongs to another chat, so this chat must
            // not inherit it. The deletion persists with the next ST chat save.
            if (raw != null && metadata) delete metadata[USAGE_CHAT_METADATA_KEY];
            if (!existing) this.#byChat.set(key, createChatState(chatId));
        }

        if (adoptedOutside && this.#isActiveChat(chatId) && metadata) {
            // The file is behind the state just adopted, so write it back now
            // and let the debounced save finish the job.
            this.#writeNamespace(this.#byChat.get(key));
            this.#scheduleSave(chatId);
        }
    }

    /**
     * Handles SillyTavern's chat switch. Flushes a pending save first, then
     * adopts the new chat's namespace.
     *
     * @param {string|null} chatId
     */
    handleChatChanged(chatId) {
        this.flush();
        this.loadChat(chatId);
    }

    /**
     * Writes any pending save now. A namespace is only written when the chat it
     * belongs to is still open; the all-time aggregate and any record copy are
     * always flushed because they span chats.
     */
    flush() {
        this.#persistPending();
    }

    /**
     * Removes a deleted chat's in-memory state, pending copy, all-time bucket
     * and queued save, so a queued write cannot resurrect the chat.
     *
     * @param {string|null} chatId
     */
    handleChatDeleted(chatId) {
        this.#forgetChat(chatId);

        const metadata = this.#getMetadata();
        if (metadata && this.#isActiveChat(chatId)) {
            delete metadata[USAGE_CHAT_METADATA_KEY];
        }
    }

    /**
     * Moves a renamed chat's records, folded counters, pending copy and all-time
     * bucket to the new id. The all-time total itself does not change.
     *
     * SillyTavern reports file names with a `.jsonl` suffix while chat ids have
     * no extension, so the suffix is stripped here. The event carries the
     * requested name, but the server sanitizes it; for the chat that is open the
     * reloaded id is authoritative, and for any other chat the server is asked
     * how it sanitized the name.
     *
     * @param {string} oldChatId
     * @param {string} newChatId
     * @param {object} [options]
     * @param {string|null} [options.previousChatId] Chat id open before the
     *   rename reload.
     * @param {string|null} [options.currentChatId] Chat id after the rename
     *   reload (the server-sanitized name for the open chat).
     * @returns {Promise<void>}
     */
    async handleChatRenamed(oldChatId, newChatId, { previousChatId = null, currentChatId = null } = {}) {
        const oldId = stripChatFileExtension(oldChatId);
        if (!oldId) return;
        const eventId = stripChatFileExtension(newChatId);
        const previousId = stripChatFileExtension(previousChatId);
        const activeId = stripChatFileExtension(currentChatId);
        // The open chat is the one whose id the rename reload already opened, so
        // the event's requested name must sanitize to that id. Checking the
        // server's answer keeps a rename of the chat we switched away from from
        // being mistaken for a rename of the open one.
        const sanitized = await this.#sanitizeFileName(eventId);
        const openChatRenamed = !!activeId && activeId !== oldId
            && (sanitized ? sanitized === activeId : previousId === oldId);
        const newId = openChatRenamed ? activeId : (sanitized ?? eventId);
        if (!newId || newId === oldId) return;

        const oldKey = chatKey(oldId);
        const newKey = chatKey(newId);
        const previous = this.#byChat.get(oldKey);
        const hadState = !!previous;
        if (previous) {
            previous.ownerChatId = newId;
            this.#byChat.delete(oldKey);
            const current = this.#byChat.get(newKey);
            if (current && current !== previous) this.#mergeMovedState(current, previous);
            else this.#byChat.set(newKey, previous);
        }

        const pendingCopy = this.#pendingBackup.chats[oldKey];
        let movedPending = null;
        if (pendingCopy) {
            movedPending = this.#mergePendingSnapshots(pendingCopy, this.#pendingBackup.chats[newKey]);
            this.#pendingBackup.chats[newKey] = movedPending;
            delete this.#pendingBackup.chats[oldKey];
            this.#persistPendingBackup();
        }

        if (!hadState && !pendingCopy) {
            // The rows live only in the renamed file, and that file still names
            // the old id. Remember the old→new pair so its next open adopts the
            // rows instead of discarding them as a branch copy.
            this.#rememberRename(oldId, newId);
        }

        const bucket = this.#allTime.chats[oldKey];
        if (bucket) {
            this.#allTime.chats[newKey] = mergeUsageAccumulators(this.#allTime.chats[newKey] ?? null, bucket);
            delete this.#allTime.chats[oldKey];
            this.#persistAllTime();
        }

        let state = this.#byChat.get(newKey);
        const adoptedPending = movedPending ? normalizeNamespace(movedPending) : null;
        if (adoptedPending && adoptedPending.revision >= (state?.revision ?? 0)) {
            state = { ...stateFromNamespace(adoptedPending), ownerChatId: newId };
            this.#byChat.set(newKey, state);
        }
        if (!state) return;
        // A non-open renamed chat cannot be written through: its renamed file
        // still owns the old id and would be discarded as a copy on open, so the
        // pending copy carries the moved rows until that open replays it.
        this.#stagePendingBackup(newId, state);
        if (!this.#isActiveChat(newId) || !this.#getMetadata()) return;
        this.#writeNamespace(state);
        // The open chat was reloaded under its new id before this event, so its
        // namespace must be saved now rather than after the debounce.
        this.#saveMetadataNow();
    }

    /**
     * Clears one chat's records, folded counters, pending copy, namespace and
     * all-time contribution. Other chats are untouched.
     *
     * The namespace is removed from the live metadata and saved now. A failed
     * save can leave the old namespace in the chat file, and ST's save resolves
     * even when the underlying write failed, so an empty revisioned snapshot is
     * left in the pending copy: the next open adopts it instead of the stale
     * rows.
     *
     * @param {string|null} chatId
     */
    resetChat(chatId) {
        const key = chatKey(chatId);
        const metadata = this.#getMetadata();
        const persisted = metadata && this.#isActiveChat(chatId)
            ? normalizeNamespace(metadata[USAGE_CHAT_METADATA_KEY])
            : null;
        const pending = normalizeNamespace(this.#pendingBackup.chats[chatKey(chatId)]);
        // A reset followed by another reset must not drop below the tombstone
        // revision it already staged: a second save failure would otherwise let
        // the stale rows back in on the next open.
        const previousRevision = Math.max(
            this.#byChat.get(key)?.revision ?? 0,
            persisted?.revision ?? 0,
            pending?.revision ?? 0,
        );

        this.#forgetChat(chatId);

        if (metadata && this.#isActiveChat(chatId) && metadata[USAGE_CHAT_METADATA_KEY]) {
            delete metadata[USAGE_CHAT_METADATA_KEY];
            this.#saveMetadataNow();
        }
        this.#stageResetTombstone(chatId, previousRevision);
    }

    /**
     * Clears the cross-chat all-time totals and chat buckets. Per-chat records
     * and namespaces are the other reset scope, so they are left untouched; new
     * requests start new buckets. The pending-record copies belong to the
     * per-chat scope and are kept.
     */
    resetAllTime() {
        this.#allTime = createAllTime();
        this.#persistAllTime();
    }

    #ensureState(chatId) {
        const key = chatKey(chatId);
        if (!this.#byChat.has(key)) this.loadChat(chatId);
        return this.#byChat.get(key) ?? createChatState(chatId);
    }

    /**
     * Removes a chat's in-memory state, pending copy, queued save and all-time
     * bucket. The metadata namespace is the caller's concern, because delete
     * and reset persist it differently.
     *
     * @param {string|null} chatId
     */
    #forgetChat(chatId) {
        const key = chatKey(chatId);
        this.#pendingChatIds.delete(key);
        this.#byChat.delete(key);
        this.#deletePendingBackup(chatId);
        this.#forgetRenames(chatId);

        const bucketKey = chatKey(chatId);
        if (!bucketKey || !this.#allTime.chats[bucketKey]) return;
        this.#allTime.totals = subtractUsageAccumulators(this.#allTime.totals, this.#allTime.chats[bucketKey]);
        delete this.#allTime.chats[bucketKey];
        this.#persistAllTime();
    }

    /**
     * Leaves an empty revisioned snapshot in the pending copy so a metadata save
     * that fails cannot let the next open restore the reset rows.
     *
     * @param {string|null} chatId
     * @param {number} previousRevision
     */
    #stageResetTombstone(chatId, previousRevision) {
        if (!this.#storage || typeof this.#saveMetadata !== 'function') return;
        // Nothing persisted means nothing can be resurrected.
        if (!(previousRevision > 0)) return;
        const key = chatKey(chatId);
        if (!key) return;
        const state = createChatState(chatId);
        state.revision = previousRevision + 1;
        this.#pendingBackup.chats[key] = serializeState(state);
        this.#persistPendingBackup();
    }

    #evictOverflow(state) {
        while (state.records.length > USAGE_RECORD_LIMIT) {
            addRecordToUsageArchive(state.archived, state.records.shift());
        }
    }

    #addToAllTime(record) {
        addRecordToUsageAccumulator(this.#allTime.totals, record);
        const bucketKey = chatKey(record.chatId ?? null);
        if (!bucketKey) return;
        if (!this.#allTime.chats[bucketKey]) this.#allTime.chats[bucketKey] = createUsageAccumulator();
        addRecordToUsageAccumulator(this.#allTime.chats[bucketKey], record);
    }

    #writeNamespace(state) {
        const metadata = this.#getMetadata();
        if (!metadata) return;
        metadata[USAGE_CHAT_METADATA_KEY] = serializeState(state);
    }

    #scheduleSave(chatId) {
        if (typeof this.#saveMetadata !== 'function' && !this.#storage) return;
        this.#pendingChatIds.add(chatKey(chatId));
        this.#clearPendingTimer();
        this.#pendingTimer = setTimeout(() => {
            this.#pendingTimer = null;
            this.#persistPending();
        }, this.#debounceMs);
    }

    #persistPending() {
        this.#clearPendingTimer();
        const pendingIds = [...this.#pendingChatIds];
        this.#pendingChatIds.clear();
        if (this.#storage) this.#persistAllTime();
        if (pendingIds.length === 0) return;

        const chatId = this.#getChatId() ?? null;
        if (!chatId || !pendingIds.includes(chatKey(chatId))) return;
        const state = this.#byChat.get(chatKey(chatId));
        if (!state || !this.#getMetadata()) return;
        this.#writeNamespace(state);
        this.#saveMetadataNow();
    }

    #saveMetadataNow() {
        if (typeof this.#saveMetadata !== 'function') return;
        try {
            // ST's saveMetadata resolves even when the underlying save timed out
            // or failed, so a resolved promise is not proof the chat file has
            // the namespace. The pending copy is cleared only when a later load
            // reads back a namespace at least as new.
            const result = this.#saveMetadata();
            if (result && typeof result.catch === 'function') {
                result.catch((error) => console.error('Spendbook: failed to save chat metadata.', error));
            }
        } catch (error) {
            console.error('Spendbook: failed to save chat metadata.', error);
        }
    }

    async #sanitizeFileName(name) {
        const sanitize = this.#sanitizeChatFileName;
        if (typeof sanitize !== 'function' || !name) return null;
        try {
            const value = await sanitize(name);
            return stripChatFileExtension(value) || null;
        } catch {
            return null;
        }
    }

    #mergePendingSnapshots(left, right) {
        if (!left) return right;
        if (!right) return left;
        const base = (right.revision ?? 0) > (left.revision ?? 0) ? right : left;
        const other = base === left ? right : left;
        const state = stateFromNamespace(base);
        this.#mergeRecordsInto(state, other.records);
        state.archived = mergeUsageArchives(state.archived, other.archived);
        state.revision = Math.max(left.revision ?? 0, right.revision ?? 0);
        return serializeState(state);
    }

    #mergeMovedState(target, source) {
        this.#mergeRecordsInto(target, source.records);
        target.archived = mergeUsageArchives(target.archived, source.archived);
        target.ownerChatId = source.ownerChatId;
        target.revision = Math.max(target.revision, source.revision);
    }

    #rememberRename(oldId, newId) {
        if (!this.#storage) return;
        this.#pendingBackup.renames[oldId] = newId;
        this.#persistPendingBackup();
    }

    /**
     * Drops the rename aliases that led to one chat: once the chat's own file
     * names it, or once the chat is gone, the alias has nothing left to prove.
     *
     * @param {string|null} chatId
     */
    #forgetRenames(chatId) {
        const stale = renamedAncestorIds(chatId, this.#pendingBackup.renames);
        if (stale.size === 0) return;
        for (const ancestor of stale) delete this.#pendingBackup.renames[ancestor];
        this.#persistPendingBackup();
    }

    #mergeRecordsInto(state, records) {
        let changed = false;
        const knownIds = new Set(state.records.map(recordKey).filter(Boolean));
        for (const entry of records ?? []) {
            const key = recordKey(entry);
            if (key && knownIds.has(key)) continue;
            if (key) knownIds.add(key);
            state.records.push(entry);
            changed = true;
        }
        if (changed) this.#evictOverflow(state);
        return changed;
    }

    #stagePendingBackup(chatId, state) {
        if (!this.#storage || typeof this.#saveMetadata !== 'function') return;
        const key = chatKey(chatId);
        if (!key) return;
        this.#pendingBackup.chats[key] = serializeState({ ...state, ownerChatId: chatId });
        this.#persistPendingBackup();
    }

    #deletePendingBackup(chatId) {
        const key = chatKey(chatId);
        if (!key || !this.#pendingBackup.chats[key]) return;
        delete this.#pendingBackup.chats[key];
        this.#persistPendingBackup();
    }

    #persistAllTime() {
        if (!this.#storage) return;
        try {
            this.#storage.setItem(USAGE_ALL_TIME_STORAGE_KEY, JSON.stringify({
                version: ALL_TIME_VERSION,
                updatedAt: this.#now(),
                totals: normalizeUsageAccumulator(this.#allTime.totals),
                chats: Object.fromEntries(Object.entries(this.#allTime.chats).map(([chatId, counters]) => [
                    chatId,
                    normalizeUsageAccumulator(counters),
                ])),
            }));
        } catch {
            /* a full or disabled storage must not break the ledger */
        }
    }

    #persistPendingBackup() {
        if (!this.#storage) return;
        try {
            this.#storage.setItem(USAGE_PENDING_STORAGE_KEY, JSON.stringify({
                version: PENDING_VERSION,
                chats: this.#pendingBackup.chats,
                renames: this.#pendingBackup.renames,
            }));
        } catch {
            /* a full or disabled storage must not break capture */
        }
    }

    #clearPendingTimer() {
        if (this.#pendingTimer) {
            clearTimeout(this.#pendingTimer);
            this.#pendingTimer = null;
        }
    }

    #isActiveChat(chatId) {
        return chatId != null && this.#getChatId() === chatId;
    }
}

function createAllTime() {
    return { totals: createUsageAccumulator(), chats: {} };
}

function createChatState(chatId) {
    return {
        ownerChatId: chatId ?? null,
        records: [],
        archived: createUsageArchive(),
        revision: 0,
    };
}

function stateFromNamespace(namespace) {
    return {
        ownerChatId: typeof namespace?.ownerChatId === 'string' ? namespace.ownerChatId : null,
        records: Array.isArray(namespace?.records) ? [...namespace.records] : [],
        archived: normalizeUsageArchive(namespace?.archived),
        revision: Number.isFinite(namespace?.revision) ? namespace.revision : 0,
    };
}

function serializeState(state) {
    return {
        version: NAMESPACE_VERSION,
        ownerChatId: state.ownerChatId ?? null,
        revision: state.revision ?? 0,
        records: [...state.records],
        archived: normalizeUsageArchive(state.archived),
    };
}

function normalizeNamespace(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!Array.isArray(raw.records)) return null;
    return {
        ownerChatId: typeof raw.ownerChatId === 'string' ? raw.ownerChatId : null,
        revision: Number.isFinite(raw.revision) ? raw.revision : 0,
        records: raw.records.filter((entry) => entry && typeof entry === 'object'),
        archived: normalizeUsageArchive(raw.archived),
    };
}

function readAllTime(storage) {
    const empty = createAllTime();
    if (!storage) return empty;
    try {
        const parsed = JSON.parse(storage.getItem(USAGE_ALL_TIME_STORAGE_KEY) ?? 'null');
        if (!parsed || typeof parsed !== 'object' || parsed.version !== ALL_TIME_VERSION) return empty;
        const allTime = createAllTime();
        allTime.totals = normalizeUsageAccumulator(parsed.totals);
        for (const [chatId, counters] of Object.entries(parsed.chats ?? {})) {
            const normalized = normalizeUsageAccumulator(counters);
            if (!isUsageAccumulatorEmpty(normalized)) allTime.chats[chatId] = normalized;
        }
        return allTime;
    } catch {
        return empty;
    }
}

function createPendingBackup() {
    return { chats: {}, renames: {} };
}

function readPendingBackup(storage) {
    const empty = createPendingBackup();
    if (!storage) return empty;
    try {
        const parsed = JSON.parse(storage.getItem(USAGE_PENDING_STORAGE_KEY) ?? 'null');
        if (!parsed || typeof parsed !== 'object' || parsed.version !== PENDING_VERSION) return empty;
        const backup = createPendingBackup();
        for (const [chatId, entry] of Object.entries(parsed.chats ?? {})) {
            const namespace = normalizeNamespace(entry);
            if (!namespace) continue;
            // An empty snapshot with a revision is a reset tombstone: keep it so
            // a stale chat file cannot restore the cleared rows.
            if (namespace.records.length === 0 && namespace.revision === 0) continue;
            backup.chats[chatId] = { ...namespace, ownerChatId: namespace.ownerChatId ?? chatId };
        }
        for (const [oldId, newId] of Object.entries(parsed.renames ?? {})) {
            if (typeof oldId !== 'string' || !oldId) continue;
            if (typeof newId !== 'string' || !newId || newId === oldId) continue;
            backup.renames[oldId] = newId;
        }
        return backup;
    } catch {
        return empty;
    }
}

/**
 * Every recorded id whose rename chain ends at one chat. A chain covers a chat
 * renamed twice before it was opened, whose file then still names the first id.
 *
 * @param {string|null} chatId
 * @param {Record<string, string>} renames
 * @returns {Set<string>}
 */
function renamedAncestorIds(chatId, renames) {
    const ancestors = new Set();
    if (!chatId) return ancestors;
    for (const [oldId, newId] of Object.entries(renames ?? {})) {
        let current = newId;
        const visited = new Set();
        while (current && !visited.has(current)) {
            if (current === chatId) {
                ancestors.add(oldId);
                break;
            }
            visited.add(current);
            current = renames[current] ?? null;
        }
    }
    return ancestors;
}

/**
 * The one derivation of a chat's storage key: an id that can key the memory
 * map, the all-time bucket and the pending copy alike.
 *
 * @param {unknown} chatId
 * @returns {string|null}
 */
function chatKey(chatId) {
    return typeof chatId === 'string' && chatId ? chatId : null;
}

function recordKey(record) {
    return typeof record?.recordId === 'string' && record.recordId ? record.recordId : null;
}

function stripChatFileExtension(name) {
    if (typeof name !== 'string' || !name) return null;
    return name.replace(/\.jsonl$/i, '');
}
