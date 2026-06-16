import { existsSync, readFileSync } from "node:fs";

const marker = "<!-- drydock:detection-eval-report -->";
const reportPath = ".context/eval/detection-eval.md";
const maxBodyChars = 60_000;

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const eventPath = process.env.GITHUB_EVENT_PATH;

if (!token || !repository || !eventPath || !existsSync(reportPath)) {
  console.log("detection eval comment skipped: missing token, event, repository, or report");
  process.exit(0);
}

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const pullNumber = event.pull_request?.number;
if (!pullNumber) {
  console.log("detection eval comment skipped: not a pull_request event");
  process.exit(0);
}

const [owner, repo] = repository.split("/");
const report = readFileSync(reportPath, "utf8").trim();
const body = trimComment(`${marker}\n${report}\n\n_Updated by CI for this PR._`);

try {
  const comments = await github(
    "GET",
    `/repos/${owner}/${repo}/issues/${pullNumber}/comments?per_page=100`,
  );
  const existing = comments.find(
    (comment) => typeof comment.body === "string" && comment.body.includes(marker),
  );

  if (existing) {
    await github("PATCH", `/repos/${owner}/${repo}/issues/comments/${existing.id}`, { body });
    console.log(`updated detection eval report comment #${existing.id}`);
  } else {
    const created = await github("POST", `/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
      body,
    });
    console.log(`created detection eval report comment #${created.id}`);
  }
} catch (err) {
  console.log(
    `detection eval comment skipped: ${err instanceof Error ? err.message : String(err)}`,
  );
}

function trimComment(value) {
  if (value.length <= maxBodyChars) return value;
  const suffix =
    "\n\n_Report truncated for GitHub comment size; download the CI artifact for full JSON._";
  return `${value.slice(0, maxBodyChars - suffix.length)}${suffix}`;
}

async function github(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data
        ? String(data.message)
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data;
}
