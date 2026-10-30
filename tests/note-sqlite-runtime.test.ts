import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteSqliteRuntime } from "@/plugin/NoteSqliteRuntime";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("embedded SQLite worker lifetime", () => {
  it("starts from embedded code and releases its URL when terminated", async () => {
    const terminate = vi.fn();
    const constructor = vi.fn(function () {
      return { terminate };
    });
    vi.stubGlobal("Worker", constructor);
    const worker = new NoteSqliteRuntime().createWorker();
    const [url, options] = constructor.mock.calls[0] as unknown as [string, WorkerOptions];
    expect(options).toEqual({ type: "module" });
    expect(url).toMatch(/^blob:/);
    const code = await fetch(url).then((response) => response.text());
    expect(code).toContain("sqlite3ApiBootstrap");
    expect(code).toContain("trama-note-v2-");
    worker.terminate!();
    expect(terminate).toHaveBeenCalledOnce();
    await expect(fetch(url)).rejects.toThrow();
  });

  it("releases its URL if worker construction fails", async () => {
    const create = vi.spyOn(URL, "createObjectURL");
    vi.stubGlobal(
      "Worker",
      vi.fn(function () {
        throw new Error("Worker blocked");
      })
    );
    expect(() => new NoteSqliteRuntime().createWorker()).toThrow("Worker blocked");
    await expect(fetch(create.mock.results[0].value)).rejects.toThrow();
  });
});
