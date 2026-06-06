import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import { resolveActor } from "../audit-actor";

function fakeReq(sub: string | undefined): FastifyRequest {
  // Cast through unknown — we're only exercising the user.sub field path.
  return {
    user: sub === undefined ? undefined : { sub },
  } as unknown as FastifyRequest;
}

describe("services/clock/audit-actor — resolveActor()", () => {
  it("JWT user sub → USER actor", () => {
    const actor = resolveActor(fakeReq("user-uuid-123"));
    expect(actor).toEqual({ type: "USER", userId: "user-uuid-123" });
  });

  it("apikey-prefixed sub → API_KEY actor with stripped prefix", () => {
    const actor = resolveActor(fakeReq("apikey:key-uuid-456"));
    expect(actor).toEqual({ type: "API_KEY", apiKeyId: "key-uuid-456" });
  });

  it("undefined req → SYSTEM actor (cron / background job)", () => {
    const actor = resolveActor(undefined);
    expect(actor).toEqual({ type: "SYSTEM" });
  });

  it("req without user (anonymous) → SYSTEM actor", () => {
    const actor = resolveActor(fakeReq(undefined));
    expect(actor).toEqual({ type: "SYSTEM" });
  });

  it("apikey: prefix with empty id → API_KEY with empty apiKeyId (defensive — should not crash)", () => {
    const actor = resolveActor(fakeReq("apikey:"));
    expect(actor).toEqual({ type: "API_KEY", apiKeyId: "" });
  });
});
