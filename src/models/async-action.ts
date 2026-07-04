import { computed, type Signal } from "@preact/signals";
import { errorMessage } from "./api";

export interface RunActionOptions<S, T> {
  status: Signal<S>;
  pending: S;
  idle?: S;
  error?: Signal<string | null>;
  run: () => Promise<T>;
  mapError?: (err: unknown) => string;
  settle?: () => boolean;
}

export async function runAction<T, S>(options: RunActionOptions<S, T>): Promise<T | undefined> {
  const { status, error, pending, idle = "idle" as S, run, mapError, settle } = options;
  status.value = pending;
  if (error) error.value = null;
  try {
    return await run();
  } catch (err) {
    if (!settle || settle()) {
      if (error) {
        error.value = mapError ? mapError(err) : errorMessage(err);
      }
    }
    return undefined;
  } finally {
    if (!settle || settle()) {
      status.value = idle;
    }
  }
}

export function busySignal<S extends string>(status: Signal<S>) {
  return computed(() => status.value !== "idle");
}
