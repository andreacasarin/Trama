import { sha256Hex } from "./Hash";
export const MANIFEST_SCHEMA = 3;
export const MANIFEST_VERSION = 1;
export const MANIFEST_PAGE_LIMIT = 2048;
export const MANIFEST_TARGET_SIZE = 4 * 1024 * 1024;
export const MANIFEST_MAX_SIZE = 8 * 1024 * 1024;
/** Keeps corrupt roots from driving unbounded page reads before validation completes. */
export const MANIFEST_PAGE_COUNT_LIMIT = 65_536;
export interface ManifestSegment {
  id: string;
  checksum: string;
  chunkCount: number;
  /** First note-global ordinal in this segment (required for newly written manifests). */
  firstOrdinal?: number;
  byteLength?: number;
}
export interface ManifestNote {
  path: string;
  contentId: string;
  chunkCount: number;
  segments: ManifestSegment[];
}
export interface ManifestPageDescriptor {
  index: number;
  checksum: string;
  noteCount: number;
}
export interface CorpusManifestRoot {
  schema: 3;
  version: 1;
  generationId: string;
  fingerprint: string;
  noteCount: number;
  pageCount: number;
  pages: ManifestPageDescriptor[];
  checksum: string;
}
export interface CorpusManifestPage {
  schema: 3;
  version: 1;
  generationId: string;
  page: number;
  notes: ManifestNote[];
  checksum: string;
}
export interface CorpusPointer {
  schema: 1;
  current: string;
  previous?: string;
}
function fail(message: string): never {
  throw new Error(`Invalid corpus manifest: ${message}`);
}
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return fail("unsupported value");
}
/** Locale-independent UTF-16 code-unit order used by persisted corpus data. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
function canonicalByteLength(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringByteLength(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value).length;
  if (Array.isArray(value))
    return (
      2 +
      Math.max(0, value.length - 1) +
      value.reduce((sum, item) => sum + canonicalByteLength(item), 0)
    );
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>).sort(compareCodeUnits);
    return (
      2 +
      Math.max(0, entries.length - 1) +
      entries.reduce(
        (sum, key) =>
          sum +
          jsonStringByteLength(key) +
          1 +
          canonicalByteLength((value as Record<string, unknown>)[key]),
        0
      )
    );
  }
  return fail("unsupported value");
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function noChecksum(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  delete copy.checksum;
  return copy;
}
function keys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("unknown fields");
}
function validateNotes(notes: readonly ManifestNote[]): void {
  let priorPath: string | undefined;
  for (const note of notes) {
    const escapesRoot =
      note.path === ".." ||
      note.path.startsWith("../") ||
      note.path.endsWith("/..") ||
      note.path.includes("/../");
    if (
      !note.path ||
      (priorPath !== undefined && compareCodeUnits(note.path, priorPath) <= 0) ||
      note.path.startsWith("/") ||
      escapesRoot
    )
      fail("notes must be sorted and paths unique");
    priorPath = note.path;
    if (!id(note.contentId) || !Number.isSafeInteger(note.chunkCount) || note.chunkCount < 0)
      fail("note identity/count");
    let total = 0;
    let priorSegment = "";
    for (const segment of note.segments) {
      if (
        !id(segment.id) ||
        !id(segment.checksum) ||
        (segment.firstOrdinal === undefined &&
          priorSegment !== "" &&
          compareCodeUnits(segment.id, priorSegment) <= 0) ||
        !Number.isSafeInteger(segment.chunkCount) ||
        segment.chunkCount < 1 ||
        (segment.firstOrdinal !== undefined &&
          (!Number.isSafeInteger(segment.firstOrdinal) || segment.firstOrdinal < 0)) ||
        (segment.byteLength !== undefined &&
          (!Number.isSafeInteger(segment.byteLength) || segment.byteLength < 128))
      )
        fail("segment descriptor");
      priorSegment = segment.id;
      if (segment.firstOrdinal !== undefined && segment.firstOrdinal !== total)
        fail("segments must preserve contiguous source order");
      total += segment.chunkCount;
    }
    if (total !== note.chunkCount) fail("segment count mismatch");
  }
}
function validatePage(page: CorpusManifestPage): void {
  keys(page, ["schema", "version", "generationId", "page", "notes", "checksum"]);
  if (
    page.schema !== 3 ||
    page.version !== 1 ||
    !id(page.generationId) ||
    !Number.isSafeInteger(page.page) ||
    page.page < 0 ||
    !Array.isArray(page.notes) ||
    page.notes.length > MANIFEST_PAGE_LIMIT ||
    !id(page.checksum)
  )
    fail("page schema");
  validateNotes(page.notes);
}
export async function encodeCorpusManifest(input: {
  fingerprint: string;
  generationId?: string;
  notes: readonly ManifestNote[];
}): Promise<{ root: CorpusManifestRoot; pages: CorpusManifestPage[]; pointer: CorpusPointer }> {
  if (!id(input.fingerprint)) fail("fingerprint must be SHA-256");
  const notes = [...input.notes].map((note) => ({
    ...note,
    segments: note.segments.map((segment) => ({ ...segment })),
  }));
  notes.sort((a, b) => compareCodeUnits(a.path, b.path));
  validateNotes(notes);
  const totals = {
    noteCount: notes.length,
    chunkCount: notes.reduce((n, x) => n + x.chunkCount, 0),
  };
  // Hash each bounded page independently. The generation identity only materializes
  // page digests, never a vault-wide JSON representation of every note/chunk.
  const pageNotes: ManifestNote[][] = [];
  let currentPage: ManifestNote[] = [];
  let currentNotesBytes = 0;
  const placeholderId = "0".repeat(64);
  const pageSize = (index: number, notesBytes: number, noteCount: number) =>
    canonicalByteLength({
      schema: MANIFEST_SCHEMA,
      version: MANIFEST_VERSION,
      generationId: placeholderId,
      page: index,
      notes: [],
      checksum: placeholderId,
    }) -
    2 +
    notesBytes +
    Math.max(0, noteCount - 1);
  for (const note of notes) {
    const noteBytes = canonicalByteLength(note);
    const singlePageBytes = pageSize(MANIFEST_PAGE_COUNT_LIMIT - 1, noteBytes, 1);
    if (singlePageBytes > MANIFEST_MAX_SIZE) fail("single note exceeds manifest page hard cap");
    const candidateBytes = pageSize(
      pageNotes.length,
      currentNotesBytes + noteBytes,
      currentPage.length + 1
    );
    if (
      currentPage.length > 0 &&
      (currentPage.length >= MANIFEST_PAGE_LIMIT || candidateBytes > MANIFEST_TARGET_SIZE)
    ) {
      pageNotes.push(currentPage);
      currentPage = [];
      currentNotesBytes = 0;
    }
    currentPage.push(note);
    currentNotesBytes += noteBytes;
  }
  if (currentPage.length > 0) pageNotes.push(currentPage);
  const pageIdentities: ManifestPageDescriptor[] = [];
  for (let index = 0; index < pageNotes.length; index++) {
    const boundedNotes = pageNotes[index];
    pageIdentities.push({
      index,
      checksum: await sha256Hex(
        canonical({
          schema: MANIFEST_SCHEMA,
          version: MANIFEST_VERSION,
          page: index,
          notes: boundedNotes,
        })
      ),
      noteCount: boundedNotes.length,
    });
  }
  const generationId =
    input.generationId ??
    (await sha256Hex(canonical({ fingerprint: input.fingerprint, totals, pages: pageIdentities })));
  if (!id(generationId)) fail("generation ID must be SHA-256");
  const pages: CorpusManifestPage[] = [];
  for (const boundedNotes of pageNotes) {
    const page: CorpusManifestPage = {
      schema: 3,
      version: 1,
      generationId,
      page: pages.length,
      notes: boundedNotes,
      checksum: "",
    };
    page.checksum = await sha256Hex(
      canonical(noChecksum(page as unknown as Record<string, unknown>))
    );
    pages.push(page);
  }
  const root: CorpusManifestRoot = {
    schema: 3,
    version: 1,
    generationId,
    fingerprint: input.fingerprint,
    noteCount: notes.length,
    pageCount: pages.length,
    pages: pages.map((page) => ({
      index: page.page,
      checksum: page.checksum,
      noteCount: page.notes.length,
    })),
    checksum: "",
  };
  root.checksum = await sha256Hex(
    canonical(noChecksum(root as unknown as Record<string, unknown>))
  );
  return { root, pages, pointer: { schema: 1, current: generationId } };
}
export function serializeManifest(
  value: CorpusManifestRoot | CorpusManifestPage | CorpusPointer
): string {
  const json = canonical(value);
  if (new TextEncoder().encode(json).byteLength > MANIFEST_MAX_SIZE)
    fail("manifest exceeds size cap");
  return json;
}
export async function decodeCorpusManifest(
  raw: string,
  rawPages: readonly string[] = []
): Promise<CorpusManifestRoot> {
  if (
    raw.length > MANIFEST_MAX_SIZE ||
    new TextEncoder().encode(raw).byteLength > MANIFEST_MAX_SIZE
  )
    fail("manifest exceeds size cap");
  let root: CorpusManifestRoot;
  try {
    root = JSON.parse(raw) as CorpusManifestRoot;
  } catch {
    fail("invalid JSON");
  }
  keys(root, [
    "schema",
    "version",
    "generationId",
    "fingerprint",
    "noteCount",
    "pageCount",
    "pages",
    "checksum",
  ]);
  if (
    root.schema !== 3 ||
    root.version !== 1 ||
    !id(root.generationId) ||
    !id(root.fingerprint) ||
    !id(root.checksum) ||
    !Number.isSafeInteger(root.noteCount) ||
    root.noteCount < 0 ||
    !Number.isSafeInteger(root.pageCount) ||
    root.pageCount < 0 ||
    root.pageCount > MANIFEST_PAGE_COUNT_LIMIT ||
    !Array.isArray(root.pages) ||
    root.pageCount !== root.pages.length ||
    root.noteCount > root.pageCount * MANIFEST_PAGE_LIMIT
  )
    fail("root schema/count");
  if (
    root.pages.some(
      (descriptor, index) =>
        descriptor.index !== index ||
        !id(descriptor.checksum) ||
        !Number.isSafeInteger(descriptor.noteCount) ||
        descriptor.noteCount < 0 ||
        descriptor.noteCount > MANIFEST_PAGE_LIMIT
    )
  )
    fail("page descriptors");
  if (
    (await sha256Hex(canonical(noChecksum(root as unknown as Record<string, unknown>)))) !==
    root.checksum
  )
    fail("root checksum");
  if (rawPages.length !== root.pageCount) return root;
  const pages: CorpusManifestPage[] = [];
  for (let i = 0; i < rawPages.length; i++) {
    if (
      rawPages[i].length > MANIFEST_MAX_SIZE ||
      new TextEncoder().encode(rawPages[i]).byteLength > MANIFEST_MAX_SIZE
    )
      fail("manifest exceeds size cap");
    let page: CorpusManifestPage;
    try {
      page = JSON.parse(rawPages[i]) as CorpusManifestPage;
    } catch {
      fail("invalid page JSON");
    }
    validatePage(page);
    if (
      page.page !== i ||
      page.generationId !== root.generationId ||
      page.checksum !== root.pages[i].checksum ||
      (await sha256Hex(canonical(noChecksum(page as unknown as Record<string, unknown>)))) !==
        page.checksum
    )
      fail("page cross-link/checksum");
    pages.push(page);
  }
  const all = pages.flatMap((page) => page.notes);
  if (
    all.length !== root.noteCount ||
    pages.reduce((sum, page) => sum + page.notes.length, 0) !==
      root.pages.reduce((sum, page) => sum + page.noteCount, 0)
  )
    fail("cross-linked note count");
  validateNotes(all);
  return root;
}
export function decodeCorpusPointer(raw: string): CorpusPointer {
  let value: CorpusPointer;
  try {
    value = JSON.parse(raw) as CorpusPointer;
  } catch {
    fail("invalid pointer JSON");
  }
  if (
    Object.keys(value).some((key) => !["schema", "current", "previous"].includes(key)) ||
    value.schema !== 1 ||
    !id(value.current) ||
    (value.previous !== undefined && !id(value.previous))
  )
    fail("pointer schema");
  return value;
}
export { canonical as canonicalManifestJson };
