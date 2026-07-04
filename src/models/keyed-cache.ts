import { signal } from "@preact/signals";
import { errorMessage } from "./api";

export interface KeyedCacheStatusCopy<S extends string> {
  idle: S;
  loading: S;
  error: S;
}

export function createKeyedCache<V, S extends string>(statuses: KeyedCacheStatusCopy<S>) {
  const values = signal<Record<string, V[]>>({});
  const status = signal<Record<string, S>>({});
  const errors = signal<Record<string, string>>({});

  function valueFor(key: string): V[] {
    return values.value[key] ?? [];
  }

  function statusFor(key: string): S {
    return status.value[key] ?? statuses.idle;
  }

  function errorFor(key: string): string | null {
    return errors.value[key] ?? null;
  }

  function setValue(key: string, next: V[]): void {
    values.value = { ...values.peek(), [key]: next };
  }

  function setStatus(key: string, next: S): void {
    status.value = { ...status.peek(), [key]: next };
  }

  function setError(key: string, message: string | null): void {
    const next = { ...errors.peek() };
    if (message) next[key] = message;
    else delete next[key];
    errors.value = next;
  }

  async function load(
    key: string,
    fetcher: () => Promise<V[]>,
    { force = false }: { force?: boolean } = {},
  ): Promise<void> {
    if (!key) return;
    if (!force && values.peek()[key]) return;
    setStatus(key, statuses.loading);
    setError(key, null);
    try {
      setValue(key, await fetcher());
      setStatus(key, statuses.idle);
    } catch (err) {
      setError(key, errorMessage(err));
      setStatus(key, statuses.error);
    }
  }

  return {
    values,
    status,
    errors,
    valueFor,
    statusFor,
    errorFor,
    setValue,
    setStatus,
    setError,
    load,
  };
}
