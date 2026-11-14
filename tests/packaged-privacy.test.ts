import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import * as obsidian from "./obsidian";

// Exercise the shipped bundle, because host isolation is a build-time boundary.
describe("packaged privacy boundary", () => {
  it("ignores host tracing flags while retaining retrieval and configured model requests", async () => {
    const hostProcess = {
      versions: { node: "24.13.0" },
      env: {
        LANGSMITH_TRACING: "true",
        LANGSMITH_TRACING_V2: "true",
        LANGCHAIN_TRACING: "true",
        LANGCHAIN_TRACING_V2: "true",
        LANGSMITH_API_KEY: "fictional-key",
        LANGSMITH_ENDPOINT: "https://tracing.invalid",
      },
    };
    const originalEnvironment = { ...hostProcess.env };
    const fetch = vi.fn(async (_input: string | Request | URL, _init?: RequestInit) =>
      Response.json({
        id: "resp_test",
        object: "response",
        status: "completed",
        output: [
          {
            id: "msg_test",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ready", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    );
    const module = { exports: {} as any };
    const info = vi.fn();
    runInNewContext(readFileSync(new URL("../main.js", import.meta.url), "utf8"), {
      module,
      exports: module.exports,
      require: (name: string) => {
        if (name !== "obsidian") throw new Error(`Unexpected runtime dependency: ${name}`);
        return obsidian;
      },
      process: hostProcess,
      fetch,
      console: { ...console, info },
      crypto: globalThis.crypto,
      performance,
      TextEncoder,
      TextDecoder,
      AbortController,
      AbortSignal,
      DOMException,
      URL,
      URLSearchParams,
      FormData,
      Blob,
      Request,
      Response,
      Headers,
      ReadableStream,
      TransformStream,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
      atob,
      btoa,
    });
    const plugin = new module.exports.default();
    plugin.settingsStore.load({
      consoleDebug: true,
      chat: {
        endpoint: "http://127.0.0.1:1234/v1",
        modelId: "local-chat",
      },
    });
    const listeners = new Set<(event: any) => void>();
    plugin.sqliteRuntime.resolveNamespace = async () => "a".repeat(64);
    plugin.sqliteRuntime.createWorker = () => ({
      addEventListener: (type: string, listener: (event: any) => void) => {
        if (type === "message") listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: any) => void) =>
        listeners.delete(listener),
      postMessage: (request: any) =>
        queueMicrotask(() => {
          const result =
            request.method === "noteStoreHasNotes"
              ? false
              : request.method === "noteStoreHybrid"
                ? { hits: [], mode: "lexical", degraded: false }
                : undefined;
          for (const listener of listeners)
            listener({ data: { id: request.id, ok: true, result } });
        }),
      terminate() {},
    });
    try {
      await plugin.configureServices({ vault: { configDir: ".obsidian" } });
      const result = await plugin.retrieval.searchCandidates({
        query: "private query",
        mode: "lexical",
      });
      expect(result.hits).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      const response = await plugin.getOrCreateSession().model.invoke("fictional prompt");
      expect(response.text).toBe("ready");
      // A pending telemetry batch must not escape after the foreground request.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(fetch).toHaveBeenCalledOnce();
      expect(String(fetch.mock.calls[0][0])).toBe("http://127.0.0.1:1234/v1/responses");
      expect(info.mock.calls.some(([label]) => label === "[Trama] Local trace")).toBe(true);
      expect(hostProcess.env).toEqual(originalEnvironment);
    } finally {
      await plugin.client?.close();
    }
  });
});
