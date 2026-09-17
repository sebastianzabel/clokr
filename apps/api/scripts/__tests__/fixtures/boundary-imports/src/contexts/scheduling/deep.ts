// Cross-context matrix, both directions, hyphenated target (D-07):
// scheduling -> time-tracking (hyphen as target), scheduling -> absence.
import { timeTrackingDeepThing } from "../time-tracking/deep";
import { absenceDeepThing } from "../absence/deep";

export const schedulingDeepThing = "scheduling";
export const schedulingUses = [timeTrackingDeepThing, absenceDeepThing];
