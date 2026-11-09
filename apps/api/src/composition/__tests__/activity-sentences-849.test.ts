/**
 * Issue #849 (4), #845 D-05 — the Verlauf names stamp events as complete sentences, keeps the
 * clock-in next to the clock-out, names who recorded a manual entry and shows a sentence once.
 */
import { describe, it, expect } from "vitest";
import {
  dedupeActivitySentences,
  entryActivityEvents,
  UNKNOWN_AUTHOR,
} from "../activity-sentences";

const TZ = "Europe/Berlin";
const OWN = "user-own";
const base = {
  id: "e1",
  startTime: new Date("2026-11-02T07:02:00Z"), // 08:02 Berlin
  endTime: new Date("2026-11-02T17:15:00Z"), // 18:15 Berlin
  createdAt: new Date("2026-11-02T07:02:01Z"),
  createdBy: OWN,
};

const sentence = (e: { who: string; what: string }) => `${e.who} ${e.what}`;

describe("activity sentences (Issue #849)", () => {
  it("a clocked entry gives both events as full sentences, at their own times", () => {
    const events = entryActivityEvents(
      { ...base, source: "MOBILE" },
      { tz: TZ, ownUserId: OWN, authorFirstName: null },
    );
    expect(events.map(sentence)).toEqual([
      "Du hast um 08:02 eingestempelt.",
      "Du hast um 18:15 ausgestempelt.",
    ]);
    expect(events.map((e) => e.when)).toEqual([
      base.startTime.toISOString(),
      base.endTime.toISOString(),
    ]);
  });

  it("an open clocked entry gives only the clock-in", () => {
    const events = entryActivityEvents(
      { ...base, endTime: null, source: "NFC" },
      { tz: TZ, ownUserId: OWN, authorFirstName: null },
    );
    expect(events.map(sentence)).toEqual(["Du hast um 08:02 eingestempelt."]);
  });

  it("an entry an admin recorded names the admin and the day, never 'Du … ausgestempelt'", () => {
    const events = entryActivityEvents(
      { ...base, source: "MANUAL", createdBy: "user-admin" },
      { tz: TZ, ownUserId: OWN, authorFirstName: "Sabine" },
    );
    expect(events.map(sentence)).toEqual([
      "Sabine hat für dich Mo, 02.11. 08:02–18:15 eingetragen.",
    ]);
    const anonymous = entryActivityEvents(
      { ...base, source: "MANUAL", createdBy: "user-gone" },
      { tz: TZ, ownUserId: OWN, authorFirstName: null },
    );
    expect(anonymous[0].who).toBe(UNKNOWN_AUTHOR);
  });

  it("an own manual entry is 'Du hast für <Tag> … eingetragen.'", () => {
    const events = entryActivityEvents(
      { ...base, source: "MANUAL" },
      { tz: TZ, ownUserId: OWN, authorFirstName: null },
    );
    expect(events.map(sentence)).toEqual(["Du hast für Mo, 02.11. 08:02–18:15 eingetragen."]);
  });

  it("five manual entries on different days are five different lines; a repeated sentence shows once", () => {
    const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
    const events = days.flatMap((d, i) =>
      entryActivityEvents(
        {
          id: `m${i}`,
          startTime: new Date(`${d}T08:00:00Z`),
          endTime: new Date(`${d}T17:15:00Z`),
          createdAt: new Date("2026-11-07T10:00:00Z"),
          source: "MANUAL",
          createdBy: "user-admin",
        },
        { tz: TZ, ownUserId: OWN, authorFirstName: "Sabine" },
      ),
    );
    expect(new Set(events.map(sentence)).size).toBe(5);
    expect(dedupeActivitySentences([...events, ...events])).toHaveLength(5);
  });

  it("never merges two leave events that share their wording", () => {
    const leave = { who: "Lisa", what: "Urlaub eingereicht", category: "leave" };
    expect(dedupeActivitySentences([leave, { ...leave }])).toHaveLength(2);
  });
});
