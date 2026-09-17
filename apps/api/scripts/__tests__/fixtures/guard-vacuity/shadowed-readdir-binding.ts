/**
 * Guard-vacuity fixture — a locally DECLARED `function readdirSync(rows)` shadows the name with
 * no fs import anywhere. Binding resolution must key off the actual import, never the identifier
 * text, or this would be misclassified as a walker. Classification: walks=false, asserts=true,
 * inputProof="none".
 */
function readdirSync(rows: string[]): string[] {
  return rows.filter((r) => r.length > 0);
}

export function checkRows(rows: string[]): void {
  const result = readdirSync(rows);
  expect(result.length).toBeGreaterThan(0);
}
