# Issue tracker: Local Markdown

Issues and specs for this repository live as markdown files in `.scratch/`. The
directory is gitignored: it is working material, not part of the published
extension.

## Scope

- `.scratch/` — everything filed against this repository. There is no other
  tracker; a standalone clone has this file and nothing else to read.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- A spec past roughly 300 lines opens with a `Read by role:` block naming the
  sections an implementer reads for one ticket and the ones a reviewer reads;
  without it the whole file gets read for one acceptance bullet
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Before starting an implementation ticket, add `Claimed by: <session/agent> (date)` under the `Status:` line. Parallel sessions then skip it; leave the line as history when the ticket is done.
- Comments and conversation history append to the bottom of the file under a `## Comments` heading
- Evidence a ticket produces (captures, comparison records, screenshots) goes
  beside the spec as `.scratch/<feature-slug>/<ticket>-<what>.ext`, and the ticket
  links it, so the reasoning survives without opening the ticket.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## What may be filed here

Anything about the extension itself: a bug, a behavior question, a design
argument that produced an ADR. Never file the contents of a user's chat, a
provider key, or a real usage export — reproduce the shape, not the data.
