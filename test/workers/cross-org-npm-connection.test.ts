import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { createOrganization } from "../../server/db/organizations";
import { addOrganizationMember } from "../../server/db/invitations";
import { getNpmConnection } from "../../server/db/npm-connections";
import { npmConnectionRoutes } from "../../server/routes/npm-connection";
import { buildTestApp, call, type TestApp } from "./helpers/app";
import { seedUser } from "./helpers/seed";

const mountNpmConnection = (app: TestApp) =>
  app.route("/api/v1/npm-connection", npmConnectionRoutes);

const OWNER_TOKEN = "npm_owner_secret_token_AAAAAAA";
const INTRUDER_TOKEN = "npm_intruder_secret_token_ZZZZZZZ";

describe("npm-connection routes enforce organization boundaries", () => {
  test("GET /npm-connection only returns the caller's connection", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();

    const upsert = await call(
      buildTestApp(mountNpmConnection, owner),
      "POST",
      "/api/v1/npm-connection",
      {
        body: {
          token: OWNER_TOKEN,
          label: "owner registry",
        },
      },
    );
    expect(upsert.status).toBe(200);

    const intruderRes = await call(
      buildTestApp(mountNpmConnection, intruder),
      "GET",
      "/api/v1/npm-connection",
    );
    expect(intruderRes.status).toBe(200);
    const intruderBody = (await intruderRes.json()) as { connection: unknown };
    expect(intruderBody.connection).toBeNull();

    const ownerRes = await call(
      buildTestApp(mountNpmConnection, owner),
      "GET",
      "/api/v1/npm-connection",
    );
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as {
      connection: { organizationId: string; tokenLast4: string | null; label: string } | null;
    };
    expect(ownerBody.connection?.organizationId).toBe(owner.organizationId);
    expect(ownerBody.connection?.label).toBe("owner registry");
    expect(ownerBody.connection?.tokenLast4).toBe(OWNER_TOKEN.slice(-4));
  });

  test("POST /npm-connection from a foreign session writes to that session's org, not the target's", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const db = createDb(env.DB);

    await call(buildTestApp(mountNpmConnection, owner), "POST", "/api/v1/npm-connection", {
      body: {
        token: OWNER_TOKEN,
        label: "owner registry",
      },
    });

    const upsert = await call(
      buildTestApp(mountNpmConnection, intruder),
      "POST",
      "/api/v1/npm-connection",
      {
        body: {
          token: INTRUDER_TOKEN,
          label: "intruder registry",
        },
      },
    );
    expect(upsert.status).toBe(200);

    const ownerConnection = await getNpmConnection(db, owner.organizationId);
    const intruderConnection = await getNpmConnection(db, intruder.organizationId);
    expect(ownerConnection?.label).toBe("owner registry");
    expect(ownerConnection?.tokenLast4).toBe(OWNER_TOKEN.slice(-4));
    expect(intruderConnection?.label).toBe("intruder registry");
    expect(intruderConnection?.tokenLast4).toBe(INTRUDER_TOKEN.slice(-4));
    expect(ownerConnection?.tokenCiphertext).not.toBe(intruderConnection?.tokenCiphertext);
  });

  test("POST /npm-connection accepts custom registries for organization connections", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);

    const res = await call(
      buildTestApp(mountNpmConnection, owner),
      "POST",
      "/api/v1/npm-connection",
      {
        body: {
          token: OWNER_TOKEN,
          label: "custom registry",
          registryUrl: "https://registry.example.com",
        },
      },
    );

    expect(res.status).toBe(200);
    const connection = await getNpmConnection(db, owner.organizationId);
    expect(connection?.registryUrl).toBe("https://registry.example.com");
  });

  test("DELETE /npm-connection only removes the caller's connection", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const db = createDb(env.DB);

    await call(buildTestApp(mountNpmConnection, owner), "POST", "/api/v1/npm-connection", {
      body: {
        token: OWNER_TOKEN,
        label: "owner registry",
      },
    });

    const deleteRes = await call(
      buildTestApp(mountNpmConnection, intruder),
      "DELETE",
      "/api/v1/npm-connection",
    );
    expect(deleteRes.status).toBe(200);

    const ownerConnection = await getNpmConnection(db, owner.organizationId);
    expect(ownerConnection).not.toBeNull();
    expect(ownerConnection?.tokenLast4).toBe(OWNER_TOKEN.slice(-4));
  });

  test("POST /npm-connection/validate without a connection returns 404 and never touches the network", async () => {
    const intruder = await seedUser();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await call(
        buildTestApp(mountNpmConnection, intruder),
        "POST",
        "/api/v1/npm-connection/validate",
        { body: {} },
      );
      expect(res.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("POST /npm-connection/validate against another org's connection still returns 404 for the foreign caller", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();

    await call(buildTestApp(mountNpmConnection, owner), "POST", "/api/v1/npm-connection", {
      body: {
        token: OWNER_TOKEN,
        label: "owner registry",
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await call(
        buildTestApp(mountNpmConnection, intruder),
        "POST",
        "/api/v1/npm-connection/validate",
        { body: {} },
      );
      expect(res.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("npm-connection routes answer role denials as 403", () => {
  // Regression: requireOrganizationRole throws inside the handlers' try blocks,
  // and the catch used to rethrow only UnauthorizedError, so a member's denial
  // was logged as a storage failure and answered 500.
  test("a member cannot store or validate the shared organization's token", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    await addOrganizationMember(createDb(env.DB), {
      organizationId: owner.organizationId,
      userId: member.userId,
      role: "member",
    });
    const app = buildTestApp(mountNpmConnection, member);

    const upsert = await call(app, "POST", "/api/v1/npm-connection", {
      body: { token: INTRUDER_TOKEN, confirmPersonalOrganization: true },
      activeOrganizationId: owner.organizationId,
    });
    expect(upsert.status).toBe(403);
    expect(await upsert.json()).toEqual({ error: "forbidden" });

    const validate = await call(app, "POST", "/api/v1/npm-connection/validate", {
      body: { confirmPersonalOrganization: true },
      activeOrganizationId: owner.organizationId,
    });
    expect(validate.status).toBe(403);
    expect(await validate.json()).toEqual({ error: "forbidden" });
  });
});

describe("explicit personal connection confirmation", () => {
  test("saving needs literal true to confirm and later token edits preserve an existing choice", async () => {
    const owner = await seedUser();
    const app = buildTestApp(mountNpmConnection, owner);
    for (const confirmPersonalOrganization of [undefined, false, "true"]) {
      expect(
        (
          await call(app, "POST", "/api/v1/npm-connection", {
            body: { token: OWNER_TOKEN, confirmPersonalOrganization },
          })
        ).status,
      ).toBe(200);
      expect(
        (await getNpmConnection(owner.db, owner.organizationId))?.personalOrganizationConfirmedAt,
      ).toBeNull();
    }
    await call(app, "POST", "/api/v1/npm-connection", {
      body: { token: OWNER_TOKEN, confirmPersonalOrganization: true },
    });
    const confirmed = (await getNpmConnection(owner.db, owner.organizationId))
      ?.personalOrganizationConfirmedAt;
    expect(confirmed).toBeInstanceOf(Date);
    await call(app, "POST", "/api/v1/npm-connection", { body: { token: INTRUDER_TOKEN } });
    expect(
      (await getNpmConnection(owner.db, owner.organizationId))?.personalOrganizationConfirmedAt,
    ).toEqual(confirmed);
    const response = await call(app, "GET", "/api/v1/npm-connection");
    expect(await response.json()).toMatchObject({
      connection: { personalOrganizationConfirmedAt: confirmed?.toISOString() },
    });
  });
  test("credential validation does not implicitly confirm personal discovery", async () => {
    const owner = await seedUser();
    const app = buildTestApp(mountNpmConnection, owner);
    await call(app, "POST", "/api/v1/npm-connection", { body: { token: OWNER_TOKEN } });
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).endsWith("/-/whoami")
          ? Response.json({ username: "maintainer" })
          : Response.json({ items: [], total: 0 }),
      );
    try {
      for (const confirmPersonalOrganization of [undefined, false, "true"]) {
        expect(
          (
            await call(app, "POST", "/api/v1/npm-connection/validate", {
              body: { confirmPersonalOrganization },
            })
          ).status,
        ).toBe(200);
        expect(
          (await getNpmConnection(owner.db, owner.organizationId))?.personalOrganizationConfirmedAt,
        ).toBeNull();
      }
      expect(
        (
          await call(app, "POST", "/api/v1/npm-connection/validate", {
            body: { confirmPersonalOrganization: true },
          })
        ).status,
      ).toBe(200);
      expect(
        (await getNpmConnection(owner.db, owner.organizationId))?.personalOrganizationConfirmedAt,
      ).toBeInstanceOf(Date);
    } finally {
      fetcher.mockRestore();
    }
  });
  test("an explicit personal flag never writes consent onto a shared organization connection", async () => {
    const owner = await seedUser();
    const organizationId = await createOrganization(owner.db, {
      ownerUserId: owner.userId,
      name: "Shared registry team",
    });
    const response = await call(
      buildTestApp(mountNpmConnection, owner),
      "POST",
      "/api/v1/npm-connection",
      {
        body: { token: OWNER_TOKEN, confirmPersonalOrganization: true },
        activeOrganizationId: organizationId,
      },
    );
    expect(response.status).toBe(200);
    expect(
      (await getNpmConnection(owner.db, organizationId))?.personalOrganizationConfirmedAt,
    ).toBeNull();
  });
});
