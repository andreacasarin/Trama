import { describe, expect, it, vi } from "vitest";
import { TramaPlugin } from "@/plugin/TramaPlugin";

describe("SQLite snapshot plugin maintenance", () => {
  it("stops automatic work and delegates explicit export/import", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    const exported = {
      bytes: new ArrayBuffer(2),
      sha256: "a".repeat(64),
      size: 2,
      path: ".trama/sqlite/v1/snapshots/x.sqlite3",
      incomplete: true,
    };
    plugin.index = {
      exportSnapshot: vi.fn().mockResolvedValue(exported),
      importSnapshot: vi.fn().mockResolvedValue(undefined),
      hasUsableIndex: () => true,
    };
    plugin.stopAutomaticWork = vi.fn();
    await expect(plugin.exportSnapshot()).resolves.toEqual(exported);
    await plugin.importSnapshot(exported.bytes, exported.sha256);
    expect(plugin.stopAutomaticWork).toHaveBeenCalledTimes(2);
    expect(plugin.index.importSnapshot).toHaveBeenCalledWith({
      bytes: exported.bytes,
      sha256: exported.sha256,
    });
  });
});
