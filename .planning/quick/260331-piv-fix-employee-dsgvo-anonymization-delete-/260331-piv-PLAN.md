---
type: quick-fix
scope: api
files_modified:
  - apps/api/src/app.ts
  - apps/api/src/__tests__/employees.test.ts
autonomous: true
---

<objective>
Fix Fastify rejecting DELETE requests that include `Content-Type: application/json` with an empty body.

Purpose: External API clients (MCP tools, Postman, curl, programmatic clients) commonly send `Content-Type: application/json` on all requests including DELETE. Fastify's default JSON parser rejects these with HTTP 400 "Body cannot be empty when content-type is set to 'application/json'". This affects ALL DELETE routes, not just the employee DSGVO anonymization endpoint.

Output: App-level fix in `app.ts` that gracefully handles empty-body JSON DELETE requests, plus a regression test.
</objective>

<context>
@apps/api/src/app.ts — Fastify app setup, where content type parsers are configured
@apps/api/src/routes/employees.ts — DELETE /:id route (DSGVO anonymization, line 451)
@apps/api/src/__tests__/employees.test.ts — Existing DSGVO anonymization tests (line 260)
@apps/web/src/lib/api/client.ts — Web client correctly omits Content-Type on DELETE (line 23)

Key finding: The web frontend does NOT trigger this bug (it only sets Content-Type when body is present). But any external client sending `Content-Type: application/json` on DELETE requests gets a 400 error. This is a correctness issue affecting the API contract.

All 11 DELETE routes in the codebase are affected:
- employees/:id, time-entries/:id, leave/requests/:id, holidays/:id
- company-shutdowns/:id, terminals/:id, special-leave/rules/:id
- shifts/templates/:id, shifts/:id, avatars/:employeeId, api-keys/:id
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add app-level empty-body JSON parser and regression test</name>
  <files>apps/api/src/app.ts, apps/api/src/__tests__/employees.test.ts</files>
  <behavior>
    - Test: DELETE /api/v1/employees/:id with `Content-Type: application/json` header and NO body returns 204 (not 400)
    - Test: DELETE /api/v1/employees/:id WITHOUT Content-Type header still returns 204 (existing behavior preserved)
    - Test: POST with valid JSON body still parses correctly (no regression)
  </behavior>
  <action>
    1. In `apps/api/src/app.ts`, after the Fastify instance is created (after line 85 `const app = Fastify({...})`) and BEFORE any plugin registrations, add a custom content type parser that handles `application/json` with empty bodies gracefully:

    ```typescript
    // Handle DELETE (and other) requests that send Content-Type: application/json with empty body.
    // External API clients commonly set this header on all requests.
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (req, body, done) => {
        if (typeof body === "string" && body.trim() === "") {
          done(null, undefined);
          return;
        }
        try {
          done(null, JSON.parse(body as string));
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );
    ```

    This replaces Fastify's default JSON parser with one that:
    - Returns `undefined` for empty string bodies (instead of throwing)
    - Parses non-empty JSON normally
    - Passes parse errors through (existing behavior for malformed JSON)

    2. In `apps/api/src/__tests__/employees.test.ts`, inside the `COMPLIANCE: DSGVO anonymization (Art. 17)` describe block, add a new test case BEFORE the existing "DELETE anonymizes" test (since it consumes the test employee). Actually, since the existing test already deletes the employee, add the new test to a separate describe block or use a different employee. The simplest approach: add the test as part of the existing flow, testing that the Content-Type header is accepted.

    Add this test after the existing "AuditLog records the anonymization" test (which runs after the DELETE already happened), OR better: create a small focused test that creates its own employee and tests the Content-Type scenario.

    The cleanest approach: Add a focused `describe("DELETE with Content-Type: application/json header")` block that creates a minimal employee, sends a DELETE with the problematic header, and asserts 204. Place it after the existing DSGVO describe block (~line 310).

    ```typescript
    describe("DELETE with Content-Type: application/json (empty body)", () => {
      it("accepts DELETE with Content-Type header and no body", async () => {
        // Create a throwaway employee for this test
        const uid = crypto.randomUUID().slice(0, 8);
        const user = await app.prisma.user.create({
          data: {
            email: `ct-test-${uid}@test.local`,
            passwordHash: "test",
            role: "EMPLOYEE",
            tenantId: data.tenantId,
          },
        });
        const emp = await app.prisma.employee.create({
          data: {
            userId: user.id,
            tenantId: data.tenantId,
            firstName: "CT",
            lastName: "Test",
            employeeNumber: `CT-${uid}`,
            hireDate: new Date("2024-01-01"),
          },
        });
        await app.prisma.overtimeAccount.create({
          data: { employeeId: emp.id, balanceHours: 0 },
        });

        const res = await app.inject({
          method: "DELETE",
          url: `/api/v1/employees/${emp.id}`,
          headers: {
            authorization: `Bearer ${data.adminToken}`,
            "content-type": "application/json",
          },
        });

        expect(res.statusCode).toBe(204);
      });
    });
    ```

    Make sure to import `crypto` at the top of the test file if not already imported (check first — the existing DSGVO test already uses `crypto.randomUUID()` so it likely is imported or uses the global).
  </action>
  <verify>
    <automated>cd /Users/sebastianzabel/git/clokr && docker compose exec api npx vitest run src/__tests__/employees.test.ts --reporter=verbose 2>&1 | tail -40</automated>
  </verify>
  <done>
    - DELETE requests with `Content-Type: application/json` and empty body return the expected status (204 for employee anonymization), not 400
    - DELETE requests without Content-Type header continue to work (existing tests pass)
    - POST/PUT/PATCH with JSON bodies continue to parse correctly (existing tests pass)
    - New regression test covers the Content-Type + empty body scenario
  </done>
</task>

</tasks>

<verification>
Run the full employees test suite to confirm no regressions:
```bash
cd /Users/sebastianzabel/git/clokr && docker compose exec api npx vitest run src/__tests__/employees.test.ts --reporter=verbose
```

Optionally run the full API test suite to ensure the app-level parser change doesn't break other routes:
```bash
cd /Users/sebastianzabel/git/clokr && docker compose exec api npx vitest run --reporter=verbose
```
</verification>

<success_criteria>
- All existing employee tests pass (DSGVO anonymization, CRUD, etc.)
- New test proves DELETE with Content-Type: application/json header succeeds
- No regressions in other API tests (the custom JSON parser handles all existing use cases)
</success_criteria>
