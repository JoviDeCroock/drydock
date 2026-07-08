// Turn raw observation events (from the Node preload log, the shimmed CLI
// tools, and the sink) into a behavior report shaped to attach to a Drydock
// scan. The report is the only contract between this prototype and Drydock:
// the Worker would ingest `findings` as a `detonation` source alongside the
// deterministic rule findings — it never runs this harness in-process.

export const DETONATION_REPORT_SCHEMA = "drydock.detonation.v1";

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

// Each behavior class maps to a stable ruleId + severity, so a detonation
// finding reads like any other Drydock finding.
const BEHAVIOR_RULES = {
  "credential.exfil": {
    ruleId: "detonation.credential-exfil",
    severity: "critical",
    reason: "A planted credential canary was sent off-host during install.",
  },
  "credential.read": {
    ruleId: "detonation.credential-access",
    severity: "high",
    reason: "Install-time code read a credential file it has no reason to touch.",
  },
  "net.egress.blocked": {
    ruleId: "detonation.network-egress",
    severity: "high",
    reason: "Install-time code attempted to connect to a non-local host.",
  },
  "net.connect.external": {
    ruleId: "detonation.network-egress",
    severity: "high",
    reason: "Install-time code connected to a non-local host.",
  },
  "http.request.external": {
    ruleId: "detonation.network-egress",
    severity: "medium",
    reason: "Install-time code issued an HTTP request to a non-local host.",
  },
  "fs.write.outside": {
    ruleId: "detonation.fs-persistence",
    severity: "medium",
    reason: "Install-time code wrote outside the package directory (possible persistence).",
  },
  "process.spawn.tool": {
    ruleId: "detonation.suspicious-spawn",
    severity: "medium",
    reason: "Install-time code shelled out to a network/exfiltration tool.",
  },
  "process.spawn": {
    ruleId: "detonation.process-spawn",
    severity: "low",
    reason: "Install-time code spawned a subprocess.",
  },
};

const EXFIL_TOOLS = new Set(["curl", "wget", "nc", "ncat", "python", "python3", "node"]);

// Collapse the raw event stream into deduped, severity-ranked behaviors.
export function buildBehaviors(events) {
  const behaviors = new Map();

  const add = (kind, evidence, extra = {}) => {
    const rule = BEHAVIOR_RULES[kind];
    if (!rule) return;
    const key = `${kind}:${evidence}`;
    if (behaviors.has(key)) {
      behaviors.get(key).count += 1;
      return;
    }
    behaviors.set(key, { kind, ...rule, evidence, count: 1, ...extra });
  };

  for (const event of events) {
    switch (event.type) {
      case "credential.exfil":
        add("credential.exfil", `${event.token} via ${event.via}`);
        break;
      case "credential.read":
        add("credential.read", event.path);
        break;
      case "net.egress.blocked":
        add("net.egress.blocked", `${event.host}:${event.port ?? ""}`);
        break;
      case "net.connect":
        if (!event.loopback) add("net.connect.external", `${event.host}:${event.port ?? ""}`);
        break;
      case "http.request":
        if (event.host && !isLoopbackHost(event.host)) {
          add("http.request.external", `${event.method} ${event.host}${event.path ?? ""}`);
        }
        break;
      case "fs.write.outside":
        add("fs.write.outside", event.path);
        break;
      case "process.spawn": {
        const tool = basename(event.command);
        if (EXFIL_TOOLS.has(tool)) {
          add("process.spawn.tool", `${tool} ${event.args.join(" ")}`.trim());
        } else {
          add("process.spawn", `${event.command} ${event.args.join(" ")}`.trim());
        }
        break;
      }
      case "tool.invoked":
        add("process.spawn.tool", `${event.tool} ${(event.args || []).join(" ")}`.trim(), {
          via: "path-shim",
        });
        if (event.leakedToken) {
          add("credential.exfil", `${event.leakedToken} via ${event.tool}`);
        }
        break;
      default:
        break;
    }
  }

  return [...behaviors.values()].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
}

export function verdictFor(behaviors) {
  if (behaviors.some((b) => b.severity === "critical")) return "critical";
  if (behaviors.some((b) => b.severity === "high")) return "high";
  if (behaviors.some((b) => b.severity === "medium")) return "medium";
  if (behaviors.length > 0) return "low";
  return "clean";
}

export function buildReport({ packageInfo, mode, durationMs, events, sinkRequests }) {
  const merged = [...events, ...sinkEventsToBehaviorEvents(sinkRequests)];
  const behaviors = buildBehaviors(merged);
  const verdict = verdictFor(behaviors);
  return {
    schema: DETONATION_REPORT_SCHEMA,
    package: packageInfo,
    mode,
    durationMs,
    verdict,
    behaviorCount: behaviors.length,
    behaviors,
    // Drydock-shaped findings — one per observed behavior.
    findings: behaviors.map((behavior) => ({
      source: "detonation",
      severity: behavior.severity,
      ruleId: behavior.ruleId,
      evidence: behavior.evidence,
      reason: behavior.reason,
      observedCount: behavior.count,
    })),
  };
}

// The sink observed raw HTTP hits; fold anything with a leaked canary into a
// credential.exfil behavior (it already reached "the internet" as far as the
// payload knows).
function sinkEventsToBehaviorEvents(sinkRequests = []) {
  const out = [];
  for (const request of sinkRequests) {
    if (request.leakedToken) {
      out.push({ type: "credential.exfil", token: request.leakedToken, via: "sink" });
    }
  }
  return out;
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

function basename(command) {
  const parts = String(command).split(/[\\/]/);
  return parts[parts.length - 1];
}
