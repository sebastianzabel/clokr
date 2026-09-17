// ADR 0001 entry F: services/phorest/** belongs to scheduling.
// This own-context import (name-bearing path, but same area) must NOT be counted.
import { schedulingDeepThing } from "../../contexts/scheduling/deep";
// This cross-context import (services/phorest -> platform) MUST be counted.
import { platformDeepThing } from "../../contexts/platform/deep";

export const syncUses = [schedulingDeepThing, platformDeepThing];
