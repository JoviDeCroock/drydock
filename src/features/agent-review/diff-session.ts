import { batch, createModel, signal } from "@preact/signals";
import type { z } from "zod";
import { packageDiffPath, type DiffEcosystem, type DiffSpec } from "../../lib/package-diff-path";
import type { publicReviewFileInput, publicReviewPairInput } from "../../lib/public-review-tools";
import { ApiError } from "../../models/api";
import {
  getPublicDiff,
  type PackageDiffModel,
  type PublicDiffFileResponse,
  type PublicDiffResponse,
} from "../../models/package-diff";

type PairInput = z.infer<typeof publicReviewPairInput>;
type FileInput = z.infer<typeof publicReviewFileInput>;
interface ActiveReview {
  path: string;
  model: InstanceType<typeof PackageDiffModel>;
  revealFile(path: string, signal: AbortSignal): Promise<PublicDiffFileResponse | null>;
}

function reviewPath(spec: DiffSpec): string {
  return packageDiffPath(spec.ecosystem, spec.packageName, spec.fromVersion, spec.toVersion);
}

function supportedEcosystem(value: string): value is DiffEcosystem {
  return ["npm", "pypi", "atpm"].includes(value);
}

/** Owns page handoff while each workbench model remains bound to one pair. */
export const DiffAgentSession = createModel((browser: { path(): string; origin(): string }) => {
  const viewVersion = signal(0);
  let view: ActiveReview | null = null;
  let initial: { path: string; data: PublicDiffResponse } | null = null;
  let navigate: ((path: string) => void) | null = null;
  let locationPath: string | null = null;
  let locationVersion = 0;
  let stopped = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const browserPath = () => browser.path().replace(/\/+$/, "") || "/";
  const unavailable = () => new ApiError("The visible review changed. Try the tool again.", 409);
  const checkActive = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (stopped) throw unavailable();
  };

  function waitForView(path: string, signal: AbortSignal): Promise<ActiveReview> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        listeners.delete(check);
        signal.removeEventListener("abort", abort);
        clearTimeout(timeout);
        if (error) reject(error);
        else if (view) resolve(view);
      };
      const abort = () => finish(unavailable());
      const check = () => {
        if (stopped || signal.aborted || browserPath() !== path) return finish(unavailable());
        if (view?.path === path) finish();
      };
      const timeout = setTimeout(() => finish(unavailable()), 20_000);
      listeners.add(check);
      signal.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  async function open(input: PairInput, signal: AbortSignal, reuseCurrent: boolean) {
    checkActive(signal);
    if (!supportedEcosystem(input.ecosystem)) throw new ApiError("Invalid ecosystem.", 400);
    const requestedPath = packageDiffPath(input.ecosystem, input.package, input.from, input.to);
    const current = view;
    const currentData = current?.model.diff.peek();
    if (
      reuseCurrent &&
      current &&
      currentData &&
      current.path === requestedPath &&
      browserPath() === requestedPath
    ) {
      return { current, data: currentData };
    }
    const startedAt = browserPath();
    const startedVersion = locationVersion;
    const data = await getPublicDiff(input.ecosystem, input.package, input.from, input.to, signal);
    checkActive(signal);
    if (browserPath() !== startedAt || locationVersion !== startedVersion || !navigate) {
      throw unavailable();
    }
    const path = reviewPath(data);
    initial = { path, data };
    view = null;
    // Routing and the new keyed model must observe the response together.
    // A seeded model renders the evidence without another pair request.
    batch(() => {
      viewVersion.value = viewVersion.peek() + 1;
      navigate?.(path);
    });
    const attached = await waitForView(path, signal);
    checkActive(signal);
    return { current: attached, data };
  }

  return {
    viewVersion,
    setLocation(path: string, route: (path: string) => void) {
      navigate = route;
      if (locationPath !== path) {
        locationPath = path;
        locationVersion++;
        notify();
      }
    },
    takeInitialDiff(spec: DiffSpec) {
      if (initial?.path !== reviewPath(spec)) return undefined;
      const data = initial.data;
      initial = null;
      return data;
    },
    attach(
      spec: DiffSpec,
      model: InstanceType<typeof PackageDiffModel>,
      revealFile: ActiveReview["revealFile"],
    ) {
      const attached = { path: reviewPath(spec), model, revealFile };
      view = attached;
      notify();
      return () => {
        if (view === attached) view = null;
      };
    },
    async compare(input: PairInput, signal: AbortSignal): Promise<Record<string, unknown>> {
      const { current, data } = await open(input, signal, false);
      if (view !== current || browserPath() !== current.path) throw unavailable();
      return { ...data, reviewUrl: new URL(reviewPath(data), browser.origin()).href };
    },
    async file(input: FileInput, signal: AbortSignal): Promise<Record<string, unknown>> {
      const { current } = await open(input, signal, true);
      checkActive(signal);
      if (!current.model.diff.peek()?.diff.some((entry) => entry.path === input.path)) {
        throw new ApiError("File not found in the visible review.", 404);
      }
      const file = await current.revealFile(input.path, signal);
      checkActive(signal);
      if (
        view !== current ||
        browserPath() !== current.path ||
        current.model.selectedPath.peek() !== input.path
      ) {
        throw unavailable();
      }
      if (!file)
        throw (
          current.model.fileFailure.peek() ?? new ApiError("File evidence is unavailable.", 503)
        );
      return { ...file };
    },
    stop() {
      stopped = true;
      initial = null;
      view = null;
      notify();
    },
  };
});
