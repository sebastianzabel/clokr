/**
 * Phase 89 (#89, D-07/D-12) — composition seam of the operator's salon routes.
 *
 * The operator salon routes live in the Unterbau, which must not import a business context
 * (ADR 0002, Entscheidung 9). The two answers they need from outside it — how many time entries
 * hang on a salon (Zeiterfassung) and which Phorest coupling a salon has (Schichtplanung) — are
 * handed in through this port by the composition root. It owns no model and carries no rule: it
 * only maps the public exports of the two contexts onto the shape the route declares.
 *
 * D-12 names the coupling port `{ get, set, remove }`; `list` is the read over all salons of a
 * tenant. `set`/`remove` arrive with the mutations and look a single row up themselves.
 */
import { countEntriesForSalon } from "../contexts/time-tracking";
import { listSalonCouplings } from "../contexts/scheduling";

export const operatorSalonPorts = {
  countTimeEntriesForSalon: countEntriesForSalon,
  coupling: { list: listSalonCouplings },
};
