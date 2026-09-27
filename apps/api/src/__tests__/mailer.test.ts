import { describe, it, expect } from "vitest";
import nodemailer from "nodemailer";

/**
 * DEP-V1814-01 — nodemailer 10.x smoke test
 *
 * Verifies that the sendMail API (createTransport + sendMail) works correctly
 * after the 9.1.1 → 10.0.10 upgrade. nodemailer 10 requires Node >= 20 and is
 * a full TypeScript rewrite with ESM+CJS builds and bundled type declarations
 * (`@types/nodemailer` is no longer installed — the package's own `types`
 * field wins under the project's `module: commonjs` / node10 resolution).
 * Uses jsonTransport so no live SMTP server is required — suitable for CI and
 * local unit-test runs.
 *
 * The production mailer plugin (apps/api/src/contexts/platform/plugins/mailer.ts)
 * uses only host/port/auth transports with inline HTML bodies. No OAuth2,
 * proxies, or attachment URLs — this smoke test proves the createTransport/
 * sendMail shape survived the rewrite.
 */
describe("mailer", () => {
  it("sends without throwing via jsonTransport", async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });

    const info = await transporter.sendMail({
      from: '"Clokr Test" <noreply@clokr.test>',
      to: "recipient@example.com",
      subject: "DEP-V1814-01 smoke test",
      html: "<p>nodemailer 10.x sendMail smoke test</p>",
    });

    // info object must exist and carry envelope data
    expect(info).toBeDefined();
    expect(info.envelope).toBeDefined();
    expect(info.envelope.from).toBe("noreply@clokr.test");
    expect(info.envelope.to).toEqual(["recipient@example.com"]);
  });

  it("createTransport returns a Transporter with sendMail method (API shape unchanged)", () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });

    expect(typeof transporter.sendMail).toBe("function");
  });
});
