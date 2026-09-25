/**
 * Phase 75b (Issue #75, D-20) — every external effect of the neutrality matrix, stubbed.
 *
 * The matrix calls every route of the API for every actor, including the mutating ones that send
 * mail (`POST /settings/smtp/test`, invitations), talk to Phorest (`/integrations/phorest/*`),
 * refresh school holidays from OpenHolidays, or read and write object storage (avatars, § 9
 * documents). Two properties depend on none of that reaching the outside world:
 *   - DETERMINISM: a cell's record must not depend on whether an SMTP server, the Phorest gateway,
 *     the OpenHolidays API or MinIO happens to answer during this run — a flaky upstream would turn
 *     a neutrality proof into a network test;
 *   - NO NETWORK I/O: a test must never mail a real address or call a real third-party API.
 * The stubs are therefore installed in BOTH modes (RECORD and VERIFY): the recording is made
 * against exactly the answers a verification later sees.
 *
 *   - `app.mailer`: every send method resolves without sending and records the call;
 *     `getSmtpConfig` answers `null`, so the notification e-mail path (`notify.ts`) stops before it
 *     builds a transport even when a cell configured SMTP for its tenant.
 *   - `app.storage`: an in-memory map. A path nothing was uploaded to answers a fixed buffer, so
 *     the fixture's avatar and § 9 document paths are readable without a prior upload.
 *   - `fetch`: the OpenHolidays host and the Phorest gateway get a fixed JSON reply; every other
 *     host throws and is recorded in `unexpectedFetches`, so an unforeseen network call is loud
 *     (the matrix test asserts the list is empty) instead of silently answered.
 */
import { vi } from "vitest";
import type { FastifyInstance } from "fastify";

/** The fixed school-holiday period OpenHolidays "returns" for any subdivision. The id is not a
 * uuid on purpose: it must not show up in a cell's id multiset as an unlabelled `<new>`. */
const SCHOOL_HOLIDAY_REPLY = [
  {
    id: "matrix-school-holiday",
    startDate: "2026-08-03",
    endDate: "2026-08-14",
    type: "School",
    name: [{ language: "DE", text: "Matrix Sommerferien" }],
    subdivisions: [{ code: "DE-NI" }],
  },
];

/** The fixed Phorest reply for every path: no staff, no appointments, no shifts. */
const PHOREST_REPLY = {
  _embedded: { staffs: [], appointments: [], rosters: [], breaks: [] },
  page: { size: 0, totalElements: 0, totalPages: 0, number: 0 },
};

/** Hosts answered with a fixed reply. Everything else throws. */
const STUBBED_HOSTS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["openholidaysapi.org", SCHOOL_HOLIDAY_REPLY],
  ["api-gateway-eu.phorest.com", PHOREST_REPLY],
]);

/** A buffer every never-uploaded storage path answers with (fixture avatars, § 9 documents). */
const FIXTURE_OBJECT = Buffer.from("matrix-fixture-object");

export interface ExternalStubs {
  /** Mail sends the cells triggered, by method name (recipients are not kept). */
  readonly mailCalls: string[];
  /** Hosts a cell tried to reach that no stub answers — must stay empty. */
  readonly unexpectedFetches: string[];
  /** Puts the real mailer, storage and `fetch` back. */
  restore(): void;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Replaces mailer, storage and `fetch` for the lifetime of the matrix file. */
export function installExternalStubs(app: FastifyInstance): ExternalStubs {
  const mailCalls: string[] = [];
  const unexpectedFetches: string[] = [];

  const originalMailer = app.mailer;
  app.mailer = {
    sendInvitation: async () => {
      mailCalls.push("sendInvitation");
    },
    sendOtp: async () => {
      mailCalls.push("sendOtp");
    },
    sendPasswordReset: async () => {
      mailCalls.push("sendPasswordReset");
    },
    sendTestMail: async () => {
      mailCalls.push("sendTestMail");
    },
    getSmtpConfig: async () => null,
  };

  const originalStorage = app.storage;
  const stored = new Map<string, Buffer>();
  app.storage = {
    upload: async (path, buffer) => {
      stored.set(path, buffer);
    },
    getBuffer: async (path) => stored.get(path) ?? FIXTURE_OBJECT,
    delete: async (path) => {
      stored.delete(path);
    },
  };

  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname;
    const reply = STUBBED_HOSTS.get(host);
    if (reply === undefined) {
      unexpectedFetches.push(host);
      throw new Error(`network access to ${host} is disabled in the neutrality matrix`);
    }
    return jsonResponse(reply);
  });

  return {
    mailCalls,
    unexpectedFetches,
    restore() {
      vi.unstubAllGlobals();
      app.mailer = originalMailer;
      app.storage = originalStorage;
    },
  };
}
