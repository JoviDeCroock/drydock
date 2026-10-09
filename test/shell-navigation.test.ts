import { afterEach, describe, expect, test } from "vitest";
import { h } from "preact";
import { signal } from "@preact/signals";
import { LocationProvider } from "preact-iso";
import prerender, { locationStub } from "preact-iso/prerender";
import { sessionModel, type AuthSession } from "../src/models/auth";
import { MarketingHeaderActions } from "../src/pages/MarketingHeaderActions";
import NotFoundPage from "../src/pages/NotFound";

function linkLabels(html: string): string[] {
  return [...html.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map(([, label]) => label);
}

async function renderHeader(path: string, authed: boolean) {
  locationStub(path);
  const { html } = await prerender(
    h(LocationProvider, null, h(MarketingHeaderActions, { authed: signal(authed) })),
  );
  return html;
}

describe("marketing header", () => {
  test("signed out, it ends on sign in instead of a second way home", async () => {
    const html = await renderHeader("/docs", false);

    expect(linkLabels(html)).toEqual(["Package diff", "Docs", "Sign in"]);
    expect(html).toContain('href="/login"');
  });

  test("signing in from a package diff returns to it", async () => {
    const html = await renderHeader("/diff/preact/10.0.0/10.1.0", false);

    expect(html).toContain('href="/login?returnTo=%2Fdiff%2Fpreact%2F10.0.0%2F10.1.0"');
  });

  test("signed in, it leads back to reviews", async () => {
    const html = await renderHeader("/docs", true);

    expect(linkLabels(html)).toEqual(["Reviews", "Package diff", "Docs"]);
    expect(html).toContain('href="/dashboard"');
  });
});

describe("not found page", () => {
  afterEach(() => {
    sessionModel.session.value = null;
  });

  test("signed out, it leads home", async () => {
    locationStub("/missing");
    const { html } = await prerender(h(LocationProvider, null, h(NotFoundPage, {})));

    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Back to home<\/a>/);
  });

  test("signed in, both the brand mark and the way back lead to reviews", async () => {
    sessionModel.session.value = { user: { id: "u1" } } as AuthSession;
    locationStub("/missing");
    const { html } = await prerender(h(LocationProvider, null, h(NotFoundPage, {})));

    expect(html).toMatch(/<a [^>]*href="\/dashboard"[^>]*>Back to reviews<\/a>/);
    expect(html).toContain('aria-label="Drydock dashboard"');
    expect(html).not.toContain("Back to home");
  });
});
