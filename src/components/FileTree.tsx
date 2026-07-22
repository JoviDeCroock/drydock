import { useMemo, useRef } from "preact/hooks";
import type { DiffEntry } from "../../server/lib/review";
import { Badge, severityTone } from "./Badge";
import { cn } from "./cn";
import {
  buildTree,
  type FileNode,
  type FindingCountMap,
  type FolderNode,
  type FolderStatus,
} from "./file-tree-model";
import { EmptyLine } from "./Typography";

function statusToText(status: FolderStatus): string {
  if (status === "mixed") return "text-accent";
  if (status === "added") return "text-ok-text";
  if (status === "removed") return "text-danger-text";
  if (status === "modified") return "text-warn-text";
  return "text-ink-muted";
}

function StatusLabel({ status }: { status: FolderStatus }) {
  if (status === "unchanged") return null;
  return <span class="sr-only">{` (${status})`}</span>;
}

function TreeIndent({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, index) => (
        // 12px spacer + the row's 8px flex gap = the 20px-per-depth indent
        // DESIGN.md specs; a 20px spacer would compound to 28px per level.
        <span key={index} class="w-3 shrink-0" aria-hidden />
      ))}
    </>
  );
}

// A path can legally appear as both a file and a directory prefix in a hostile
// tarball, producing sibling nodes with identical paths — the kind prefix
// keeps their render keys distinct.
function nodeKey(node: FileNode | FolderNode): string {
  return `${node.kind}:${node.path}`;
}

function FindingCountBadge({ count, severity }: { count: number; severity: string | null }) {
  if (count <= 0) return null;
  const label = `${count} ${count === 1 ? "finding" : "findings"}`;
  return (
    <span class="shrink-0" title={label} aria-label={label}>
      <Badge tone={severityTone(severity ?? "info")}>{count}</Badge>
    </span>
  );
}

export function FileTree({
  entries,
  selectedPath,
  onSelect,
  findingCounts,
}: {
  entries: DiffEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  findingCounts?: FindingCountMap;
}) {
  // Two localeCompare sorts over every entry — memoized so rerenders that
  // keep the same entries array (selection changes, finding arrivals) don't
  // re-sort a megabyte-scale package's tree. Filtering produces a fresh
  // array, so filter keystrokes still rebuild — that's inherent to the input.
  const tree = useMemo(() => buildTree(entries, findingCounts), [entries, findingCounts]);
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
          key={nodeKey(node)}
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
    return (
      <FolderTreeNode node={node} depth={depth} selectedPath={selectedPath} onSelect={onSelect} />
    );
  }

  const isSelected = selectedPath === node.path;
  return (
    <li class="m-0">
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        aria-pressed={isSelected}
        class={cn(
          "w-full flex items-center gap-2 py-1 pr-2 pl-2 rounded text-left transition-colors",
          "text-[13px] font-mono",
          isSelected ? "bg-surface-2 text-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink",
        )}
      >
        <TreeIndent depth={depth} />
        <span
          class={cn("flex-1 truncate", isSelected ? "text-ink" : statusToText(node.status))}
          title={node.name}
        >
          {node.name}
          <StatusLabel status={node.status} />
        </span>
        <FindingCountBadge count={node.findingCount} severity={node.findingSeverity} />
      </button>
    </li>
  );
}

function FolderTreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  // Frozen at mount: re-applying a recomputed value as a live `open` prop
  // would clobber the user's manual folder toggles whenever the aggregate
  // status changes (e.g. switching compare versions while the tree stays
  // mounted). Deliberate cost: a folder that only becomes "changed" in a
  // later comparison keeps its first frozen default — the accent name color
  // and finding badge still flag it on the collapsed row, and surfaces that
  // want fresh defaults remount the tree (the /diff page keys per version
  // pair).
  const initiallyOpen = useRef(node.status !== "unchanged" && depth < 2).current;
  return (
    <li class="m-0">
      <details open={initiallyOpen} class="group">
        <summary
          class={cn(
            "list-none cursor-pointer flex items-center gap-2 py-1 pr-2 pl-2 rounded hover:bg-surface-2",
            "text-[13px] font-mono",
          )}
        >
          <TreeIndent depth={depth} />
          <span
            aria-hidden
            class="text-ink-subtle text-[10px] inline-block transition-transform duration-150 ease-out group-open:rotate-90"
          >
            ▸
          </span>
          <span class={cn("flex-1 truncate", statusToText(node.status))} title={`${node.name}/`}>
            {node.name}/
            <StatusLabel status={node.status} />
          </span>
          <FindingCountBadge count={node.findingCount} severity={node.findingSeverity} />
        </summary>
        <ul class="list-none p-0 m-0">
          {node.children.map((child) => (
            <TreeNode
              key={nodeKey(child)}
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
