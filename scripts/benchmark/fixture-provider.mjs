import { createServer } from "node:http";
import { Buffer } from "node:buffer";

export function fixtureVector(text, vectorFor) {
  const keys = {
    'alpha OR beta "quoted" -tag NEAR/3 (unsafe)': "query:hostile",
    "anchor alpha": "query:semantic",
    "naïve café 東京": "query:unicode",
    tie: "fixed-tie",
    large: "query:large",
    "": "query:empty",
  };
  const key = Object.hasOwn(keys, text) ? keys[text] : text;
  return vectorFor(
    key,
    key === "fixed-tie" || /notes\/0000[45]\/note-[45]\.md/.test(text) ? "tie" : undefined
  );
}

/** Deterministic inputs at the HTTP boundary; Trama uses its normal provider adapters. */
export async function startFixtureProvider(runId, vectorFor) {
  const prefix = "/v1";
  const modelId = `trama-benchmark-fixture-${runId}`;
  const stats = { calls: 0, texts: 0 };
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (!request.url?.startsWith(`${prefix}/`)) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const json = (value) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(value));
    };
    try {
      if (request.method === "GET" && request.url === `${prefix}/benchmark-stats`) {
        json({ runId, ...stats });
        return;
      }
      if (request.method === "GET" && request.url === `${prefix}/models`) {
        json({ data: [{ id: modelId }] });
        return;
      }
      const chunks = [];
      let byteCount = 0;
      for await (const part of request) {
        byteCount += part.length;
        if (byteCount > 8_000_000) throw new Error("Fixture request too large.");
        chunks.push(part);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.method !== "POST" || input.model !== modelId)
        throw new Error("Invalid fixture request.");
      if (request.url === `${prefix}/embeddings`) {
        if (!Array.isArray(input.input) || input.input.some((text) => typeof text !== "string"))
          throw new Error("Invalid fixture texts.");
        stats.calls++;
        stats.texts += input.input.length;
        json({
          data: input.input.map((text, index) => ({
            index,
            embedding: Array.from(fixtureVector(text, vectorFor)),
          })),
        });
      } else if (request.url === `${prefix}/responses`) {
        const hasToolOutput = input.input?.some((item) => item.type === "function_call_output");
        const output = hasToolOutput
          ? [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "done" }],
              },
            ]
          : [
              {
                type: "function_call",
                call_id: "search",
                name: "vault_search",
                arguments: JSON.stringify({ query: 'alpha OR beta "quoted" -tag NEAR/3 (unsafe)' }),
              },
            ];
        response.setHeader("Content-Type", "text/event-stream");
        response.end(
          `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output } })}\n\n`
        );
      } else response.writeHead(404).end();
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}${prefix}`,
    modelId,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
