export default function LandingPage() {
  return (
    <main class="page landing-page">
      <section class="hero-card">
        <p class="eyebrow">Staged publish release review</p>
        <h1>Explore staged npm packages without trusting package bytes.</h1>
        <p class="lead">
          Sandboxed staged-tarball download, deterministic supply-chain checks, previous-version diffs,
          Better Auth, Drizzle/D1 persistence, and Kimi K2.5 AI triage before manual approval.
        </p>
        <div class="hero-actions">
          <a class="button primary" href="/register">Create account</a>
          <a class="button secondary" href="/login">Sign in</a>
        </div>
      </section>

      <section class="feature-grid" aria-label="Safety features">
        <article>
          <h2>Token isolation</h2>
          <p>The npm token stays in the parent worker. The Dynamic Worker sandbox only fetches through a locked-down npm gateway.</p>
        </article>
        <article>
          <h2>Diff-first review</h2>
          <p>Review what changed from the published version: scripts, dependencies, entrypoints, files, binaries, and suspicious code paths.</p>
        </article>
        <article>
          <h2>Prompt-injection resistant</h2>
          <p>Package contents are hostile evidence, not instructions. Kimi K2.5 receives a static cached safety prompt and schema-constrained output.</p>
        </article>
      </section>
    </main>
  );
}
