// Cross-context matrix, both directions, both hyphenated contexts on each side (D-07):
// platform -> absence, platform -> working-time-account (hyphen as target).
import { absenceDeepThing } from "../absence/deep";
import { workingTimeAccountDeepThing } from "../working-time-account/deep";

export const platformDeepThing = "platform";
export const platformUses = [absenceDeepThing, workingTimeAccountDeepThing];
