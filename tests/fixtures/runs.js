/**
 * Two measurement runs of one chat, as the ledger hands them to the view: the
 * newest one is current. Shared by the view and drawer seams so a change to the
 * run bar cannot pass in one place and fail in the other.
 */
export const CHAT_RUNS = {
    runs: [
        { runId: 'run-2', label: 'after', startedAt: 1_700_000_100_000 },
        { runId: 'run-1', label: 'before', startedAt: 1_700_000_000_000 },
    ],
    currentRunId: 'run-2',
};
