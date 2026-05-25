import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./Menu";
import { cn } from "./cn";

interface UserMenuProps {
  email?: string | null;
  name?: string | null;
  onSignOut: () => void;
}

function initialsFor(email?: string | null, name?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  }
  if (email) {
    const local = email.split("@")[0] ?? "";
    if (local) return local.slice(0, 2).toUpperCase();
  }
  return "··";
}

export function UserMenu({ email, name, onSignOut }: UserMenuProps) {
  const label = email || name || "signed in";
  const initials = initialsFor(email, name);

  return (
    <Menu
      align="end"
      triggerAriaLabel={`Account menu for ${label}`}
      triggerClass={cn(
        "inline-flex items-center justify-center h-8 w-8 rounded-md",
        "text-[11px] font-mono font-medium tracking-[0.04em]",
        "bg-surface border border-border text-ink hover:border-border-strong transition-colors duration-150",
      )}
      trigger={() => initials}
      panelClass="min-w-[220px]"
    >
      <MenuLabel>signed in</MenuLabel>
      <div class="px-3 pb-1.5 text-[13px] text-ink font-mono break-all">{label}</div>
      <MenuSeparator />
      <MenuItem onSelect={onSignOut}>Sign out</MenuItem>
    </Menu>
  );
}
