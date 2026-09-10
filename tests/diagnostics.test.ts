import { describe, expect, it } from "vitest";
import { startDiagnosticTimer } from "@/diagnostics/TramaDiagnostics";

describe("diagnostic timing", () => {
  it("measures elapsed milliseconds from a shared clock and clamps clock regressions", () => {
    let now = 100;
    const elapsedMs = startDiagnosticTimer(() => now);

    now = 145;
    expect(elapsedMs()).toBe(45);
    now = 90;
    expect(elapsedMs()).toBe(0);
  });
});
