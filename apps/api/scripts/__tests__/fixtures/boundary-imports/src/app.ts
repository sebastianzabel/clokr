// Fixture stand-in for the real composition root. classifyArea() must call this "other" — it is
// not inside contexts/, services/clock, services/phorest, or composition/.
//
// Regression-test fixture (Plan 03): this ONE deep import is the excepted-composition-root case —
// a test-supplied ExceptionsDocument marks it `wholeFile`, matching the real app.ts's shape.
import { appOnlyThing } from "./contexts/absence/app-only";

export const appUses = appOnlyThing;
