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

## Dependency updates

Dependabot PRs deliberately stay **off the board**. They are pull requests, not tickets, and
thirteen cards would drown an Inbox meant for thinking. They are handled by rule instead:

| Update       | What happens                                                                              |
| ------------ | ----------------------------------------------------------------------------------------- |
| patch, minor | auto-merged once the four required checks pass (`--auto`, so a red build still blocks it) |
| major        | stays open, labelled `major-update`, commented — reviewed at the sprint change            |

For a **grouped** update, the reported type is the highest bump in the group, so a group
containing one major is treated as major. The risk of a group is its riskiest member.

They also do not count against the five-issue cap: dependency bumps are not the reason a sprint
fails, and making them compete with real work is what causes them to be skipped.

> **History worth knowing.** This automation existed before and had never once worked. It tried
> to approve the PR first and died every time on _"GitHub Actions is not permitted to approve
> pull requests"_, so the merge step was never reached and the queue silently grew to thirteen
> PRs over a month old. The approval was never needed — `main` requires zero reviews. It is now
> removed rather than repaired: enabling it would let any workflow in the repo self-approve.
>
> The same audit found `reviewers: ["the operatorZ84"]` in `dependabot.yml` — a user that does
> not exist, so review assignment had been failing silently too.

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

Projects v2 built-in automations can be **read** through the API but not enabled — there is no
`updateProjectV2Workflow` mutation, only `deleteProjectV2Workflow`. So these have to be
switched on by hand once, and the board does not behave as described until they are.

Go straight to the workflows page — it avoids hunting through menus:

**<https://github.com/users/sebastianzabel/projects/1/workflows>**

Open a workflow from the list, give it its condition and its _Set value_, then
**Save and turn on workflow**.

| #   | Workflow                  | Set value                                           | Purpose                                     |
| --- | ------------------------- | --------------------------------------------------- | ------------------------------------------- |
| 7   | **Auto-add to project**   | filter `is:issue is:open repo:sebastianzabel/clokr` | puts new issues on the board                |
| 6   | **Item added to project** | Status → **Inbox**                                  | files them where triage looks               |
| 1   | **Item closed**           | Status → **Done**                                   | closing moves the card                      |
| 2   | **Pull request merged**   | Status → **Done**                                   | only fires for PRs on the board — see below |
| —   | **Auto-archive items**    | filter `is:closed updated:<@today-30d`              | keeps Done from growing forever             |

### A merged PR does not move a card by itself

Auto-add is filtered to `is:issue`, so pull requests never get a card. The **Pull request
merged** workflow sets a field on the _pull request's own_ item — with no PR item, it never
fires. Merging a PR therefore changes nothing on the board on its own. This was observed with
PR #33: merged, board untouched.

The path that actually closes the loop runs through the issue:

```
PR description contains "Closes #34"
  → merging the PR closes issue #34
  → the "Item closed" workflow fires
  → Status = Done
```

**So every PR that finishes a ticket must name it with a closing keyword** (`Closes #NN`,
`Fixes #NN`). Without that the issue stays open in `In Review` forever and the board slowly
fills with work that is actually shipped. This is the one manual habit the process depends
on — everything else is automated.

**Auto-add and "Item added to project" are two different workflows, and you need both.**
Auto-add only puts the item on the board — it does not set a field. With auto-add on and
"Item added to project" off, issues arrive with **no Status at all**: on the board, but
invisible in every status-filtered view. That is worse than not being added, because nothing
looks broken. Observed on issue #34, the first issue captured through this flow.

> `ProjectV2.workflows` only lists a workflow once it has been configured — "Auto-add to
> project" was absent from the API response until it was first set up. An empty-looking API
> result is therefore not evidence that a workflow does not exist.

The Inbox view is filtered defensively for the same reason: rather than `status:Inbox` it
excludes the five later statuses, so an item arriving without a Status still shows up instead
of vanishing. If a sixth status is ever added, add it to that exclusion list.

### The four views

| View         | Filter                            | Shows                                                    |
| ------------ | --------------------------------- | -------------------------------------------------------- |
| **Inbox**    | five later statuses excluded      | untriaged, incl. anything that arrived without a Status  |
| **Sprint**   | `iteration:@current,no:iteration` | the running sprint **plus** everything not yet scheduled |
| **Backlog**  | `status:Backlog`                  | triaged, not scheduled                                   |
| **Releases** | `-status:Done`                    | open work by milestone                                   |

Sprint deliberately includes unscheduled items. Filtered strictly to `iteration:@current`, its
Inbox and Backlog columns would be empty by construction — an Inbox item has no iteration —
leaving two dead columns and forcing triage onto a second surface. Widening it makes Sprint the
single working board: cards arrive in Inbox and are dragged to Ready. The five-issue cap is a
rule applied at triage, not something the filter enforces.

Note that until the first iteration begins (31.08.2026) there is no `@current` iteration at
all, so the sprint half of that filter matches nothing.

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
