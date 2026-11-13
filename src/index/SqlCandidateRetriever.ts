import { Document } from "@langchain/core/documents";
import { BaseRetriever } from "@langchain/core/retrievers";
import type { VaultSearchCandidates } from "./VaultRetrieval";

/** Request-scoped adapter; the SQL operation remains the source of ranking. */
export class SqlCandidateRetriever extends BaseRetriever {
  lc_namespace = ["trama", "retrievers"];
  constructor(private readonly search: () => Promise<VaultSearchCandidates>) {
    super();
  }

  async _getRelevantDocuments(): Promise<Document[]> {
    const batch = await this.search();
    return batch.hits.map(
      (hit) =>
        new Document({
          id: hit.path,
          pageContent: hit.path,
          metadata: { hit, status: batch.status },
        })
    );
  }
}
