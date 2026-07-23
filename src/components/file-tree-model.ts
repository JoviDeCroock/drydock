import type { DiffEntry } from "../../server/lib/review";
import { maxSeverity } from "./diff-annotations";

// Pure tree model for FileTree. Kept JSX-free so the path nesting, status
// aggregation, and finding-count bubbling are unit-testable without rendering.

type FileStatus = "added" | "removed" | "modified" | "unchanged";
export type FolderStatus = FileStatus | "mixed";

// Per-file finding counts (count + highest severity for tone), keyed by path.
// Folder counts are the sum of descendant counts; folder tone is the max.
export type FindingCountMap = ReadonlyMap<string, { count: number; maxSeverity: string }>;

export interface FileNode {
  kind: "file";
  name: string;
  path: string;
  status: FileStatus;
  findingCount: number;
  findingSeverity: string | null;
}

export interface FolderNode {
  kind: "folder";
  name: string;
  path: string;
  status: FolderStatus;
  findingCount: number;
  findingSeverity: string | null;
  children: Array<FileNode | FolderNode>;
}

function aggregateStatus(children: Array<FileNode | FolderNode>): FolderStatus {
  if (!children.length) return "unchanged";
  const statuses = new Set<FolderStatus>();
  for (const child of children) statuses.add(child.status);
  if (statuses.size === 1) {
    const [only] = statuses;
    return only;
  }
  if (statuses.has("modified") || statuses.has("mixed")) return "mixed";
  if (statuses.has("added") && statuses.has("removed")) return "mixed";
  if (statuses.has("added") && statuses.has("unchanged")) return "mixed";
  if (statuses.has("removed") && statuses.has("unchanged")) return "mixed";
  return "mixed";
}

function aggregateFindings(children: Array<FileNode | FolderNode>): {
  count: number;
  severity: string | null;
} {
  let count = 0;
  let severity: string | null = null;
  for (const child of children) {
    count += child.findingCount;
    severity = maxSeverity(severity, child.findingSeverity);
  }
  return { count, severity };
}

export function buildTree(
  entries: DiffEntry[],
  findingCounts?: FindingCountMap,
): Array<FileNode | FolderNode> {
  const root: Array<FileNode | FolderNode> = [];
  const folders = new Map<string, FolderNode>();

  const getFolder = (segments: string[]): Array<FileNode | FolderNode> => {
    if (!segments.length) return root;
    const path = segments.join("/");
    const existing = folders.get(path);
    if (existing) return existing.children;
    const parent = getFolder(segments.slice(0, -1));
    const folder: FolderNode = {
      kind: "folder",
      name: segments[segments.length - 1],
      path,
      status: "unchanged",
      findingCount: 0,
      findingSeverity: null,
      children: [],
    };
    folders.set(path, folder);
    parent.push(folder);
    return folder.children;
  };

  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const segments = entry.path.split("/").filter(Boolean);
    if (!segments.length) continue;
    const folderPath = segments.slice(0, -1);
    const parent = getFolder(folderPath);
    const fileFindings = findingCounts?.get(entry.path);
    parent.push({
      kind: "file",
      name: segments[segments.length - 1],
      path: entry.path,
      status: entry.status as FileStatus,
      findingCount: fileFindings?.count ?? 0,
      findingSeverity: fileFindings?.maxSeverity ?? null,
    });
  }

  const finalize = (nodes: Array<FileNode | FolderNode>) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.kind === "folder") {
        finalize(node.children);
        node.status = aggregateStatus(node.children);
        const findings = aggregateFindings(node.children);
        node.findingCount = findings.count;
        node.findingSeverity = findings.severity;
      }
    }
  };
  finalize(root);
  return root;
}
