export function Card({ class: className, children }: { class?: string; children?: unknown }) {
  return (
    <div class={`bg-surface border border-border rounded-lg p-6 ${className ?? ""}`}>
      {children}
    </div>
  );
}
