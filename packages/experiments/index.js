export const packageName = "@pracht/experiments";

const defaultExperiments = Object.freeze({
  stagedPublishReview: true,
  packageDiffWorkbench: true,
  signedReportsPreview: true,
  implicitNodeGypProbe: true,
});

export function listExperiments() {
  return Object.entries(defaultExperiments).map(([name, enabled]) => ({ name, enabled }));
}

export function isExperimentEnabled(name) {
  return Boolean(defaultExperiments[name]);
}

export function describeExperiment(name) {
  const enabled = isExperimentEnabled(name);
  return `${name}: ${enabled ? "enabled" : "disabled"}`;
}
