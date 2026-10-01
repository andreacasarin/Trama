import { describe, expect, it } from "vitest";
import { ChatSession } from "@/chat/ChatSession";
import type { ChatModel } from "@/domain/contracts";
import { TramaTestWorld } from "./fixtures/trama-world";

const signal = new AbortController().signal;

describe("Trama feature journeys", () => {
  it("indexes the fixture and serves Lente, Filo, and Voce through their public contracts", async () => {
    const world = new TramaTestWorld();
    await world.build();

    // Lexical indexing is independent of AI. Semantic consumers remain gated
    // until the explicit, resumable preparation action is requested.
    expect(world.embedding.calls).toBe(0);
    expect((await world.filo.find("Atlas/Garden.md", signal)).results).toEqual([]);

    const keyword = await world.lente.search("garden", { searchMethod: "keyword" });
    expect(keyword.mode).toBe("lexical");
    expect(keyword.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "Atlas/Garden.md" })])
    );
    const withoutVectors = await world.lente.search("garden");
    expect(withoutVectors).toMatchObject({
      mode: "lexical",
      degraded: true,
      degradationReason: "semantic-unavailable",
    });
    await world.prepare();
    expect(world.embedding.calls).toBeGreaterThan(0);
    expect((await world.filo.find("Atlas/Garden.md", signal, 7, true)).results).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "Atlas/Seeds.md" })])
    );
    const voce = await world.tools.execute("vault_search", { query: "Tokyo" }, signal);
    expect(voce.ok).toBe(true);
    expect(voce.provenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "Unicode/東京.md" })])
    );
    const lente = await world.lente.search("Tokyo");
    expect(voce.provenance.map((hit) => hit.path)).toEqual(
      lente.canonicalResults?.slice(0, 7).map((hit) => hit.path)
    );
    expect(JSON.stringify(await world.index.search("garden", signal, 20))).not.toContain(
      "PRIVATE_FIXTURE_SENTINEL"
    );
  });

  it("converges add, modify, delete, and rename operations without unnecessary embeddings", async () => {
    const world = new TramaTestWorld();
    await world.build();
    const afterBuild = world.embedding.calls;
    expect(afterBuild).toBe(0);

    await world.index.synchronize(signal);
    expect(world.embedding.calls).toBe(afterBuild);

    world.vault.set("Inbox/New.md", "Alpha garden greenhouse notes.");
    await world.update();
    const afterAdd = world.embedding.calls;
    world.vault.set("Kitchen/Pasta.md", "Alpha garden herbs for pasta.");
    await world.update();
    expect(world.embedding.calls).toBe(afterAdd);
    await world.prepare();
    expect(world.embedding.calls).toBeGreaterThan(afterAdd);
    const afterModify = world.embedding.calls;

    world.vault.delete("Unicode/東京.md");
    await world.update();
    world.vault.rename("Atlas/Seeds.md", "Archive/Seeds.md");
    await world.update();
    expect(world.embedding.calls).toBe(afterModify);
    expect(
      (await world.index.search("Tokyo", signal, 20)).map((result) => result.path)
    ).not.toContain("Unicode/東京.md");
    expect((await world.lente.search("seeds", { searchMethod: "keyword" })).results).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "Archive/Seeds.md" })])
    );
  });

  it("runs a complete chat/tool turn and emits metadata-only terminal timings", async () => {
    const world = new TramaTestWorld();
    await world.build();
    let round = 0;
    const model: ChatModel = {
      complete: async () =>
        round++ === 0
          ? {
              message: {
                role: "assistant",
                content: "",
                toolCalls: [{ id: "search", name: "vault_search", arguments: { query: "garden" } }],
              },
              finishReason: "tool_calls",
            }
          : { message: { role: "assistant", content: "Found it." }, finishReason: "stop" },
    };
    const state = await new ChatSession(model, world.tools, world.vault, {
      enabled: () => true,
      emit: (record) => world.diagnostics.push(record),
    }).send({ content: "Find my garden notes", attachmentPaths: ["Atlas/Garden.md"] });

    expect(state.turns.at(-1)).toMatchObject({ content: "Found it.", status: "complete" });
    expect(state.turns.at(-1)).toMatchObject({
      provenance: expect.arrayContaining([expect.objectContaining({ path: "Atlas/Garden.md" })]),
    });
    const terminal = world.diagnostics.filter(
      (record) => "durationMs" in record && typeof record.durationMs === "number"
    );
    expect(terminal.length).toBeGreaterThan(0);
    expect(JSON.stringify(world.diagnostics)).not.toContain("PRIVATE_FIXTURE_SENTINEL");
  });
});
