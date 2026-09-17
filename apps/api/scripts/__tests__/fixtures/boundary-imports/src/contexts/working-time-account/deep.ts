// Cross-context matrix, both directions, hyphenated importer (D-07):
// working-time-account -> platform, working-time-account -> time-tracking (BOTH sides
// hyphenated, reversed from time-tracking/deep.ts's own pair).
import { platformDeepThing } from "../platform/deep";
import { timeTrackingDeepThing } from "../time-tracking/deep";

export const workingTimeAccountDeepThing = "working-time-account";
export const workingTimeAccountUses = [platformDeepThing, timeTrackingDeepThing];
