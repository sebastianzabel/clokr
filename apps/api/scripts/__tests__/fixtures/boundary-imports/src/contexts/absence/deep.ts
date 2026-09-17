// Cross-context matrix, both directions (D-07): absence -> platform, absence -> scheduling.
import { platformDeepThing } from "../platform/deep";
import { schedulingDeepThing } from "../scheduling/deep";

export const absenceDeepThing = "absence";
export type AbsenceDeepType = string;
export const absenceUses = [platformDeepThing, schedulingDeepThing];
