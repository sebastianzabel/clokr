// Specifier shape: explicit ".js" suffix, no literal "contexts/" segment (NodeNext-style,
// resolved via check-import-targets.ts's .js -> .ts remap).
import { workingTimeAccountDeepThing } from "../../working-time-account/deep.js";

// Specifier shape: pointing at the index IMPLICITLY -> must NOT be counted.
import { implicitIndexThing } from "../../platform";

// Specifier shape: pointing at the index EXPLICITLY -> must NOT be counted.
import { explicitIndexThing } from "../../platform/index";

export const nestedUses = [workingTimeAccountDeepThing, implicitIndexThing, explicitIndexThing];
