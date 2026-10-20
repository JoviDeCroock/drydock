// Stands in for a browser-only payload: under Node there is no window, so
// loading it does nothing and the sandbox sees a clean run.
if (typeof window !== "undefined") {
  window.drydockFixtureLoaded = true;
}
module.exports = { ok: true };
