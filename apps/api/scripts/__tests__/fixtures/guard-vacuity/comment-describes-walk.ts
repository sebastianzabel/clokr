/**
 * Guard-vacuity fixture — D-03 direction 1: this docblock describes the anti-pattern in PROSE,
 * quoting `readdirSync(` and `expect(files.length).toBeGreaterThan(0)` as words, not as code.
 * The function body below does neither; comments are trivia in the AST and are never visited.
 * Classification: walks=false, asserts=false, inputProof="none".
 */
export function noop(): number {
  return 42;
}
