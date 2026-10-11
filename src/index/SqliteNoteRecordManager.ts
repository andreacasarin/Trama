import type {
  ListKeyOptions,
  RecordManagerInterface,
  UpdateOptions,
} from "@langchain/core/indexing";
import type { NoteStoreCall } from "./note-sqlite/protocol";

export class SqliteNoteRecordManager implements RecordManagerInterface {
  constructor(
    private readonly call: NoteStoreCall,
    private readonly fixedTime?: number,
    private readonly signal?: AbortSignal
  ) {}

  forRun(time: number, signal?: AbortSignal): SqliteNoteRecordManager {
    return new SqliteNoteRecordManager(this.call, time, signal);
  }

  async createSchema(): Promise<void> {}

  async getTime(signal = this.signal): Promise<number> {
    if (this.fixedTime !== undefined) return this.fixedTime;
    return (await this.call("recordManagerGetTime", {}, signal)) as number;
  }

  async update(keys: string[], options: UpdateOptions): Promise<void> {
    await this.call("recordManagerUpdate", { keys, ...options }, this.signal);
  }

  async exists(keys: string[]): Promise<boolean[]> {
    return (await this.call("recordManagerExists", { keys }, this.signal)) as boolean[];
  }

  async listKeys(options: ListKeyOptions): Promise<string[]> {
    return (await this.call(
      "recordManagerListKeys",
      { ...options, limit: options.limit ?? 1000 },
      this.signal
    )) as string[];
  }

  async deleteKeys(keys: string[]): Promise<void> {
    await this.call("recordManagerDeleteKeys", { keys }, this.signal);
  }
}
