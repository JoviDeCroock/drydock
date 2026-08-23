export interface ParsedFile {
  path: string;
  size: number;
  sha256: string;
  flags: string[];
  textSample?: string;
}

export interface ParsedPackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  implicitScripts?: Record<string, string>;
  gypfile?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  bundleDependencies?: string[] | boolean;
  bundledDependencies?: string[] | boolean;
  files?: string[];
  bin?: unknown;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
}

export type TarSuspiciousEntryKind =
  | "non-regular"
  | "duplicate"
  | "unicode-confusable"
  | "content-skipped"
  | "retention-tier"
  | "parser-differential";

export function tarHeaderChecksum(header: Uint8Array): {
  computed: number;
  declared: number | null;
};

export function isRejectedTarNumber(header: Uint8Array, offset: number, length: number): boolean;

export interface TarSuspiciousEntry {
  kind: TarSuspiciousEntryKind;
  path: string;
  detail: string;
}

export interface ReadTarResult {
  files: ParsedFile[];
  suspicious: TarSuspiciousEntry[];
}

export function readString(bytes: Uint8Array, start: number, len: number): string;
export function decodeText(bytes: Uint8Array): string;
export function isPlainObject(value: unknown): value is Record<string, unknown>;
export function normalizeStringRecord(value: unknown): Record<string, string>;
export function normalizeStringList(value: unknown): string[];
export function canonicalizePath(path: unknown): string;
export function hasUnicodeConfusables(path: unknown): boolean;
export function isRootGypPath(path: unknown): boolean;
export function hasImplicitNodeGypInstall(
  files: Array<{ path?: unknown }> | unknown,
  packageJson: { scripts?: unknown; gypfile?: unknown } | null | undefined,
): boolean;
export function isSafePaxPath(value: unknown): boolean;
/** Strip depth the archive's consumer extracts with. See `normalizeTarPath`. */
export type TarRootStrip = "strip1" | "keep" | "package-prefix";
export function normalizeTarPath(
  rawPath: string | null | undefined,
  rootStrip?: TarRootStrip,
): string | null;
export function normalizeZipPath(rawPath: string | null | undefined): string | null;
export function parsePax(body: Uint8Array): Record<string, string>;
export function describeNonRegularType(type: string): string;
export function sha256Hex(bytes: Uint8Array): Promise<string>;

export interface Sha256Digester {
  update(chunk: Uint8Array): void | Promise<void>;
  finalize(): Promise<string>;
}
export function createSha256Digester(): Sha256Digester;
export function createDigester(algorithm: string): Sha256Digester;

export interface ArchiveDigestStream<T = string> {
  body: ReadableStream<Uint8Array>;
  /** Hex digest of the whole wire stream, or null when it could not be verified. */
  digest(): Promise<T | null>;
  /** Cancel the source without draining it when archive parsing failed. */
  abort(): Promise<void>;
}
export function digestArchiveStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  algorithm?: string,
): ArchiveDigestStream;
export function digestArchiveStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  algorithms: readonly string[],
): ArchiveDigestStream<Record<string, string>>;

export interface StreamCursor {
  fill(target: number): Promise<boolean>;
  take(count: number): Uint8Array;
  discard(
    count: number,
    sink?: (chunk: Uint8Array) => void | Promise<unknown>,
  ): Promise<boolean>;
  cancel(): void;
  consumed(): number;
}
export function createStreamCursor(
  body: ReadableStream<Uint8Array>,
  maxStreamBytes: number,
): StreamCursor;

export function shouldSkipTextSample(path: string): boolean;
export type NativeArtifactKind = "elf" | "macho" | "pe" | "wasm";
export function sniffNativeArtifact(
  bytes: Uint8Array | null | undefined,
): NativeArtifactKind | null;
export interface HeadCapture {
  update(chunk: Uint8Array): void;
  bytes(): Uint8Array;
}
export function createHeadCapture(limit: number): HeadCapture;
export function summarizeFile(
  path: string,
  body: Uint8Array,
  maxTextSampleChars?: number,
): Promise<ParsedFile>;
export function clipTextSample(text: string, limit: number): string;
export function summarizeSkippedFile(
  path: string,
  size: number,
  sha256?: string,
  head?: Uint8Array,
): ParsedFile;
export function isRetainedManifestPath(path: string | null | undefined): boolean;
export function isRootManifestPath(path: string | null | undefined): boolean;
export function tarError(message: string): Error & { tarSafety: true };
export function readTar(
  buffer: ArrayBuffer | Uint8Array,
  maxFiles: number,
  maxTarBytes: number,
  maxTextSampleChars?: number,
  rootStrip?: TarRootStrip,
): Promise<ReadTarResult>;
export function readTarStream(
  body: ReadableStream<Uint8Array> | null,
  maxFiles: number,
  maxTarBytes: number,
  maxStreamBytes: number,
  maxEntries?: number,
  maxTextSampleChars?: number,
  rootStrip?: TarRootStrip,
): Promise<ReadTarResult>;
export function readUint16Le(bytes: Uint8Array, offset: number): number;
export function readUint32Le(bytes: Uint8Array, offset: number): number;
export function findZipEndOfCentralDirectory(bytes: Uint8Array): number;
export function inflateRawBounded(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array>;
export function readZipArchive(
  buffer: ArrayBuffer | Uint8Array,
  maxFiles: number,
  maxArchiveBytes: number,
): Promise<ParsedFile[]>;
export function readZipArchiveBuffered(
  buffer: ArrayBuffer | Uint8Array,
  maxFiles: number,
  maxArchiveBytes: number,
  maxEntries?: number,
  maxTextSampleChars?: number,
): Promise<ReadTarResult>;
export function boundedByteStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array>;
export function pumpDeflatedZipEntry(
  cursor: StreamCursor,
  compressedSize: number,
  uncompressedSize: number,
  onChunk: (chunk: Uint8Array) => void | Promise<unknown>,
): Promise<void>;
export function digestSkippedZipEntry(
  cursor: StreamCursor,
  compressedSize: number,
  uncompressedSize: number,
  method: number,
): Promise<{ sha256: string; head: Uint8Array }>;
export function inflateRetainedZipEntry(
  cursor: StreamCursor,
  compressedSize: number,
  uncompressedSize: number,
): Promise<Uint8Array>;
export function readZipStream(
  body: ReadableStream<Uint8Array> | null,
  maxFiles: number,
  maxTarBytes: number,
  maxStreamBytes: number,
  maxEntries?: number,
  maxTextSampleChars?: number,
): Promise<ReadTarResult>;
export function readStreamBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array>;
export function parsePackageJson(files: ParsedFile[]): ParsedPackageJson | null;
export function normalizePeerDependenciesMeta(
  value: unknown,
): Record<string, { optional: boolean }>;
