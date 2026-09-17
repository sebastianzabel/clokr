// Every import form check-import-targets.ts knows, all targeting the same foreign module
// (contexts/absence/deep.ts) so the only variable between the four rows is `form`.

// form: "from"
import { absenceDeepThing } from "../absence/deep";

// form: "typeof-import"
export type LazyAbsenceModule = typeof import("../absence/deep");

// form: "vi.mock" — zero production occurrences today (RESEARCH.md), tested anyway: a form with
// zero current hits is not a form to leave unimplemented.
vi.mock("../absence/deep");

// form: "dynamic-import"
export async function loadAbsenceDynamically() {
  return import("../absence/deep");
}

export const formsUses = absenceDeepThing;
