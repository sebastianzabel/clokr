// Cross-context matrix, both directions, hyphenated importer AND hyphenated target (D-07):
// time-tracking -> scheduling (hyphen as importer), time-tracking -> working-time-account
// (BOTH sides hyphenated).
import { schedulingDeepThing } from "../scheduling/deep";
import { workingTimeAccountDeepThing } from "../working-time-account/deep";

export const timeTrackingDeepThing = "time-tracking";
export const timeTrackingUses = [schedulingDeepThing, workingTimeAccountDeepThing];
