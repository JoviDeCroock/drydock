// @ts-check
import { CLI_VERSION } from "./version.mjs";

// HTTP access to one Drydock origin. The API key is attached only to requests
// for that origin, never follows a redirect, and never appears in an error.

const DEFAULT_URL = "https://drydock.org";
const KEY_RE = /^ddk_[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/**
 * The origin requests go to. Plain HTTP is accepted only for loopback, so a
 * key is never sent in the clear to a remote host.
 * @param {string | undefined} value
 * @returns {string}
 */
export function resolveBaseUrl(value) {
  const raw = value?.trim() || DEFAULT_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`invalid Drydock URL: ${raw}`, 2);
  }
  if (url.username || url.password) {
    throw new CliError("the Drydock URL must not contain credentials", 2);
  }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (!secure && !loopback) {
    throw new CliError("the Drydock URL must use https (http is allowed only for localhost)", 2);
  }
  return url.origin;
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
export function requireApiKey(value) {
  const key = value?.trim();
  if (!key) {
    throw new CliError(
      "set DRYDOCK_API_KEY to an organization API key (Settings → Integrations → API keys)",
      2,
    );
  }
  if (!KEY_RE.test(key)) throw new CliError("DRYDOCK_API_KEY is not a Drydock API key", 2);
  return key;
}

/**
 * One path segment. Dot segments would be resolved away by URL parsing and
 * point the request somewhere else, so they are refused rather than encoded.
 * @param {string} value
 * @param {string} label
 */
export function pathSegment(value, label) {
  if (!value || value === "." || value === "..")
    throw new CliError(`invalid ${label}: ${value}`, 2);
  return encodeURIComponent(value);
}

/**
 * @typedef {object} ApiResponse
 * @property {number} status
 * @property {Headers} headers
 * @property {string} text
 */

/**
 * @typedef {object} RequestOptions
 * @property {boolean} [authenticated]
 * @property {"GET" | "POST"} [method]
 * @property {unknown} [body] sent as JSON; omitted entirely when undefined
 */

/**
 * @param {{ baseUrl: string; apiKey: string | null; fetch: typeof globalThis.fetch }} options
 */
export function createClient({ baseUrl, apiKey, fetch: send }) {
  /**
   * @param {string} path absolute path with an encoded query string
   * @param {RequestOptions} [options]
   * @returns {Promise<ApiResponse>}
   */
  async function request(path, { authenticated = true, method = "GET", body } = {}) {
    /** @type {Record<string, string>} */
    const headers = { accept: "application/json", "user-agent": `drydock-cli/${CLI_VERSION}` };
    if (authenticated) {
      if (!apiKey) throw new CliError("this command needs DRYDOCK_API_KEY", 2);
      headers.authorization = `Bearer ${apiKey}`;
    }
    /** @type {RequestInit} */
    const init = { method, headers, redirect: "manual" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await send(`${baseUrl}${path}`, init);
    } catch (err) {
      throw new CliError(`could not reach ${baseUrl}: ${describe(err)}`);
    }
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) {
      throw new CliError(`${baseUrl} answered with a redirect; check the Drydock URL`);
    }
    if (!res.ok) throw new CliError(errorMessage(res.status, text, res.headers));
    return { status: res.status, headers: res.headers, text };
  }

  /**
   * @param {string} path
   * @param {RequestOptions} [options]
   * @returns {Promise<any>}
   */
  async function json(path, options) {
    const res = await request(path, options);
    try {
      return JSON.parse(res.text);
    } catch {
      throw new CliError(`${path} did not return JSON`);
    }
  }

  return { request, json };
}

/**
 * @param {number} status
 * @param {string} text
 * @param {Headers} headers
 */
function errorMessage(status, text, headers) {
  /** @type {{ error?: unknown; code?: unknown }} */
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // A non-JSON error body is described by its status alone.
  }
  const detail = typeof body.error === "string" ? body.error : `HTTP ${status}`;
  const code = typeof body.code === "string" ? ` (${body.code})` : "";
  if (status === 401) return `the API key was rejected: ${detail}${code}`;
  if (body.code === "api_key_access_insufficient") {
    return "this API key is read-only; starting reviews needs a key with scan access (Organization settings → Integrations → API keys)";
  }
  if (status === 429) {
    const retry = headers.get("retry-after");
    return `rate limited${retry ? `; retry after ${retry}s` : ""}: ${detail}`;
  }
  return `${detail}${code}`;
}

/** @param {unknown} err */
function describe(err) {
  return err instanceof Error ? err.message : String(err);
}
