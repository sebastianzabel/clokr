/**
 * Guard-vacuity fixture — the 29 -> 26 false-friend: a function named like a tree walk that
 * walks an IN-MEMORY array of already-loaded DB rows, with no `node:fs`/`node:child_process`
 * import anywhere. Must NOT classify as a walker. Classification: walks=false, asserts=true,
 * inputProof="none".
 */
function walkChain(rows: { id: string }[]): string[] {
  return rows.map((r) => r.id);
}

export function checkChain(rows: { id: string }[]): void {
  const links = walkChain(rows);
  expect(links.length).toBeGreaterThan(0);
}
