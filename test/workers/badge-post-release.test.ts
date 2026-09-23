import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import * as schema from "../../server/db/schema";
import { call } from "./helpers/app";
import {
  OTHER,
  PUBLISHED,
  appFor,
  decide,
  fetchBadge,
  linkReview,
  newPackage,
  seedAlert,
  seedPublishedReview,
  seedStagedRelease,
} from "./helpers/post-release";
import { seedUser } from "./helpers/seed";

describe("the public badge counts a publisher's decision after release", () => {
  // A registry-verified publisher with an approved 1.0.0 on the badge, and a
  // 1.0.1 npm published without any approval here.
  async function publisherWithDirectRelease() {
    const owner = await seedUser();
    const app = appFor(owner);
    const packageName = newPackage();
    await seedStagedRelease(owner, app, packageName, "1.0.0");
    await seedAlert(owner, packageName, "1.0.1");
    expect((await fetchBadge(app, packageName)).message).toBe("1.0.1 not reviewed");
    return { owner, app, packageName };
  }

  test("approve after release reads approved, exactly like an approval before it; decline reads blocked", async () => {
    const { owner, app, packageName } = await publisherWithDirectRelease();
    const scanId = await seedPublishedReview(owner, packageName, "1.0.1");
    await linkReview(owner, packageName, "1.0.1", scanId);

    expect((await decide(app, scanId, "publish")).postRelease).toMatchObject({
      resolutionBadge: "applied",
    });
    expect(await fetchBadge(app, packageName)).toMatchObject({
      label: "drydock",
      message: "1.0.1 approved",
      color: "brightgreen",
    });

    await decide(app, scanId, "no_publish");
    expect(await fetchBadge(app, packageName)).toMatchObject({
      label: "drydock",
      message: "1.0.1 blocked",
      color: "red",
    });
  });

  test("bytes the review read that differ from the published ones never reach the badge", async () => {
    const { owner, app, packageName } = await publisherWithDirectRelease();
    const scanId = await seedPublishedReview(owner, packageName, "1.0.1", { digests: OTHER });
    await linkReview(owner, packageName, "1.0.1", scanId);

    const approved = await decide(app, scanId, "publish");
    // The alert still resolves for the organization; the badge does not move.
    expect(approved.postRelease).toMatchObject({
      resolution: "approved_after_release",
      resolutionBadge: "digests_differ",
    });
    expect((await fetchBadge(app, packageName)).message).toBe("1.0.1 not reviewed");
    await decide(app, scanId, "no_publish");
    expect((await fetchBadge(app, packageName)).message).toBe("1.0.1 not reviewed");
  });

  test("a digest in only one algorithm on each side is no match", async () => {
    const { owner, app, packageName } = await publisherWithDirectRelease();
    await createDb(env.DB)
      .update(schema.publicationObservations)
      .set({ sha256: null })
      .where(eq(schema.publicationObservations.organizationId, owner.organizationId));
    const scanId = await seedPublishedReview(owner, packageName, "1.0.1", {
      digests: { sha1: null, sha256: PUBLISHED.sha256 },
    });
    await linkReview(owner, packageName, "1.0.1", scanId);
    expect((await decide(app, scanId, "publish")).postRelease).toMatchObject({
      resolutionBadge: "digests_unavailable",
    });
    expect((await fetchBadge(app, packageName)).message).toBe("1.0.1 not reviewed");
  });

  test("a review read from anywhere but public npm never reaches the badge", async () => {
    const { owner, app, packageName } = await publisherWithDirectRelease();
    const scanId = await seedPublishedReview(owner, packageName, "1.0.1", {
      registryUrl: "https://mirror.example",
    });
    await linkReview(owner, packageName, "1.0.1", scanId);
    expect((await decide(app, scanId, "publish")).postRelease).toMatchObject({
      resolutionBadge: "not_public_npm",
    });
    expect((await fetchBadge(app, packageName)).message).toBe("1.0.1 not reviewed");
  });

  test("an organization only watching someone else's package cannot move its badge", async () => {
    const { app, packageName } = await publisherWithDirectRelease();
    // Anyone can watch a public package and review a published pair of it.
    const watcher = await seedUser();
    const watcherApp = appFor(watcher);
    await seedAlert(watcher, packageName, "1.0.1");
    const scanId = await seedPublishedReview(watcher, packageName, "1.0.1");
    await linkReview(watcher, packageName, "1.0.1", scanId);

    expect((await decide(watcherApp, scanId, "publish")).postRelease).toMatchObject({
      resolution: "approved_after_release",
      resolutionBadge: "not_a_verified_publisher",
    });
    expect((await fetchBadge(app, packageName)).message).toBe("1.0.1 not reviewed");
    await decide(watcherApp, scanId, "no_publish");
    expect((await fetchBadge(app, packageName)).message).toBe("1.0.1 not reviewed");

    // Nor on a package with nothing else on its badge, even with a row that
    // claims the guard passed: the publisher rule is enforced again on read.
    const unclaimed = newPackage();
    await seedAlert(watcher, unclaimed, "1.0.1");
    const forged = await seedPublishedReview(watcher, unclaimed, "1.0.1");
    await linkReview(watcher, unclaimed, "1.0.1", forged);
    await decide(watcherApp, forged, "no_publish");
    await createDb(env.DB)
      .update(schema.publicationAlerts)
      .set({ resolutionBadge: "applied" })
      .where(eq(schema.publicationAlerts.reviewScanId, forged));
    expect((await fetchBadge(app, unclaimed)).message).toBe("not reviewed");
  });

  test("a recorded resolution whose review decision changed underneath it does not count", async () => {
    const { owner, app, packageName } = await publisherWithDirectRelease();
    const scanId = await seedPublishedReview(owner, packageName, "1.0.1");
    await linkReview(owner, packageName, "1.0.1", scanId);
    await decide(app, scanId, "publish");
    await createDb(env.DB)
      .update(schema.scans)
      .set({ decision: "no_publish" })
      .where(eq(schema.scans.id, scanId));
    expect((await fetchBadge(app, packageName)).message).toBe("1.0.1 not reviewed");
  });

  test("the quoted version's published bytes, decided after release, settle its own discrepancy", async () => {
    const owner = await seedUser();
    const app = appFor(owner);
    const packageName = newPackage();
    await seedStagedRelease(owner, app, packageName, "1.0.0");
    // npm published other bytes than the staged ones the approval covered.
    await seedAlert(owner, packageName, "1.0.0", {
      status: "artifact_mismatch",
      previousVersion: "0.9.0",
    });
    expect((await fetchBadge(app, packageName)).message).toBe("1.0.0 not reviewed");
    const scanId = await seedPublishedReview(owner, packageName, "1.0.0");
    await linkReview(owner, packageName, "1.0.0", scanId);

    await decide(app, scanId, "publish");
    expect(await fetchBadge(app, packageName)).toMatchObject({
      message: "1.0.0 approved",
      color: "brightgreen",
    });
    await decide(app, scanId, "no_publish");
    expect(await fetchBadge(app, packageName)).toMatchObject({
      message: "1.0.0 blocked",
      color: "red",
    });
  });

  test("answers on its own when nothing staged answers the badge", async () => {
    const owner = await seedUser();
    const app = appFor(owner);
    const packageName = newPackage();
    // A publisher whose only staged review nobody decided.
    await seedStagedRelease(owner, app, packageName, "1.0.0", { decision: null });
    expect((await fetchBadge(app, packageName)).message).toBe("not reviewed");
    await seedAlert(owner, packageName, "1.0.1");
    const scanId = await seedPublishedReview(owner, packageName, "1.0.1");
    await linkReview(owner, packageName, "1.0.1", scanId);
    await decide(app, scanId, "publish");
    expect(await fetchBadge(app, packageName)).toMatchObject({
      message: "1.0.1 approved",
      color: "brightgreen",
    });
    // A prerelease line it was never recorded on is not answered for.
    expect((await fetchBadge(app, packageName, "beta")).message).toBe("not reviewed");
  });

  test("a publisher's off switch silences it like every other route", async () => {
    const { owner, app, packageName } = await publisherWithDirectRelease();
    const scanId = await seedPublishedReview(owner, packageName, "1.0.1");
    await linkReview(owner, packageName, "1.0.1", scanId);
    await decide(app, scanId, "no_publish");
    expect((await fetchBadge(app, packageName)).message).toBe("1.0.1 blocked");
    const off = await call(app, "PUT", `/api/v1/packages/${packageName}/badge`, {
      body: { enabled: false },
    });
    expect(off.status).toBe(200);
    expect((await fetchBadge(app, packageName)).message).toBe("not reviewed");
  });

  test("on a line the decision does not answer, an approval clears the supersession and a decline reads blocked", async () => {
    const owner = await seedUser();
    const app = appFor(owner);
    const packageName = newPackage();
    await seedStagedRelease(owner, app, packageName, "4.0.0-rc.1", { tag: "next" });
    // A newer candidate on the `next` channel, with no dist-tag data recorded:
    // the badge places it on the line by its version alone.
    await seedAlert(owner, packageName, "4.0.0-rc.2", {
      previousVersion: "4.0.0-rc.1",
      distTags: null,
    });
    expect((await fetchBadge(app, packageName, "next")).message).toBe("4.0.0-rc.2 not reviewed");
    const scanId = await seedPublishedReview(owner, packageName, "4.0.0-rc.2");
    await linkReview(owner, packageName, "4.0.0-rc.2", scanId);

    await decide(app, scanId, "publish");
    expect((await fetchBadge(app, packageName, "next")).message).toBe("4.0.0-rc.1 approved");
    await decide(app, scanId, "no_publish");
    expect(await fetchBadge(app, packageName, "next")).toMatchObject({
      message: "4.0.0-rc.2 blocked",
      color: "red",
    });
  });

  test("a release whose tarball claims another name and version can still be declined onto the badge", async () => {
    const { owner, app, packageName } = await publisherWithDirectRelease();
    // Manifest confusion: the published tarball's package.json says it is
    // something else, which is exactly the release a maintainer must decline.
    const scanId = await seedPublishedReview(owner, packageName, "1.0.1", {
      manifest: { name: "left-pad", version: "9.9.9" },
    });
    await linkReview(owner, packageName, "1.0.1", scanId);
    expect((await decide(app, scanId, "no_publish")).postRelease).toMatchObject({
      packageName,
      version: "1.0.1",
      resolution: "declined_after_release",
      resolutionBadge: "applied",
    });
    expect(await fetchBadge(app, packageName)).toMatchObject({
      message: "1.0.1 blocked",
      color: "red",
    });
    expect((await fetchBadge(app, "left-pad")).message).toBe("not reviewed");
  });

  test("between publishers deciding the same release after it shipped, a decline wins", async () => {
    const { owner, app, packageName } = await publisherWithDirectRelease();
    // A second organization that also staged this name on public npm.
    const other = await seedUser();
    const otherApp = appFor(other);
    await seedStagedRelease(other, otherApp, packageName, "1.0.0", { decision: null });
    await seedAlert(other, packageName, "1.0.1");
    const approval = await seedPublishedReview(other, packageName, "1.0.1");
    await linkReview(other, packageName, "1.0.1", approval);

    const decline = await seedPublishedReview(owner, packageName, "1.0.1");
    await linkReview(owner, packageName, "1.0.1", decline);
    await decide(app, decline, "no_publish");
    // Deciding last does not let the other publisher answer green over it.
    await decide(otherApp, approval, "publish");
    expect(await fetchBadge(app, packageName)).toMatchObject({
      message: "1.0.1 blocked",
      color: "red",
    });
  });

  test("the badge section says a guarded decision answers only while it still would", async () => {
    const owner = await seedUser();
    const app = appFor(owner);
    const packageName = newPackage();
    // A publisher with nothing that answers by default: its one staged
    // review was of a stage npm reported as restricted.
    await seedStagedRelease(owner, app, packageName, "1.0.0", { access: "restricted" });
    await seedAlert(owner, packageName, "1.0.1");
    const read = async () =>
      (
        await (
          await call(app, "GET", `/api/v1/packages/${packageName}/badge`)
        ).json<{
          badge: { answersByDefault: boolean };
        }>()
      ).badge.answersByDefault;
    expect(await read()).toBe(false);
    const scanId = await seedPublishedReview(owner, packageName, "1.0.1");
    await linkReview(owner, packageName, "1.0.1", scanId);
    await decide(app, scanId, "publish");
    expect(await read()).toBe(true);
    await createDb(env.DB)
      .update(schema.scans)
      .set({ decision: "no_publish" })
      .where(eq(schema.scans.id, scanId));
    expect(await read()).toBe(false);
  });
});
