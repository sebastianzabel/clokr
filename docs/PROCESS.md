# Delivery Process

How work gets from a thought to a release. One maintainer, no standups, nothing to remember.

For everything from "merge" onwards — version bump, tag, promote, deploy — see
[`release-process.md`](release-process.md). That document owns the release; this one owns
everything before it.

## The loop

```
Capture  →  Inbox  →  Triage  →  Ready  →  GSD  →  Ship  →  Release
```

1. **Capture** — `./scripts/capture.sh "…"` or dictate into it. No decisions, no fields.
2. **Inbox** — every new issue lands there automatically. It is a queue, not a backlog.
3. **Triage** — every second Monday, driven by the sprint issue the workflow opens.
4. **Ready** — at most five issues, each with acceptance criteria, iteration and milestone.
5. **GSD** — `/gsd:new-milestone`, then the normal phase flow.
6. **Ship** — PR, CI green, merge.
7. **Release** — merge the release PR. See [`release-process.md`](release-process.md).

## The cap: five issues per sprint

Five, not six. Something urgent arriving means something else leaves — back to Backlog, not
alongside. A sprint that absorbs everything stops saying anything about what will actually
happen, and the board becomes a second inbox.

Chores do not count against the cap. Dependency bumps and doc fixes are not the reason a
sprint fails.

## Status definitions

The board carries these as field descriptions too, so they are visible where they are used.

| Status          | Means                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Inbox**       | Captured, not yet triaged. Everything new starts here.                                                            |
| **Backlog**     | Triaged, Work Type set. Wanted in principle, not scheduled.                                                       |
| **Ready**       | Acceptance criteria complete, Work Type + Iteration + Milestone set. **GSD does not touch an issue before this.** |
| **In Progress** | A GSD phase is running. A branch exists.                                                                          |
| **In Review**   | PR open, CI running or review pending.                                                                            |
| **Done**        | Merged or closed. Auto-archived after 30 days.                                                                    |

**Ready is the only status with teeth.** Everything else describes where something is; Ready
asserts that it is answerable. An issue whose acceptance criteria say "make it better" is not
Ready, however long it has been sitting in Backlog.

For bugs, reproduction steps plus expected behaviour _are_ the acceptance criteria — that is
why `bug.yml` has no separate field. A bug you cannot reproduce is not Ready either.

## Mapping to GSD

| GitHub    | GSD                                              |
| --------- | ------------------------------------------------ |
| Milestone | Milestone (`.planning/PROJECT.md`, `ROADMAP.md`) |
| Issue     | Phase                                            |
| —         | Plan (`NN-MM-PLAN.md`) — lives only in GSD       |

An issue is a **phase**, not a plan. Phase 104 ran to thirteen plans; five plans would be an
afternoon, five phases are a fortnight, and the cap only means something at phase
granularity.

The issue's acceptance criteria are the input to `/gsd:discuss-phase`. They are the contract;
the plans are how it gets met.

Note that `.planning/` is gitignored — the planning artifacts are local. The issue is the
public half, the phase is the private half, and the commit scope (`fix(104-11): …`) is what
ties them together in the history.

## One-time manual steps

Projects v2 built-in automations cannot be set through the API. These four have to be clicked
once, and the board does not work as described until they are.

Open the board → **⋯** (top right) → **Settings** → **Workflows** in the left sidebar.

**1 · Auto-add to project**

- Click **Auto-add to project** → **Edit**
- Filter: `is:issue is:open repo:sebastianzabel/clokr`
- Set the item's **Status** to **Inbox**
- **Save and turn on workflow**

> Without this, capture.sh files issues that never reach the board.

**2 · Item closed → Done**

- Click **Item closed** → **Edit**
- Under _Set value_, choose **Status: Done**
- **Save and turn on workflow**

**3 · Pull request merged → Done**

- Click **Pull request merged** → **Edit**
- Under _Set value_, choose **Status: Done**
- **Save and turn on workflow**

**4 · Auto-archive items**

- Click **Auto-archive items** → **Edit**
- Filter: `is:closed updated:<@today-30d`
- **Save and turn on workflow**

### Also manual: view grouping and sorting

Filters were set through the API; grouping and sorting cannot be. On each view, click the
**⌄** next to its name:

| View         | Set                              |
| ------------ | -------------------------------- |
| **Sprint**   | Group by → **Status**            |
| **Backlog**  | Sort by → **Created**, ascending |
| **Releases** | Group by → **Milestone**         |

## Dictation on macOS

`capture.sh` reads the clipboard when given no argument, which is the whole integration:

1. System Settings → Keyboard → Dictation → on, and note the shortcut (double-tap Control by
   default).
2. Dictate into any text field, select, copy.
3. Run `./scripts/capture.sh` with no arguments.

Worth a shell alias, since the point is that capturing costs nothing:

```bash
alias cap='~/git/clokr/scripts/capture.sh'
```

Use `--dry-run` to see the shaped issue without creating it.

## What runs on its own

| What                          | When                                                | Where                                          |
| ----------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| Sprint checklist issue        | every second Monday, 07:00 Berlin (06:00 in winter) | `.github/workflows/sprint-rollover.yml`        |
| Branch protection drift check | manual, on the sprint checklist                     | `scripts/apply-branch-protection.sh`           |
| Release PR                    | on every push to `main`                             | see [`release-process.md`](release-process.md) |

Scheduled workflows and issue forms only ever run from the **default branch**. Both are inert
anywhere else — this is why `main` was resynced onto the release line rather than left behind.
