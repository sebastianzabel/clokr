// Specifier shape: WITH a literal "contexts/" segment — this is how composition/, app.ts and
// scripts/ write cross-context specifiers, because they sit outside contexts/ entirely.
import { absenceDeepThing } from "../contexts/absence/deep";

export const dashboardUses = absenceDeepThing;
