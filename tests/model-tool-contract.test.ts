import { describe, expect, it, vi } from "vitest";
import { ChatSession } from "@/chat/ChatSession";
import { StructuredError } from "@/domain/errors";
import { VaultRetrieval } from "@/index/VaultRetrieval";
import { createLocalChatModel } from "@/model/LocalModels";
import { createVaultTools } from "@/tools/VaultTools";

// Exercise the serialized provider boundary, not just native LangChain messages.
function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id: `fc_${id}`,
    type: "function_call",
    status: "completed",
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  };
}

function responseStream(id: string, output: Record<string, any>[]) {
  const events = [
    {
      type: "response.created",
      response: { id, model: "compatible-model", status: "in_progress" },
    },
    ...output.flatMap<Record<string, any>>((item, output_index) => {
      if (item.type === "message")
        return [
          {
            type: "response.output_text.delta",
            output_index,
            content_index: 0,
            delta: item.content[0].text,
          },
        ];
      if (item.type !== "function_call") return [];
      const midpoint = Math.floor(item.arguments.length / 2);
      return [
        {
          type: "response.output_item.added",
          output_index,
          item: { ...item, arguments: "", status: "in_progress" },
        },
        ...[item.arguments.slice(0, midpoint), item.arguments.slice(midpoint)].map((delta) => ({
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index,
          delta,
        })),
        { type: "response.output_item.done", output_index, item },
      ];
    }),
    {
      type: "response.completed",
      response: {
        id,
        object: "response",
        model: "compatible-model",
        status: "completed",
        output,
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}

describe("OpenAI-compatible tool contract", () => {
  it.each([
    ["unknown tool", "unavailable_tool", { path: "Private.md" }],
    ["invalid arguments", "read_notes", { paths: ["Private.md"], unexpected: true }],
  ])(
    "returns a matched, recoverable result for %s without reading notes",
    async (_label, name, args) => {
      const requests: Record<string, any>[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        requests.push(
          JSON.parse(input instanceof Request ? await input.clone().text() : String(init?.body))
        );
        return responseStream(
          `resp_${requests.length}`,
          requests.length === 1
            ? [toolCall("invalid", String(name), args as Record<string, unknown>)]
            : [
                {
                  id: "msg_recovered",
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [
                    { type: "output_text", text: "Cannot read that source.", annotations: [] },
                  ],
                },
              ]
        );
      };
      const vault = {
        readNote: vi.fn(async (path: string) => ({ path, content: "Must not be read" })),
        discoverLinks: async () => [],
        resolveLink: async () => null,
      };
      const retrieval = new VaultRetrieval(
        async () => ({ hits: [], mode: "lexical", degraded: false }),
        undefined,
        undefined,
        async () => null
      );
      const session = new ChatSession(
        createLocalChatModel(
          { endpoint: "http://localhost:1234/v1", modelId: "compatible-model", temperature: 0.2 },
          fetcher
        ),
        () => createVaultTools(vault, retrieval),
        vault
      );
      const state = await session.send({ content: "Read a note", attachmentPaths: [] });
      expect(state.error).toBeUndefined();
      expect(state.turns.at(-1)).toMatchObject({ status: "complete", sources: [] });
      expect(vault.readNote).not.toHaveBeenCalled();
      expect(requests).toHaveLength(2);
      const outputs = requests[1].input.filter((item: any) => item.type === "function_call_output");
      expect(outputs).toEqual([
        { type: "function_call_output", call_id: "invalid", output: expect.any(String) },
      ]);
      expect(outputs[0].output).toMatch(/error|Error/);
    }
  );

  it("preserves schemas, call IDs, partial failures and link results across parallel tool rounds", async () => {
    const requests: Record<string, any>[] = [];
    const batches = [
      [
        toolCall("links", "discover_links", { path: "Weekly.md" }),
        toolCall("principles", "read_notes", { paths: ["Principi.md", "Missing.md"] }),
      ],
      [
        toolCall("daily", "read_notes", {
          paths: ["[[Giorno#Attività|Lunedì]]"],
          sourcePath: "Weekly.md",
        }),
        toolCall("missing-links", "discover_links", { path: "Missing.md" }),
      ],
      [
        {
          id: "msg_answer",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Review completa.", annotations: [] }],
        },
      ],
    ];
    const fetcher: typeof fetch = async (input, init) => {
      expect(input instanceof Request ? input.url : String(input)).toBe(
        "http://localhost:1234/v1/responses"
      );
      const body = JSON.parse(
        input instanceof Request ? await input.clone().text() : String(init?.body)
      );
      requests.push(body);
      expect(requests.length).toBeLessThanOrEqual(batches.length);
      return responseStream(`resp_${requests.length}`, batches[requests.length - 1]);
    };
    const vault = {
      readNote: vi.fn(async (path: string) => {
        if (path === "Missing.md") throw new StructuredError("unavailable", "Note missing", false);
        return { path, content: `Contenuto di ${path}` };
      }),
      discoverLinks: vi.fn(async (path: string) => {
        if (path === "Missing.md") throw new StructuredError("unavailable", "Note missing", false);
        return [{ sourcePath: path, link: "Giorno#Attività", targetPath: "Journal/Giorno.md" }];
      }),
      resolveLink: vi.fn(async () => "Journal/Giorno.md"),
    };
    const retrieval = new VaultRetrieval(
      async () => ({ hits: [], mode: "lexical", degraded: false }),
      undefined,
      undefined,
      async () => null
    );
    const session = new ChatSession(
      createLocalChatModel(
        { endpoint: "http://localhost:1234/v1", modelId: "compatible-model", temperature: 0.2 },
        fetcher
      ),
      () => createVaultTools(vault, retrieval),
      vault
    );
    const skill = "Usare solo i link diretti e [[Principi]]. Non cercare altre note.";
    const state = await session.send({
      content: "Review settimanale",
      attachmentPaths: ["Weekly.md"],
      skill: { path: "Skills/Review.md", content: skill },
    });

    expect(state.error).toBeUndefined();
    expect(state.turns.at(-1)).toMatchObject({ status: "complete", content: "Review completa." });
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request).toMatchObject({ store: false });
      // Keep optional fields genuinely optional on servers without strict decoding.
      for (const tool of request.tools) {
        expect(tool).toMatchObject({
          type: "function",
          strict: false,
          parameters: { type: "object", additionalProperties: false },
        });
        for (const property of Object.values(tool.parameters.properties) as any[])
          expect(property.description).toEqual(expect.any(String));
        if (tool.name === "read_notes") expect(tool.parameters.required).toEqual(["paths"]);
        if (tool.name === "discover_links") expect(tool.parameters.required).toEqual(["path"]);
      }
      expect(JSON.stringify(request.input.filter((item: any) => item.role === "user"))).toContain(
        skill
      );
      const calls = request.input.filter((item: any) => item.type === "function_call");
      const results = request.input.filter((item: any) => item.type === "function_call_output");
      expect(results.map((item: any) => item.call_id).sort()).toEqual(
        calls.map((item: any) => item.call_id).sort()
      );
      expect(new Set(results.map((item: any) => item.call_id)).size).toBe(results.length);
      for (const result of results) {
        expect(typeof result.output).toBe("string");
        expect(JSON.parse(result.output)).toHaveProperty("ok");
        expect(JSON.parse(result.output)).not.toHaveProperty("provenance");
      }
    }
    const results = new Map(
      requests[2].input
        .filter((item: any) => item.type === "function_call_output")
        .map((item: any) => [item.call_id, JSON.parse(item.output)])
    );
    expect(results.get("links")).toMatchObject({
      ok: true,
      data: { links: [{ targetPath: "Journal/Giorno.md" }], truncated: false },
    });
    expect(results.get("principles")).toMatchObject({
      ok: true,
      data: {
        results: [
          { note: { path: "Principi.md" } },
          { requestedPath: "Missing.md", error: { code: "unavailable" } },
        ],
      },
    });
    expect(results.get("missing-links")).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: false },
    });
    expect(results.get("daily")).toMatchObject({
      ok: true,
      data: { results: [{ note: { path: "Journal/Giorno.md" } }] },
    });
    expect(vault.resolveLink).toHaveBeenCalledWith(
      "[[Giorno#Attività|Lunedì]]",
      "Weekly.md",
      expect.any(AbortSignal)
    );
  });
});
