import { describe, expect, it, vi } from "vitest";
import { TramaPlugin } from "@/plugin/TramaPlugin";

describe("SQLite publication plugin maintenance", () => {
  it("delegates synchronized-file adoption to the maintenance controller", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.maintenance = {
      checkPublication: vi.fn().mockResolvedValue({
        adopted: true,
        publicationId: "remote-1",
        state: { publicationId: "remote-1" },
      }),
    };
    plugin.index = { capabilities: () => ({}), isComplete: () => true, hasUsableIndex: () => true };
    plugin.indexStatus = undefined;

    await expect(plugin.checkPublication()).resolves.toBeUndefined();
    expect(plugin.maintenance.checkPublication).toHaveBeenCalledTimes(1);
  });

  it("does not adopt or publish when the synchronized file is absent", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.maintenance = {
      checkPublication: vi.fn().mockResolvedValue({ adopted: false, ignored: "missing" }),
    };
    plugin.index = { capabilities: () => ({}) };
    plugin.indexStatus = undefined;

    await plugin.checkPublication();
    expect(plugin.maintenance.checkPublication).toHaveBeenCalledTimes(1);
  });

  it("uses operation provenance for publication and Check warning wording", () => {
    const setPublicationWarning = vi.fn();
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.indexStatus = { setPublicationWarning };

    plugin.handlePublicationWarning(
      {
        phase: "inspect",
        message: "invalid SQLite file",
        error: new Error("invalid SQLite file"),
        retryable: false,
      },
      "check"
    );
    expect(setPublicationWarning).toHaveBeenLastCalledWith(
      "Synchronized index check failed: invalid SQLite file"
    );
    plugin.handlePublicationWarning(
      {
        phase: "adopt",
        message: "replace failed",
        error: new Error("replace failed"),
        retryable: true,
      },
      "check"
    );
    expect(setPublicationWarning).toHaveBeenLastCalledWith(
      "Synchronized index adoption failed: replace failed"
    );
    plugin.handlePublicationWarning(
      {
        phase: "inspect",
        message: "readback failed",
        error: new Error("readback failed"),
        retryable: true,
      },
      "publication"
    );
    expect(setPublicationWarning).toHaveBeenLastCalledWith(
      "Synchronized index adoption failed: replace failed"
    );
    plugin.clearPublicationWarning("check");
    expect(setPublicationWarning).toHaveBeenLastCalledWith(
      "Index saved locally, but publication failed: readback failed"
    );
  });

  it.each(["same-id", "missing"] as const)(
    "clears an adoption warning after a successful %s Check",
    async (ignored) => {
      const setPublicationWarning = vi.fn();
      const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
      const warning = {
        phase: "adopt",
        message: "replace failed",
        error: new Error("replace failed"),
        retryable: true,
      };
      plugin.indexStatus = { setPublicationWarning };
      plugin.index = {};
      plugin.maintenance = {
        checkPublication: vi
          .fn()
          .mockResolvedValueOnce({ warning })
          .mockResolvedValueOnce({ adopted: false, ignored }),
      };

      await plugin.checkPublication();
      await plugin.checkPublication();

      expect(setPublicationWarning).toHaveBeenNthCalledWith(
        1,
        "Synchronized index adoption failed: replace failed"
      );
      expect(setPublicationWarning).toHaveBeenNthCalledWith(2, undefined);
    }
  );

  it("keeps a publication warning after a successful Check", async () => {
    const setPublicationWarning = vi.fn();
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.indexStatus = { setPublicationWarning };
    plugin.index = {};
    plugin.maintenance = {
      checkPublication: vi.fn().mockResolvedValue({ adopted: false, ignored: "same-id" }),
    };
    plugin.handlePublicationWarning(
      {
        phase: "inspect",
        message: "readback failed",
        error: new Error("readback failed"),
        retryable: true,
      },
      "publication"
    );

    await plugin.checkPublication();

    expect(setPublicationWarning).toHaveBeenNthCalledWith(
      1,
      "Index saved locally, but publication failed: readback failed"
    );
    expect(setPublicationWarning).toHaveBeenCalledTimes(1);
  });
});
