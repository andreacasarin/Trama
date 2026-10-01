import { describe, expect, it } from "vitest";
import {
  formatDiagnosticLogLine,
  createTramaDiagnostics,
  diagnosticTimer,
  diagnosticsEnabled,
  modeEnables,
  projectDiagnosticError,
  startDiagnosticTimer,
} from "@/diagnostics/TramaDiagnostics";
import { sqliteError } from "@/index/sqlite/protocol";

describe("diagnostic timing", () => {
  it("treats a throwing injected enabled port as disabled without reading clocks", () => {
    const diagnostics = {
      enabled: () => {
        throw new Error("hostile");
      },
      emit: () => {
        throw new Error("hostile");
      },
    };
    let reads = 0;
    expect(diagnosticsEnabled(diagnostics, "performance")).toBe(false);
    expect(diagnosticTimer(diagnostics, "performance", () => ++reads)).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("captures bounded Performance events with nested temporary override and restoration", async () => {
    const consoleRecords: unknown[] = [];
    const diagnostics = createTramaDiagnostics(
      () => "off",
      (record) => consoleRecords.push(record),
      { sessionId: "capture" }
    );
    const configurations: boolean[] = [];
    const configure = async () => {
      configurations.push(diagnostics.enabled("performance"));
    };
    const phase = () =>
      diagnostics.emit({
        tier: "performance",
        facets: ["index"],
        area: "index",
        event: "phase",
        operation: "semantic",
        phase: "overall",
        durationMs: 1,
      });
    const outer = await diagnostics.capturePerformance!(configure, async (outerRecords) => {
      phase();
      const inner = await diagnostics.capturePerformance!(configure, async () => {
        phase();
      });
      expect(inner).toHaveLength(1);
      expect(outerRecords).toHaveLength(2);
      phase();
    });
    expect(outer).toHaveLength(3);
    expect(consoleRecords).toHaveLength(0);
    expect(configurations).toEqual([true, true, true, false]);
    expect(diagnostics.enabled("performance")).toBe(false);
    await expect(
      diagnostics.capturePerformance!(configure, async () => {
        for (let index = 0; index < 513; index++) phase();
      })
    ).rejects.toThrow("exceeded 512 records");
    let consumed = 0;
    const streamed = await diagnostics.capturePerformance!(
      configure,
      async () => {
        for (let index = 0; index < 600; index++) phase();
      },
      () => {
        consumed++;
      }
    );
    expect(streamed).toHaveLength(0);
    expect(consumed).toBe(600);
    await expect(
      diagnostics.capturePerformance!(configure, async () => {
        throw new Error("work failed");
      })
    ).rejects.toThrow("work failed");
    expect(diagnostics.enabled("performance")).toBe(false);
  });
  it("orders modes, avoids disabled clocks, and isolates sink failures", () => {
    const records: unknown[] = [];
    let mode: "off" | "performance" | "detailed" = "off";
    let clockReads = 0;
    const diagnostics = createTramaDiagnostics(
      () => mode,
      (record) => {
        records.push(record);
        throw new Error("sink failed");
      },
      { sessionId: "session-a" }
    );
    expect(modeEnables("off", "performance")).toBe(false);
    expect(modeEnables("performance", "detailed")).toBe(false);
    expect(modeEnables("detailed", "performance")).toBe(true);
    expect(diagnosticTimer(diagnostics, "performance", () => ++clockReads)).toBeUndefined();
    expect(clockReads).toBe(0);
    mode = "performance";
    const timer = diagnosticTimer(diagnostics, "performance", () => ++clockReads);
    expect(timer?.()).toBe(1);
    diagnostics.emit({
      tier: "performance",
      facets: ["index", "semantic"],
      area: "index",
      event: "phase",
      operation: "semantic",
      phase: "prepareRpc",
      durationMs: 2,
    });
    diagnostics.emit({ area: "chat", event: "responses_request", body: { secret: "private" } });
    expect(records).toHaveLength(1);
    mode = "detailed";
    diagnostics.emit({ area: "chat", event: "responses_request", body: { secret: "private" } });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ tier: "performance", context: { sessionId: "session-a" } });
    expect(records[1]).toMatchObject({ tier: "detailed", facets: ["chat"] });
  });

  it("projects performance fields and strips extra data at runtime", () => {
    const records: unknown[] = [];
    const diagnostics = createTramaDiagnostics(
      () => "performance",
      (record) => records.push(record),
      { sessionId: "safe-session" }
    );
    diagnostics.emit({
      tier: "performance",
      facets: ["index"],
      area: "index",
      event: "phase",
      operation: "semantic",
      phase: "prepareRpc",
      durationMs: 1,
      context: {
        sessionId: "untrusted",
        operationId: "w1_o2",
        parentOperationId: "w1_o1",
        batchId: "w1_o2",
      },
      secret: "note text",
    } as any);
    expect(JSON.stringify(records)).not.toContain("note text");
    expect(records[0]).toMatchObject({
      context: {
        sessionId: "safe-session",
        operationId: "w1_o2",
        parentOperationId: "w1_o1",
        batchId: "w1_o2",
      },
    });
  });
  it("measures elapsed milliseconds from a shared clock and clamps clock regressions", () => {
    let now = 100;
    const elapsedMs = startDiagnosticTimer(() => now);

    now = 145;
    expect(elapsedMs()).toBe(45);
    now = 90;
    expect(elapsedMs()).toBe(0);
  });

  it("projects the production SQLite protocol error shape", () => {
    const projected = projectDiagnosticError(
      sqliteError("integrity_failed", "SQLite failed while reading the index", true)
    );
    expect(projected).toEqual({
      name: "SqliteProtocolError",
      code: "integrity_failed",
      message: "SQLite failed while reading the index",
      retryable: true,
    });
  });

  it("bounds technical messages and removes filesystem paths and opaque IDs", () => {
    const projected = projectDiagnosticError({
      name: "SqliteProtocolError",
      error: {
        code: "internal",
        retryable: false,
        message:
          "failed opening /Users/andrea/My Vault/Private Note.md and C:\\Vault\\Draft Note.md " +
          "for content aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa " +
          "with useful SQLite detail " +
          "x".repeat(500),
      },
    });
    expect(projected.code).toBe("internal");
    expect(projected.message).toContain("useful SQLite detail");
    expect(projected.message).not.toContain("Private Note.md");
    expect(projected.message).not.toContain("Draft Note.md");
    expect(projected.message).not.toContain("aaaaaaaaaaaaaaaa");
    expect(projected.message?.length).toBeLessThanOrEqual(240);
  });

  it("keeps ordinary errors useful without exposing long payloads", () => {
    const projected = projectDiagnosticError(new Error("no such column: f"));
    expect(projected).toMatchObject({ name: "Error", message: "no such column: f" });
  });

  it("formats a concise safe developer line for failed index operations", () => {
    const line = formatDiagnosticLogLine({
      area: "index",
      event: "index_operation",
      operation: "incremental",
      stage: "failed",
      error: {
        name: "SqliteProtocolError",
        code: "internal",
        message: "no such column: f while opening /Users/me/My Vault/Secret.md",
      },
    });
    expect(line).toContain("operation=incremental");
    expect(line).toContain("stage=failed");
    expect(line).toContain("code=internal");
    expect(line).toContain("message=no such column: f");
    expect(line).not.toContain("Secret.md");
    expect(line).not.toContain("/Users/me");
  });

  it("preserves only an allowlisted worker debug location", () => {
    const projected = projectDiagnosticError({
      name: "SqliteProtocolError",
      error: {
        code: "internal",
        message: "SQLite request failed",
        retryable: false,
        method: "retrieve",
        phase: "validate",
        debugLocation: "handleRequest@worker.mjs:42:7",
      },
    });
    expect(projected.debugLocation).toBe("handleRequest@worker.mjs:42:7");
    expect(projected.method).toBe("retrieve");
    expect(projected.phase).toBe("validate");
    expect(
      projectDiagnosticError({
        name: "SqliteProtocolError",
        error: {
          code: "internal",
          message: "bad",
          debugLocation: "/Users/me/My Vault/worker.mjs:42:7",
        },
      }).debugLocation
    ).toBeUndefined();
    expect(
      projectDiagnosticError({
        name: "SqliteProtocolError",
        error: {
          code: "internal",
          message: "bad",
          debugLocation: "handleRequest@worker.mjs:42" + "0".repeat(200),
        },
      }).debugLocation
    ).toBeUndefined();
    const line = formatDiagnosticLogLine({
      area: "index",
      event: "index_operation",
      operation: "incremental",
      stage: "failed",
      error: {
        name: "SqliteProtocolError",
        code: "internal",
        debugLocation: projected.debugLocation,
      },
    });
    expect(line).toContain("location=handleRequest@worker.mjs:42:7");
    expect(line).not.toContain("/");
    expect(line).not.toContain("My Vault");
  });

  it("includes safe method and phase correlation while dropping unsafe values", () => {
    const projected = projectDiagnosticError({
      name: "SqliteProtocolError",
      error: {
        code: "internal",
        message: "SQLite request failed",
        method: "retrieve",
        phase: "validate",
        debugLocation: "run@worker.mjs:9:3",
      },
    });
    const line = formatDiagnosticLogLine({
      area: "index",
      event: "index_operation",
      operation: "incremental",
      stage: "failed",
      error: projected,
    });
    expect(line).toContain("method=retrieve phase=validate");
    expect(line).toContain("location=run@worker.mjs:9:3");
    const unsafe = projectDiagnosticError({
      name: "SqliteProtocolError",
      error: {
        code: "internal",
        message: "bad",
        method: "SELECT * FROM notes",
        phase: "/Users/me/Private Note.md",
        debugLocation: "../../secret@worker.mjs:1:1",
      },
    });
    expect(unsafe.method).toBeUndefined();
    expect(unsafe.phase).toBeUndefined();
    expect(unsafe.debugLocation).toBeUndefined();
    expect(
      projectDiagnosticError({
        name: "SqliteProtocolError",
        error: { code: "internal", method: "applyLexicalBatch" },
      }).method
    ).toBe("applyLexicalBatch");
    expect(
      projectDiagnosticError({
        name: "SqliteProtocolError",
        error: { code: "internal", method: "hashMarkdown" },
      }).method
    ).toBeUndefined();
  });

  it("shows safe startup handshake build metadata in the collapsed log line", () => {
    const line = formatDiagnosticLogLine({
      area: "index",
      event: "index_operation",
      operation: "startup",
      stage: "completed",
      phase: "handshake",
      runtime: {
        expectedBuildId: "runtime-build-1",
        actualBuildId: "runtime-build-1",
        protocolVersion: 7,
        schemaVersion: 7,
      },
    });
    expect(line).toContain("expectedBuildId=runtime-build-1");
    expect(line).toContain("actualBuildId=runtime-build-1");
    expect(line).toContain("protocol=7 schema=7");
    const unsafe = formatDiagnosticLogLine({
      area: "index",
      event: "index_operation",
      operation: "startup",
      stage: "completed",
      phase: "handshake",
      runtime: {
        expectedBuildId: "/Users/me/My Vault/secret.md",
        actualBuildId: "a".repeat(200),
        protocolVersion: 7,
        schemaVersion: 7,
      },
    });
    expect(unsafe).not.toContain("secret.md");
    expect(unsafe).not.toContain("/Users/me");
  });
});
