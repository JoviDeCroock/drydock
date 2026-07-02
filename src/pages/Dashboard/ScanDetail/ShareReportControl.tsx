import { useEffect } from "preact/hooks";
import { useComputed, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import {
  createReportShare,
  getReportShare,
  revokeReportShare,
  type ReportShareStatus,
} from "../../../models/scan";
import { errorMessage } from "../../../models/api";
import { Button, pushToast } from "../../../components";

// Creates, rotates, and revokes the public read-only share link for a completed
// inspection. The raw link is only available at creation time (the server keeps
// a hash), so creating or rotating immediately copies it to the clipboard.
export function ShareReportControl({ scanId }: { scanId: string }) {
  const share = useSignal<ReportShareStatus | null>(null);
  const busy = useSignal(false);
  const active = useComputed(() => share.value?.active === true);

  useEffect(() => {
    let cancelled = false;
    getReportShare(scanId)
      .then((data) => {
        if (!cancelled) share.value = data.share;
      })
      .catch(() => {
        // Members without share visibility just don't see the state; the
        // buttons still work or fail with a toast on click.
      });
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  const createLink = async () => {
    if (busy.peek()) return;
    busy.value = true;
    try {
      const data = await createReportShare(scanId);
      share.value = data.share;
      const url = `${location.origin}${data.path}`;
      try {
        await navigator.clipboard.writeText(url);
        pushToast("Share link copied to clipboard", "ok");
      } catch {
        pushToast(`Share link: ${url}`, "ok");
      }
    } catch (err) {
      pushToast(errorMessage(err), "critical");
    } finally {
      busy.value = false;
    }
  };

  const revokeLink = async () => {
    if (busy.peek()) return;
    busy.value = true;
    try {
      const data = await revokeReportShare(scanId);
      share.value = data.share;
      pushToast("Share link revoked", "ok");
    } catch (err) {
      pushToast(errorMessage(err), "critical");
    } finally {
      busy.value = false;
    }
  };

  return (
    <div class="flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={createLink}>
        <Show when={active} fallback="Share report">
          Rotate share link
        </Show>
      </Button>
      <Show when={active}>
        <Button variant="ghost" size="sm" onClick={revokeLink}>
          Revoke link
        </Button>
      </Show>
    </div>
  );
}
