---
type: quick-fix
quick_id: 260331-piv
scope: api
subsystem: http-layer
tags: [fastify, content-type, delete, external-api, regression-test]
dependency_graph:
  requires: []
  provides: [graceful-empty-body-json-delete]
  affects: [all-delete-routes]
tech_stack:
  added: []
  patterns: [custom-fastify-content-type-parser]
key_files:
  created: []
  modified:
    - apps/api/src/app.ts
    - apps/api/src/__tests__/employees.test.ts
decisions:
  - App-level parser (not per-route) — fixes all 11 DELETE routes in one place
  - Parse-as-string then manually JSON.parse — required by Fastify's content type parser API
metrics:
  duration: ~15 minutes
  completed_date: "2026-03-31"
  tasks_completed: 1
  files_changed: 2
---

# Quick Fix 260331-piv: Fix Content-Type: application/json on DELETE Requests

**One-liner:** App-level Fastify content-type parser that returns undefined for empty-body JSON requests instead of throwing HTTP 400.

## Summary

External API clients (MCP tools, Postman, curl, programmatic clients) commonly send `Content-Type: application/json` on ALL requests — including DELETE requests that have no body. Fastify's default JSON parser rejected these with HTTP 400 "Body cannot be empty when content-type is set to 'application/json'".

This affected all 11 DELETE routes in the API. The fix adds a custom content-type parser at the app level in `app.ts` that handles the empty-body case gracefully by returning `undefined` (which route handlers ignore, as DELETE routes don't read the body).

## Changes

### apps/api/src/app.ts

Added `app.addContentTypeParser("application/json", ...)` immediately after Fastify instance creation, before any plugin registrations. The parser:
- Returns `undefined` for empty string bodies (graceful handling for DELETE)
- Parses non-empty JSON strings normally via `JSON.parse()`
- Passes parse errors through (malformed JSON still returns 400)

### apps/api/src/__tests__/employees.test.ts

Added a focused regression test in a new `describe("DELETE with Content-Type: application/json (empty body)")` block that:
1. Creates a throwaway employee (user + employee + overtimeAccount)
2. Sends DELETE with `Content-Type: application/json` header and no body
3. Asserts 204 status (successful DSGVO anonymization)

## TDD Flow

- RED: New test failed with 400 before fix (Fastify rejected empty body)
- GREEN: All 13 employees tests pass after adding custom content-type parser
- No REFACTOR needed (implementation is clean as-is)

## Commits

| Hash | Type | Description |
|------|------|-------------|
| c6fe46c | fix | handle Content-Type: application/json with empty body on DELETE requests |

## Deviations from Plan

**1. [Rule 1 - Bug] Fixed test data: `tenantId` vs `tenant.id` and user without tenant**
- **Found during:** Task 1 (GREEN phase)
- **Issue:** Plan's test template used `data.tenantId` (undefined) and passed `tenantId` to user create. `seedTestData()` returns `tenant` object, not `tenantId` string. Users don't have a `tenantId` field.
- **Fix:** Changed to `data.tenant.id` for employee create, removed `tenantId` from user create (matching the pattern used in the existing DSGVO test)
- **Files modified:** `apps/api/src/__tests__/employees.test.ts`
- **Commit:** c6fe46c (incorporated into same commit)

## Known Stubs

None.

## Self-Check: PASSED

- `apps/api/src/app.ts` — modified, content-type parser present
- `apps/api/src/__tests__/employees.test.ts` — modified, new test present
- Commit `c6fe46c` — exists in git log
- All 13 employees tests pass in container
