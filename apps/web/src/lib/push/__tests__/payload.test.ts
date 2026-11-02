import { describe, expect, it } from "vitest";
import { PUSH_FALLBACK, parsePushPayload, targetUrlFor } from "../payload";

const ORIGIN = "https://app.example";

function data(value: unknown) {
  return { json: () => value };
}

describe("parsePushPayload", () => {
  it("passes a valid payload through", () => {
    const p = { title: "Clokr", body: "Du bist noch eingestempelt.", url: "/time-entries" };
    expect(parsePushPayload(data(p))).toEqual(p);
  });

  it("falls back for null and undefined data", () => {
    expect(parsePushPayload(null)).toEqual(PUSH_FALLBACK);
    expect(parsePushPayload(undefined)).toEqual(PUSH_FALLBACK);
  });

  it("falls back when json() throws", () => {
    const throwing = {
      json: () => {
        throw new SyntaxError("bad");
      },
    };
    expect(parsePushPayload(throwing)).toEqual(PUSH_FALLBACK);
  });

  it.each([
    ["a string", "hello"],
    ["a number", 7],
    ["an array", [1, 2]],
    ["null", null],
    ["a missing title", { body: "x", url: "/a" }],
    ["a non-string body", { title: "Clokr", body: 5, url: "/a" }],
    ["an empty title", { title: "", body: "x", url: "/a" }],
    ["a too long title", { title: "T".repeat(101), body: "x", url: "/a" }],
    ["a too long body", { title: "Clokr", body: "b".repeat(301), url: "/a" }],
  ])("falls back for %s", (_label, value) => {
    expect(parsePushPayload(data(value))).toEqual(PUSH_FALLBACK);
  });

  it("keeps title and body when only the url is missing or unsafe", () => {
    expect(parsePushPayload(data({ title: "Clokr", body: "Hallo" }))).toEqual({
      title: "Clokr",
      body: "Hallo",
      url: "/dashboard",
    });
    expect(
      parsePushPayload(data({ title: "Clokr", body: "Hallo", url: "//evil.example" })).url,
    ).toBe("/dashboard");
  });

  it("returns a fresh object, never the shared fallback", () => {
    const a = parsePushPayload(null);
    a.title = "changed";
    expect(PUSH_FALLBACK.title).toBe("Clokr");
  });
});

describe("targetUrlFor", () => {
  it("resolves a safe relative path against the origin", () => {
    expect(targetUrlFor("/team/leave?request=1", ORIGIN)).toBe(`${ORIGIN}/team/leave?request=1`);
    expect(targetUrlFor("/dashboard", ORIGIN)).toBe(`${ORIGIN}/dashboard`);
  });

  it.each([
    ["protocol-relative", "//evil.example"],
    ["backslash", "/\\evil.example"],
    ["absolute https", "https://evil.example/x"],
    ["javascript scheme", "javascript:alert(1)"],
    ["encoded slashes", "/x%2F%2Fy"],
    ["encoded traversal", "/a/%2e%2e/b"],
    ["plain traversal", "/a/../b"],
    ["control character", "/a\nb"],
    ["whitespace", "/a b"],
    ["no leading slash", "dashboard"],
    ["empty", ""],
    ["too long", `/${"a".repeat(512)}`],
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
  ])("refuses %s and falls back to the dashboard", (_label, raw) => {
    expect(targetUrlFor(raw, ORIGIN)).toBe(`${ORIGIN}/dashboard`);
  });
});
