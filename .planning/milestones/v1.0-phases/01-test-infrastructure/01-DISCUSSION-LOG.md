# Phase 1: Test Infrastructure - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-30
**Phase:** 01-test-infrastructure
**Areas discussed:** Test-DB-Isolation

---

## Gray Areas Presented

| Area               | Selected |
| ------------------ | -------- |
| Test-DB-Isolation  | ✓        |
| Coverage-Schwellen |          |
| Lint-Strategie     |          |
| Docker Seed Fix    |          |

## Test-DB-Isolation

| Option                      | Description                                             | Selected |
| --------------------------- | ------------------------------------------------------- | -------- |
| Eigener PG-Container        | Zweiter PostgreSQL-Container in docker-compose.test.yml |          |
| Gleiches PG, anderes Schema | Selber PostgreSQL, eigenes Schema                       | ✓        |
| You decide                  | Claude wählt den besten Ansatz                          |          |

**User's choice:** Gleiche DB mit anderem Schema. Für Prod wird auf k3s Cluster via GitHub Actions deployed.

| Option               | Description                                      | Selected |
| -------------------- | ------------------------------------------------ | -------- |
| Truncate per Suite   | Alle Tabellen leeren + neu seeden                |          |
| Transaction Rollback | Jeder Test in Transaction, Rollback am Ende      |          |
| You decide           | Claude wählt basierend auf Prisma-Kompatibilität | ✓        |

**User's choice:** Claude's discretion — best approach for Prisma 7 compatibility.

## Claude's Discretion

- Coverage threshold numbers (after baseline)
- Additional ESLint rules
- Playwright storageState implementation
- Test cleanup approach (truncate vs rollback)

## Deferred Ideas

None
