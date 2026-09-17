// Owner decision #246: __tests__/ stays out of the boundary rule's scope. This file deep-imports
// a foreign context and MUST produce zero rows from scanApiRoot()/discoverProductionFiles().
import { absenceDeepThing } from "../../../absence/deep";

export const testUses = absenceDeepThing;
