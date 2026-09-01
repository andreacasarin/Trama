import { describe, expect, it } from "vitest";
import { EndpointPolicy } from "@/security/EndpointPolicy";

describe("EndpointPolicy module", () => {
  describe("EndpointPolicy", () => {
    describe("normalize()", () => {
      it("canonicalizes trusted loopback endpoints and rejects unsafe URL components", () => {
        const policy = new EndpointPolicy();
        expect(policy.normalize("HTTP://127.0.0.1:1234/v1/")).toBe("http://127.0.0.1:1234/v1");
        expect(policy.normalize("http://127.255.255.254:1234")).toBe(
          "http://127.255.255.254:1234/v1"
        );
        expect(policy.normalize("http://[::1]:1234")).toBe("http://[::1]:1234/v1");
        for (const endpoint of [
          "http://localhost:1234",
          "https://example.com",
          "http://service.internal:1234",
          "file:///tmp",
          "http://user:pass@127.0.0.1",
          "http://127.0.0.1/v1?x=1",
          "http://127.0.0.1/v1#x",
          "http://127.0.0.1/other",
        ]) {
          expect(() => policy.normalize(endpoint)).toThrow();
        }
      });
      it("requires approval bound to the exact scheme, host, and port", () => {
        const policy = new EndpointPolicy({
          approvals: [{ scheme: "http", host: "192.168.1.20", port: 1234 }],
        });
        expect(policy.normalize("http://192.168.1.20:1234")).toBe("http://192.168.1.20:1234/v1");
        expect(() => policy.normalize("https://192.168.1.20:1234")).toThrow();
        expect(() => policy.normalize("http://192.168.1.20:4321")).toThrow();
      });
    });
  });
});
