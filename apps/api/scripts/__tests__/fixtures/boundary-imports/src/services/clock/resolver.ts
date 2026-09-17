// ADR 0001 entry F: services/clock/** belongs to time-tracking.
// This own-context import (name-bearing path, but same area) must NOT be counted.
import { timeTrackingDeepThing } from "../../contexts/time-tracking/deep";
// This cross-context import (services/clock -> absence) MUST be counted.
import { absenceDeepThing } from "../../contexts/absence/deep";

export const resolverUses = [timeTrackingDeepThing, absenceDeepThing];
