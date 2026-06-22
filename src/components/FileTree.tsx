import type { DiffEntry } from "../../server/lib/review";
import { Badge, type BadgeTone, severityTone, statusTone } from "./Badge";
import { cn } from "./cn";
import {
  buildTree,
  type FileNode,
  type FindingCountMap,
  type FolderNode,
  type FolderStatus,
} from "./file-tree-model";
import { EmptyLine } from "./Typography";

function statusToTone(status: FolderStatus): BadgeTone {
  return statusTone(status);
}

function statusToText(status: FolderStatus): string {
  if (status === "mixed") return "text-accent";
  if (status === "added") return "text-ok-text";
  if (status === "removed") return "text-danger-text";
  if (status === "modified") return "text-warn-text";
  return "text-ink-muted";
}

function TreeIndent({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, index) => (
        <span key={index} class="w-5 shrink-0" aria-hidden />
      ))}
    </>
  );
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
  const tree = buildTree(entries, findingCounts);
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
            <span class={cn("flex-1 truncate", statusToText(node.status))}>{node.name}/</span>
            <FindingCountBadge count={node.findingCount} severity={node.findingSeverity} />
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
          "w-full flex items-center gap-2 py-1 pr-2 pl-2 rounded text-left transition-colors",
          "text-[13px] font-mono",
          isSelected ? "bg-surface-2 text-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink",
        )}
      >
        <TreeIndent depth={depth} />
        <span class={cn("flex-1 truncate", isSelected ? "text-ink" : statusToText(node.status))}>
          {node.name}
        </span>
        <FindingCountBadge count={node.findingCount} severity={node.findingSeverity} />
        {node.status !== "unchanged" ? (
          <Badge tone={statusToTone(node.status)}>{node.status}</Badge>
        ) : null}
      </button>
    </li>
  );
}
