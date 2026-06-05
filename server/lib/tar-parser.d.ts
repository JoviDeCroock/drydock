export interface ParsedFile {
  path: string;
  size: number;
  sha256: string;
  flags: string[];
  textSample?: string;
  scanText?: string;
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
  optionalDependencies?: Record<string, string>;
  files?: string[];
  bin?: unknown;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
}

export type TarSuspiciousEntryKind = "non-regular" | "duplicate" | "unicode-confusable";

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
export function decodeScanText(bytes: Uint8Array): string;
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
export function normalizeTarPath(rawPath: string | null | undefined): string | null;
export function normalizeZipPath(rawPath: string | null | undefined): string | null;
export function parsePax(body: Uint8Array): Record<string, string>;
export function describeNonRegularType(type: string): string;
export function sha256Hex(bytes: Uint8Array): Promise<string>;
export function shouldSkipTextSample(path: string): boolean;
export function summarizeFile(
  path: string,
  body: Uint8Array,
  maxBytesPerFile: number,
): Promise<ParsedFile>;
export function readTar(
  buffer: ArrayBuffer | Uint8Array,
  maxFiles: number,
  maxBytesPerFile: number,
  maxTarBytes: number,
): Promise<ReadTarResult>;
export function readUint16Le(bytes: Uint8Array, offset: number): number;
export function readUint32Le(bytes: Uint8Array, offset: number): number;
export function findZipEndOfCentralDirectory(bytes: Uint8Array): number;
export function inflateRawBounded(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array>;
export function readZipArchive(
  buffer: ArrayBuffer | Uint8Array,
  maxFiles: number,
  maxBytesPerFile: number,
  maxArchiveBytes: number,
): Promise<ParsedFile[]>;
export function readStreamBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array>;
export function parsePackageJson(files: ParsedFile[]): ParsedPackageJson | null;
export function gunzipBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<ArrayBuffer>;
