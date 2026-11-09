// Issue #843, D-843-06 (plan 843-18): the lint:no-alert gate keeps native browser dialogs out of
// the web app. A gate whose regex silently matches nothing reports OK forever, so this file
// proves the detector can fail (positive controls), does not over-fire (negative controls) and
// that the walked set is not empty.

import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { findNativeDialogCalls, listSourceFiles } from "../../scripts/lint-no-alert.mjs";

const calls = (source: string) => findNativeDialogCalls(source).map((h) => h.call);

describe("findNativeDialogCalls — positive controls", () => {
  it("reports a bare alert", () => {
    expect(calls(`alert("x");`)).toEqual(["alert("]);
  });

  it("reports window.alert, prompt and window.prompt", () => {
    expect(calls(`window.alert(x);`)).toEqual(["window.alert("]);
    expect(calls(`const v = prompt("Name?");`)).toEqual(["prompt("]);
    expect(calls(`const v = window.prompt("Name?");`)).toEqual(["window.prompt("]);
  });

  it("reports window.confirm even when the file declares its own confirm", () => {
    const source = `async function confirm() {}\nif (window.confirm("Sicher?")) {}`;
    expect(calls(source)).toEqual(["window.confirm("]);
  });

  it("reports a bare confirm when nothing declares it locally", () => {
    expect(calls(`if (confirm("Sicher?")) go();`)).toEqual(["confirm("]);
  });

  it("carries the true line number", () => {
    const hits = findNativeDialogCalls(`a();\n\n  alert("x");\n`);
    expect(hits).toEqual([{ line: 3, call: "alert(" }]);
  });
});

describe("findNativeDialogCalls — negative controls", () => {
  it("accepts a file that declares its own confirm function", () => {
    expect(calls(`async function confirm() {}\nvoid confirm();`)).toEqual([]);
    expect(calls(`const confirm = () => {};\nconfirm();`)).toEqual([]);
  });

  it("accepts method calls on another object", () => {
    expect(calls(`toasts.alert("x"); dialog.confirm(); obj.prompt();`)).toEqual([]);
  });

  it("accepts longer identifiers", () => {
    expect(calls(`onConfirm(); alertTone(); const confirmLabel = 1; promptText();`)).toEqual([]);
  });

  it("accepts comments of every kind", () => {
    const source = [
      `// alert("x")`,
      `/* confirm("x") */`,
      `<!-- prompt("x") -->`,
      `const url = "https://example.test"; // window.alert(1)`,
    ].join("\n");
    expect(calls(source)).toEqual([]);
  });

  it("does not treat a function declaration named alert as a call", () => {
    expect(calls(`function alert() {}`)).toEqual([]);
  });
});

describe("lint:no-alert on the real tree", () => {
  it("walks a real source set (anti-vacuity floor)", () => {
    expect(listSourceFiles().length).toBeGreaterThan(300);
  });

  it("finds no native dialog call in any source file", () => {
    const hits = listSourceFiles().flatMap((file) =>
      findNativeDialogCalls(readFileSync(file, "utf8")).map((h) => `${file}:${h.line}`),
    );
    expect(hits).toEqual([]);
  });
});
