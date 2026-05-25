import type { DiffEntry } from "../../server/lib/review";
import { Badge, type BadgeTone, statusTone } from "./Badge";
import { cn } from "./cn";
import { EmptyLine } from "./Typography";

type FileStatus = "added" | "removed" | "modified" | "unchanged";
type FolderStatus = FileStatus | "mixed";

interface FileNode {
  kind: "file";
  name: string;
  path: string;
  status: FileStatus;
}

interface FolderNode {
  kind: "folder";
  name: string;
  path: string;
  status: FolderStatus;
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

function buildTree(entries: DiffEntry[]): Array<FileNode | FolderNode> {
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
    parent.push({
      kind: "file",
      name: segments[segments.length - 1],
      path: entry.path,
      status: entry.status as FileStatus,
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
      }
    }
  };
  finalize(root);
  return root;
}

function statusToTone(status: FolderStatus): BadgeTone {
  return statusTone(status);
}

function statusToText(status: FolderStatus): string {
  if (status === "mixed") return "text-accent";
  if (status === "added") return "text-ok";
  if (status === "removed") return "text-danger";
  if (status === "modified") return "text-warn";
  return "text-ink-muted";
}

const INDENT_BASE = 8;
const INDENT_PER_DEPTH = 20;

function rowPaddingLeft(depth: number): string {
  return `${INDENT_BASE + depth * INDENT_PER_DEPTH}px`;
}

export function FileTree({
  entries,
  selectedPath,
  onSelect,
}: {
  entries: DiffEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const tree = buildTree(entries);
  if (!tree.length) {
    return (
      <div class="px-4 py-3">
        <EmptyLine>No files.</EmptyLine>
      </div>
    );
  }
  return (
    <ul class="list-none p-0 m-0">
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: FileNode | FolderNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (node.kind === "folder") {
    const initiallyOpen = node.status !== "unchanged" && depth < 2;
    return (
      <li class="m-0">
        <details open={initiallyOpen} class="group">
          <summary
            class={cn(
              "list-none cursor-pointer flex items-center gap-2 py-1 pr-2 rounded hover:bg-surface-2",
              "text-[13px] font-mono",
            )}
            style={{ paddingLeft: rowPaddingLeft(depth) }}
          >
            <span
              aria-hidden
              class="text-ink-subtle text-[10px] inline-block transition-transform duration-150 ease-out group-open:rotate-90"
            >
              ▸
            </span>
            <span class={cn("flex-1 truncate", statusToText(node.status))}>{node.name}/</span>
            {node.status !== "unchanged" ? (
              <Badge tone={statusToTone(node.status)}>{node.status}</Badge>
            ) : null}
          </summary>
          <ul class="list-none p-0 m-0">
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </details>
      </li>
    );
  }

  const isSelected = selectedPath === node.path;
  return (
    <li class="m-0">
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        class={cn(
          "w-full flex items-center gap-2 py-1 pr-2 rounded text-left transition-colors",
          "text-[13px] font-mono",
          isSelected ? "bg-surface-2 text-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink",
        )}
        style={{ paddingLeft: rowPaddingLeft(depth) }}
      >
        <span class={cn("flex-1 truncate", isSelected ? "text-ink" : statusToText(node.status))}>
          {node.name}
        </span>
        {node.status !== "unchanged" ? (
          <Badge tone={statusToTone(node.status)}>{node.status}</Badge>
        ) : null}
      </button>
    </li>
  );
}
