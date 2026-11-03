/**
 * Issue #608 — Web-Push plumbing in a real browser on the production build.
 *
 * What a mounted unit test cannot see: the service worker is only registered by a browser, and
 * only if the real Content-Security-Policy of the app lets it. This spec proves, without any
 * push key on the test stack (so push is OFF here):
 *   1. the install assets are served without a session (manifest, worker, icon) and the push
 *      config route exists (401, not 404);
 *   2. the worker registers on a signed-in tenant page and no CSP violation is reported;
 *   3. /settings renders (control: "Passwort ändern" is visible) and shows no push section.
 * The delivery to a real phone is the owner's device acceptance (PR checklist), not automatable.
 */
import { test, expect } from "../fixtures";
import { signInForWalkthrough } from "../helpers/visibility-walkthrough";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";

test.describe("Issue #608 — Web-Push plumbing", () => {
  test("serves the manifest, the worker and the icons without a session; the push config route exists", async ({
    request,
  }) => {
    const manifestRes = await request.get("/manifest.json");
    expect(manifestRes.status()).toBe(200);
    const manifest = (await manifestRes.json()) as {
      display: string;
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
    };
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons).toHaveLength(3);

    const workerRes = await request.get("/service-worker.js");
    expect(workerRes.status()).toBe(200);
    expect(workerRes.headers()["content-type"] ?? "").toMatch(/javascript/);

    const iconRes = await request.get("/icon-192.png");
    expect(iconRes.status()).toBe(200);
    expect(iconRes.headers()["content-type"] ?? "").toMatch(/image\/png/);

    // Anti-vacuity: the route exists (an auth wall), it is not a missing path.
    const configRes = await request.get(`${API_BASE}/api/v1/me/push/config`);
    expect(configRes.status()).toBe(401);
  });

  test("registers the service worker on a signed-in page without a CSP violation", async ({
    page,
    request,
    tenant,
  }) => {
    await signInForWalkthrough(page, request, tenant, "light");

    await page.addInitScript(() => {
      const bag: string[] = [];
      (window as unknown as { __cspViolations: string[] }).__cspViolations = bag;
      document.addEventListener("securitypolicyviolation", (e) => {
        bag.push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/dashboard");
    await expect(page.getByRole("main")).toBeVisible();

    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Promise.race([
              navigator.serviceWorker.ready.then((r) => r.active?.scriptURL ?? ""),
              new Promise<string>((resolve) => setTimeout(() => resolve(""), 4000)),
            ]),
          ),
        { message: "the service worker becomes active", timeout: 20_000 },
      )
      .toMatch(/\/service-worker\.js$/);

    const violations = await page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
    );
    expect(violations, "no Content-Security-Policy violation").toEqual([]);
    expect(
      consoleErrors.filter((m) => /content security policy|service.?worker/i.test(m)),
      "no console error about the CSP or the worker",
    ).toEqual([]);
  });

  test("shows no push section on /settings when the instance has no VAPID keys", async ({
    page,
    request,
    tenant,
  }) => {
    await signInForWalkthrough(page, request, tenant, "light");
    await page.goto("/settings");

    // Control: the page rendered, so the absence below is not an empty page.
    await expect(page.getByRole("heading", { name: "Passwort ändern" })).toBeVisible();
    await expect(page.getByText("Push-Benachrichtigungen")).toHaveCount(0);
  });
});
