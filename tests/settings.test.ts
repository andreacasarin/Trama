import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsStore } from "@/settings/Settings";

describe("Settings module", () => {
  describe("SettingsStore", () => {
    describe("load()", () => {
      it("uses immutable safe defaults for missing or incompatible persisted data", () => {
        const store = new SettingsStore();
        expect(store.load({ schemaVersion: 9 })).toBe(DEFAULT_SETTINGS);
        expect(Object.isFrozen(DEFAULT_SETTINGS.approvedOrigins)).toBe(true);
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
        expect(settings.schemaVersion).toBe(1);
        expect(settings.chat.endpoint).toContain("/v1");
        expect(settings.embedding.endpoint).toContain("/v1");
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
    });
  });
});
