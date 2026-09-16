import { describe, expect, it, vi } from "vitest";
import { TramaPlugin } from "@/plugin/TramaPlugin";

describe("SQLite publication plugin maintenance", () => {
  it("delegates publication retry and synchronized-file adoption", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.publicationManager = {
      retryPublication: vi.fn().mockResolvedValue({ published: true, publicationId: "local-1" }),
      adoptCurrent: vi.fn().mockResolvedValue({
        adopted: true,
        publicationId: "remote-1",
        state: { publicationId: "remote-1" },
      }),
    };
    plugin.index = { capabilities: () => ({}) };
    plugin.indexStatus = undefined;

    await expect(plugin.retryPublication()).resolves.toBeUndefined();
    await expect(plugin.checkPublication()).resolves.toBeUndefined();
    expect(plugin.publicationManager.retryPublication).toHaveBeenCalledTimes(1);
    expect(plugin.publicationManager.adoptCurrent).toHaveBeenCalledTimes(1);
  });

  it("does not adopt or publish when the synchronized file is absent", async () => {
    const plugin = new TramaPlugin(undefined as never, undefined as never) as any;
    plugin.publicationManager = {
      retryPublication: vi.fn(),
      adoptCurrent: vi.fn().mockResolvedValue({ adopted: false, ignored: "missing" }),
    };
    plugin.index = { capabilities: () => ({}) };
    plugin.indexStatus = undefined;

    await plugin.checkPublication();
    expect(plugin.publicationManager.adoptCurrent).toHaveBeenCalledTimes(1);
    expect(plugin.publicationManager.retryPublication).not.toHaveBeenCalled();
  });
});
