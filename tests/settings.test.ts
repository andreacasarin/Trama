import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  isExcludedPath,
  normalizeExcludedPath,
  normalizeExcludedPaths,
  SettingsStore,
} from "@/settings/Settings";

describe("Settings module", () => {
  describe("SettingsStore", () => {
    describe("load()", () => {
      it("uses immutable safe defaults for missing or incompatible persisted data", () => {
        const store = new SettingsStore();
        expect(store.load({ schemaVersion: 9 })).toBe(DEFAULT_SETTINGS);
        expect(Object.isFrozen(DEFAULT_SETTINGS.approvedOrigins)).toBe(true);
      });

      it("migrates v2 defaults with max tokens and reasoning in Auto state", () => {
        const store = new SettingsStore();
        const loaded = store.load({ schemaVersion: 2, chat: {}, embedding: {} });

        expect(loaded.schemaVersion).toBe(3);
        expect(loaded.chat.temperature).toBe(0.7);
        expect(loaded.chat).not.toHaveProperty("maxOutputTokens");
        expect(loaded.chat).not.toHaveProperty("reasoningEffort");
        expect(loaded.lente).toEqual({ searchMethod: "hybrid", maxResults: 20 });
        expect(loaded.filo).toEqual({ automaticUpdates: false, excludedPaths: [] });
        expect(loaded.detailedDebug).toBe(false);
      });

      it("sanitizes Lente and Filo settings while keeping defaults immutable", () => {
        const loaded = new SettingsStore().load({
          schemaVersion: 3,
          lente: { searchMethod: "keyword", maxResults: 35 },
          filo: {
            automaticUpdates: true,
            excludedPaths: [" ./Projects\\ ", "Projects", "private//notes/", "../outside", ""],
          },
        });

        expect(loaded.lente).toEqual({ searchMethod: "keyword", maxResults: 35 });
        expect(loaded.filo).toEqual({
          automaticUpdates: false,
          excludedPaths: ["Projects", "private/notes"],
        });
        expect(Object.isFrozen(DEFAULT_SETTINGS.lente)).toBe(true);
        expect(Object.isFrozen(DEFAULT_SETTINGS.filo)).toBe(true);
        expect(Object.isFrozen(DEFAULT_SETTINGS.filo.excludedPaths)).toBe(true);
      });

      it("falls back independently for invalid Lente settings", () => {
        const loaded = new SettingsStore().load({
          schemaVersion: 3,
          lente: { searchMethod: "semantic", maxResults: 21 },
        });
        expect(loaded.lente).toEqual(DEFAULT_SETTINGS.lente);
      });

      it("sanitizes detailed debugging independently while preserving v2 settings", () => {
        const persisted = {
          schemaVersion: 2,
          chat: {
            endpoint: "http://127.0.0.1:1234/v1",
            modelId: "chat-v1",
            temperature: 0.4,
            maxOutputTokens: 2048,
            reasoningEffort: "high",
          },
          embedding: {
            endpoint: "http://127.0.0.1:1234/v1",
            modelId: "embed-v1",
            dimensions: 1024,
            batchSize: 16,
          },
          approvedOrigins: [{ scheme: "http", host: "192.168.1.20", port: 1234 }],
          detailedDebug: "yes",
        };

        const loaded = new SettingsStore().load(persisted);

        expect(loaded).toMatchObject({
          chat: persisted.chat,
          embedding: persisted.embedding,
          approvedOrigins: persisted.approvedOrigins,
          detailedDebug: false,
        });
        expect(new SettingsStore().load({ ...persisted, detailedDebug: true })).toMatchObject({
          detailedDebug: true,
        });
      });

      it("ignores the removed detailedVoceDebug key without migration", () => {
        const loaded = new SettingsStore().load({
          schemaVersion: 2,
          detailedVoceDebug: true,
        });
        expect(loaded.detailedDebug).toBe(false);
        expect(loaded).not.toHaveProperty("detailedVoceDebug");
      });

      it("accepts exact v2 parameter boundaries and every reasoning effort", () => {
        for (const reasoningEffort of ["none", "low", "medium", "high"] as const) {
          const loaded = new SettingsStore().load({
            schemaVersion: 2,
            chat: { temperature: 0, maxOutputTokens: 131072, reasoningEffort },
          });
          expect(loaded.chat).toMatchObject({
            temperature: 0,
            maxOutputTokens: 131072,
            reasoningEffort,
          });
        }
        const loaded = new SettingsStore().load({ schemaVersion: 2, chat: { temperature: 1 } });
        expect(loaded.chat.temperature).toBe(1);
      });

      it("drops nonfinite, out-of-range, and invalid token values independently", () => {
        const store = new SettingsStore();
        for (const temperature of [
          undefined,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          -0.1,
          0.15,
          1.1,
        ]) {
          expect(store.load({ schemaVersion: 2, chat: { temperature } }).chat.temperature).toBe(
            0.7
          );
        }
        for (const maxOutputTokens of [0, 1023, 2049, 132096, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
          expect(
            store.load({ schemaVersion: 2, chat: { maxOutputTokens } }).chat
          ).not.toHaveProperty("maxOutputTokens");
        }
      });

      it("rejects pre-release data from older schema versions without migration", () => {
        const store = new SettingsStore();
        expect(store.load({ schemaVersion: 1, chat: { maxTokens: 4096 } })).toBe(DEFAULT_SETTINGS);
      });
    });
    describe("save()", () => {
      it("normalizes and persists independent chat and embedding endpoints", () => {
        const store = new SettingsStore();
        const settings = store.save({
          ...DEFAULT_SETTINGS,
          chat: { ...DEFAULT_SETTINGS.chat, endpoint: "http://127.0.0.1:1234" },
          embedding: { ...DEFAULT_SETTINGS.embedding, endpoint: "http://127.0.0.1:4321/v1" },
        });
        expect(settings.schemaVersion).toBe(3);
        expect(settings.chat.endpoint).toContain("/v1");
        expect(settings.embedding.endpoint).toContain("/v1");
        expect(settings.detailedDebug).toBe(false);
      });
      it("rejects invalid staged chat controls without silently clearing them", () => {
        const store = new SettingsStore();
        const before = store.get();
        const invalidValues = [
          { temperature: -0.1 },
          { temperature: 1.1 },
          { temperature: Number.NaN },
          { maxOutputTokens: 0 },
          { maxOutputTokens: 1023 },
          { maxOutputTokens: 2049 },
          { maxOutputTokens: 132096 },
          { maxOutputTokens: 1.5 },
          { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
          { reasoningEffort: "minimal" },
        ];

        for (const controls of invalidValues) {
          expect(() =>
            store.stage({
              ...DEFAULT_SETTINGS,
              chat: { ...DEFAULT_SETTINGS.chat, ...controls } as typeof DEFAULT_SETTINGS.chat,
            })
          ).toThrow();
          expect(store.get()).toBe(before);
        }
      });
      it("keeps valid controls and omits Auto values when staged", () => {
        const store = new SettingsStore();
        const staged = store.stage({
          ...DEFAULT_SETTINGS,
          chat: {
            ...DEFAULT_SETTINGS.chat,
            temperature: 0,
            maxOutputTokens: 131072,
            reasoningEffort: "none",
          },
        });
        expect(staged.chat).toMatchObject({
          temperature: 0,
          maxOutputTokens: 131072,
          reasoningEffort: "none",
        });

        const auto = store.stage({
          ...DEFAULT_SETTINGS,
          chat: {
            ...DEFAULT_SETTINGS.chat,
            maxOutputTokens: undefined,
            reasoningEffort: undefined,
          },
        });
        expect(auto.chat.temperature).toBe(0.7);
        expect(auto.chat).not.toHaveProperty("maxOutputTokens");
        expect(auto.chat).not.toHaveProperty("reasoningEffort");
      });
      it("accepts only discrete maximum-output-token boundaries on explicit Save", () => {
        const store = new SettingsStore();
        for (const maxOutputTokens of [1024, 65536, 131072]) {
          expect(
            store.stage({
              ...DEFAULT_SETTINGS,
              chat: { ...DEFAULT_SETTINGS.chat, maxOutputTokens },
            }).chat.maxOutputTokens
          ).toBe(maxOutputTokens);
        }
      });
      it("stages invalid endpoints without changing the committed snapshot", () => {
        const store = new SettingsStore();
        const before = store.get();
        expect(() =>
          store.stage({
            ...DEFAULT_SETTINGS,
            chat: { ...DEFAULT_SETTINGS.chat, endpoint: "ftp://invalid" },
          })
        ).toThrow();
        expect(store.get()).toBe(before);
      });
      it("normalizes and deduplicates approved origins", () => {
        const store = new SettingsStore();
        const settings = store.save({
          ...DEFAULT_SETTINGS,
          approvedOrigins: [
            { scheme: "http", host: "192.168.1.20", port: 1234 },
            { scheme: "http", host: "192.168.1.20", port: 1234 },
          ],
        });
        expect(settings.approvedOrigins).toEqual([
          { scheme: "http", host: "192.168.1.20", port: 1234 },
        ]);
      });
      it("round-trips approved IPv6 origins and keeps their configured endpoints valid", () => {
        for (const host of ["fc00::20", "fe80::20"]) {
          const store = new SettingsStore();
          const saved = store.save({
            ...DEFAULT_SETTINGS,
            chat: { ...DEFAULT_SETTINGS.chat, endpoint: `http://[${host}]:1234/v1` },
            embedding: { ...DEFAULT_SETTINGS.embedding, endpoint: `http://[${host}]:1234/v1` },
            approvedOrigins: [{ scheme: "http", host, port: 1234 }],
          });
          const loaded = new SettingsStore().load(JSON.parse(JSON.stringify(saved)));
          expect(loaded.approvedOrigins).toEqual([{ scheme: "http", host, port: 1234 }]);
          expect(loaded.chat.endpoint).toBe(`http://[${host}]:1234/v1`);
          expect(loaded.embedding.endpoint).toBe(`http://[${host}]:1234/v1`);
        }
      });

      it("validates Lente settings on explicit Save", () => {
        const store = new SettingsStore();
        expect(() =>
          store.stage({
            ...DEFAULT_SETTINGS,
            lente: { ...DEFAULT_SETTINGS.lente, maxResults: 21 },
          })
        ).toThrow();
        expect(() =>
          store.stage({
            ...DEFAULT_SETTINGS,
            lente: { ...DEFAULT_SETTINGS.lente, searchMethod: "semantic" as never },
          })
        ).toThrow();
      });

      it("normalizes and matches excluded files and directories purely", () => {
        expect(normalizeExcludedPath(" ./folder\\sub// ")).toBe("folder/sub");
        expect(normalizeExcludedPath("/folder")).toBeUndefined();
        expect(normalizeExcludedPath("folder/./note")).toBeUndefined();
        expect(normalizeExcludedPath("folder/../note")).toBeUndefined();
        expect(normalizeExcludedPath("C:\\folder")).toBeUndefined();
        expect(normalizeExcludedPath("folder\0note")).toBeUndefined();
        expect(normalizeExcludedPaths(["z", "a/", "./a", "z", "a//b"])).toEqual(["a", "a/b", "z"]);
        expect(isExcludedPath("folder/note.md", ["folder"])).toBe(true);
        expect(isExcludedPath("folder", ["folder"])).toBe(true);
        expect(isExcludedPath("folderish/note.md", ["folder"])).toBe(false);
        expect(isExcludedPath("Folder/note.md", ["folder"])).toBe(false);
      });
    });
  });
});
