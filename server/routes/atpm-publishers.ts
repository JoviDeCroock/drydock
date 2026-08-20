import { Hono } from "hono";
import { createDb } from "../db/client";
import {
  consumeAtpmOauthRequest,
  createAtpmOauthRequest,
  deleteAtpmPublisher,
  getAtpmPublisher,
  listAtpmPublishers,
  upsertAtpmPublisher,
  type AtpmPublisherRecord,
} from "../db/atpm-publishers";
import { recordScanEvent } from "../db/events";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import {
  requireActiveOrganization,
  requireActiveOrganizationContext,
} from "../lib/auth/active-organization";
import { roleCanManageIntegrations } from "../lib/auth/roles";
import { canonicalOrigin, rateLimitResponse } from "../lib/platform/http";
import { workerExecutionContext } from "../lib/platform/execution-context";
import { base64UrlEncode } from "../lib/platform/crypto-utils";
import { decryptSecretValue, encryptSecretValue } from "../lib/platform/secret-box";
import {
  AtpmOauthError,
  OAUTH_REQUEST_TTL_MS,
  atpmOauthClient,
  atpmOauthClientMetadata,
  createDpopKeyPair,
  createPkcePair,
  proveDidFromAuthorizationCode,
  pushAuthorizationRequest,
  resolveAtpmOauthTarget,
  type DpopKeyPair,
} from "../lib/ecosystems/atpm/oauth";
import { discoverAtpmStagedCandidates } from "../lib/ecosystems/atpm/staged-discovery";
import { PublicDiffError } from "../lib/public-diff/error";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import type { Bindings, Variables } from "../types";

/**
 * Enrolling an atpm publishing account, and asking Drydock to look at it now.
 *
 * The interesting design point is what enrolment is *for*. It grants Drydock
 * nothing — every record it reads afterwards is public — so this is not an
 * authorization flow in the usual sense. It answers "whose releases belong in
 * this organization's dashboard", which is a question about ownership rather
 * than access, and the honest way to answer it is to make the person prove they
 * can sign in as that account.
 */
export const atpmPublisherRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function publicPublisher(record: AtpmPublisherRecord) {
  return {
    id: record.id,
    did: record.did,
    handle: record.handle,
    pds: record.pds,
    verificationMethod: record.verificationMethod,
    verifiedAt: record.verifiedAt.toISOString(),
    lastSweptAt: record.lastSweptAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

/** Map both error families this path can raise onto a response. */
function enrolmentErrorResponse(err: unknown) {
  if (err instanceof AtpmOauthError) return { error: err.message, status: err.status } as const;
  if (err instanceof PublicDiffError) {
    // The shared identity helpers speak in diff-shaped statuses; 502 there means
    // "the account's own infrastructure did not answer usefully", which is a 400
    // from the point of view of someone typing a handle into a form.
    return { error: err.message, status: err.status === 502 ? 400 : err.status } as const;
  }
  return { error: "could not reach that account", status: 502 } as const;
}

atpmPublisherRoutes.get("/publishers", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const publishers = await listAtpmPublishers(db, organizationId);
  return c.json({ publishers: publishers.map(publicPublisher) });
});

/**
 * Begin enrolment: resolve the account, discover its own authorization server,
 * push the request, and hand back the URL to send the browser to.
 *
 * The DPoP private key and PKCE verifier are stashed against the `state` and
 * encrypted at rest. They are single-use and expire in minutes, but "short
 * lived" is a reason to bound exposure rather than a reason to skip it.
 */
atpmPublisherRoutes.post("/publishers/connect", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  try {
    await enforceRateLimit(db, {
      key: `atpm:connect:${organizationId}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "atpm publisher connect rate limit exceeded", err);
    }
    throw err;
  }

  const body = (await c.req.json().catch(() => ({}))) as { publisher?: unknown };
  const publisherRef = typeof body.publisher === "string" ? body.publisher.trim() : "";
  if (!publisherRef) return c.json({ error: "publisher is required" }, 400);

  try {
    const { identity, endpoints } = await resolveAtpmOauthTarget(publisherRef);
    const client = atpmOauthClient(canonicalOrigin(c));
    const key = await createDpopKeyPair();
    const pkce = await createPkcePair();
    const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));

    const { authorizationUrl } = await pushAuthorizationRequest({
      client,
      endpoints,
      identity,
      key,
      pkce,
      state,
    });

    const sealed = await encryptSecretValue(c.env, JSON.stringify(key.privateJwk));
    await createAtpmOauthRequest(db, {
      state,
      organizationId,
      createdByUserId: session.userId,
      did: identity.did,
      handle: identity.handle,
      pds: identity.pds,
      issuer: endpoints.issuer,
      tokenEndpoint: endpoints.tokenEndpoint,
      pkceVerifier: pkce.verifier,
      dpopKeyCiphertext: sealed.ciphertext,
      dpopKeyNonce: sealed.nonce,
      ttlMs: OAUTH_REQUEST_TTL_MS,
    });

    return c.json({ authorizationUrl, did: identity.did, handle: identity.handle }, 201);
  } catch (err) {
    const mapped = enrolmentErrorResponse(err);
    emitOperationalEvent("warn", "atpm_publisher.connect_failed", {
      organizationId,
      error: describeOperationalError(err),
    });
    return c.json({ error: mapped.error }, mapped.status);
  }
});

/**
 * The authorization server sends the browser back here.
 *
 * Three things must line up before an enrolment is recorded: the `state` must
 * match a request this deployment started, the `iss` must be the issuer that
 * request was pushed to, and the token response's `sub` must be the DID the
 * flow was started for. Any of them failing is a redirect back to settings with
 * an error rather than a partially-trusted row.
 */
atpmPublisherRoutes.get("/oauth/callback", async (c) => {
  const db = createDb(c.env.DB);
  const origin = canonicalOrigin(c);
  const settings = new URL("/dashboard/settings", origin);

  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const issuer = c.req.query("iss") ?? "";
  const oauthError = c.req.query("error");
  if (oauthError) {
    settings.searchParams.set("atpmError", "The account declined the connection.");
    return c.redirect(settings.toString());
  }
  if (!state || !code) {
    settings.searchParams.set("atpmError", "That connection response was incomplete.");
    return c.redirect(settings.toString());
  }

  // This is a GET, so it is exempt from the origin check that guards
  // state-changing methods — yet it creates a row. What stands in for that
  // check is the `state` itself: 192 unguessable bits, single-use, and bound
  // below to the session and organization that minted it. An attacker cannot
  // produce one, so there is nothing to forge a request with.
  //
  // Consumed unconditionally: an authorization code is single-use, so the state
  // that would permit a second attempt must not survive the first.
  const request = await consumeAtpmOauthRequest(db, state);
  if (!request) {
    settings.searchParams.set("atpmError", "That connection request expired. Try again.");
    return c.redirect(settings.toString());
  }
  if (issuer && issuer !== request.issuer) {
    settings.searchParams.set("atpmError", "That response came from a different server.");
    return c.redirect(settings.toString());
  }

  // The session that finishes the flow must be the one that started it: a
  // callback URL is a plain GET, and without this a link could enrol an account
  // into whichever organization the recipient happens to be looking at.
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  if (organizationId !== request.organizationId || session.userId !== request.createdByUserId) {
    settings.searchParams.set("atpmError", "That connection was started by someone else.");
    return c.redirect(settings.toString());
  }

  try {
    const privateJwk = JSON.parse(
      await decryptSecretValue(c.env, {
        ciphertext: request.dpopKeyCiphertext,
        nonce: request.dpopKeyNonce,
      }),
    ) as JsonWebKey;
    const key: DpopKeyPair = {
      privateJwk,
      // Rebuilt from the private key's public half; a DPoP proof header carries
      // only the public coordinates.
      publicJwk: { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y },
    };

    const did = await proveDidFromAuthorizationCode({
      client: atpmOauthClient(origin),
      tokenEndpoint: request.tokenEndpoint,
      key,
      code,
      pkceVerifier: request.pkceVerifier,
      expectedDid: request.did,
    });

    const publisher = await upsertAtpmPublisher(db, {
      organizationId: request.organizationId,
      did,
      handle: request.handle,
      pds: request.pds,
      verificationMethod: "atproto_oauth",
      createdByUserId: request.createdByUserId,
    });
    await recordScanEvent(db, {
      organizationId: request.organizationId,
      actorUserId: request.createdByUserId,
      type: "atpm_publisher.connected",
      metadata: { did: publisher.did, handle: publisher.handle, method: "atproto_oauth" },
    });

    settings.searchParams.set("atpmConnected", publisher.handle ?? publisher.did);
    return c.redirect(settings.toString());
  } catch (err) {
    emitOperationalEvent("warn", "atpm_publisher.callback_failed", {
      organizationId: request.organizationId,
      error: describeOperationalError(err),
    });
    settings.searchParams.set("atpmError", enrolmentErrorResponse(err).error);
    return c.redirect(settings.toString());
  }
});

atpmPublisherRoutes.delete("/publishers/:id", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const { organizationId, role } = await requireActiveOrganizationContext(c, db);
  if (!roleCanManageIntegrations(role)) return c.json({ error: "forbidden" }, 403);

  const publisher = await getAtpmPublisher(db, organizationId, c.req.param("id"));
  if (!publisher) return c.json({ error: "not found" }, 404);
  await deleteAtpmPublisher(db, organizationId, publisher.id);
  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    type: "atpm_publisher.disconnected",
    metadata: { did: publisher.did, handle: publisher.handle },
  });
  return c.json({ ok: true });
});

/**
 * Look now, rather than waiting for the sweep.
 *
 * atpm deletes a staged record when it is approved, so a candidate can appear
 * and vanish between two ticks of a 15-minute cron. This is the manual counter
 * to that, and the reason the firehose consumer exists is to make needing it
 * rare.
 */
atpmPublisherRoutes.post("/publishers/:id/discover", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);

  try {
    await enforceRateLimit(db, {
      key: `atpm:discover:${organizationId}`,
      limit: 12,
      windowMs: 10 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "atpm discovery rate limit exceeded", err);
    }
    throw err;
  }

  const publisher = await getAtpmPublisher(db, organizationId, c.req.param("id"));
  if (!publisher) return c.json({ error: "not found" }, 404);

  try {
    const result = await discoverAtpmStagedCandidates({
      db,
      env: c.env,
      executionCtx: workerExecutionContext(c.executionCtx),
      organizationId,
      actorUserId: session.userId,
      publisherRef: publisher.did,
      source: "manual",
    });
    return c.json(result);
  } catch (err) {
    const mapped = enrolmentErrorResponse(err);
    return c.json({ error: mapped.error }, mapped.status);
  }
});

/**
 * The OAuth client metadata document. Public and unauthenticated by necessity:
 * every authorization server this client talks to fetches it, and none of them
 * has a session.
 */
export const atpmOauthMetadataRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

atpmOauthMetadataRoutes.get("/client-metadata.json", (c) => {
  return c.json(atpmOauthClientMetadata(canonicalOrigin(c)), 200, {
    "cache-control": "public, max-age=300",
  });
});
