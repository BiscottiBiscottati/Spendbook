# Triage Labels

The engineering skills speak in terms of five canonical triage roles. This
repository uses the same five strings, so a skill's role name is the label to
apply.

| Label in the skills | Label in this tracker | Meaning                                  |
| ------------------- | --------------------- | ---------------------------------------- |
| `needs-triage`      | `needs-triage`        | Maintainer needs to evaluate this issue  |
| `needs-info`        | `needs-info`          | Waiting on the reporter for information  |
| `ready-for-agent`   | `ready-for-agent`     | Fully specified, ready to implement      |
| `ready-for-human`   | `ready-for-human`     | Requires human implementation            |
| `wontfix`           | `wontfix`             | Will not be actioned                     |

When a skill mentions a role (for example "apply the AFK-ready triage label"),
use the corresponding label string from the table. There is one label per issue,
recorded as the `Status:` line near the top of its file — see
`issue-tracker.md`. `done` is the terminal state and is not a triage label: it
records that the ticket was implemented, and the evidence belongs under its
`## Comments`.

## Scope of each role

- **`needs-triage`** — filed but not yet judged. Anyone may add a `## Comments`
  note; nobody implements from it.
- **`needs-info`** — blocked on a fact only the reporter has: which provider,
  which handler, what the row showed. Say what is missing in one line.
- **`ready-for-agent`** — the acceptance bullets are testable without asking
  anything, and the invariant it touches is named. A ticket that changes a
  persisted shape or the export field list is only ready when the migration or
  compatibility answer is written into it.
- **`ready-for-human`** — needs a judgement the repo cannot supply: a provider
  account, a compatibility call, a release decision.
- **`wontfix`** — with the reason in one line, so the same request is not filed
  twice.
