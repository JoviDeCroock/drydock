import { z } from "zod";
import { canonicalJson } from "../platform/canonical-json";
import {
  base64UrlDecode,
  base64UrlEncode,
  hmacSha256,
  timingSafeEqual,
} from "../platform/crypto-utils";
import {
  validSetupSha,
  validSetupWorkflowPath,
  validSetupEnvironment,
  validSetupFilePath,
} from "./setup-api";
import { normalizeGithubEnvironmentName, parseRepositoryFullName } from "./validation";
import { SETUP_ARTIFACT_NAMES, type PublisherSetupProposal } from "./setup-types";

const text = z.string().min(1);
const contents = z
  .string()
  .max(65_536)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 65_536);
export const setupDraftRequestSchema = z
  .object({
    installationRowId: text.max(100),
    repositoryFullName: text.max(140).refine((value) => Boolean(parseRepositoryFullName(value))),
    workflowPath: text.refine(validSetupWorkflowPath),
    baseSha: text.refine(validSetupSha),
    environment: text
      .max(255)
      .transform(normalizeGithubEnvironmentName)
      .refine(validSetupEnvironment),
    ecosystem: z.enum(["npm", "pypi", "vscode"]),
  })
  .strict();
export const setupProposalSchema = setupDraftRequestSchema
  .extend({
    repositoryId: z.number().int().positive(),
    defaultBranch: text.max(255),
    originalSha: text.refine(validSetupSha),
    content: contents,
    summary: text.max(1000),
    manualSteps: z.array(text.max(500)).max(8),
    expiresAt: z.number().int().positive(),
    supportingFiles: z
      .array(
        z
          .object({
            path: text.refine(validSetupFilePath),
            content: contents,
            originalSha: text.refine(validSetupSha).nullable(),
            originalContent: contents.nullable(),
          })
          .strict()
          .refine(
            (file) =>
              (file.originalSha === null) === (file.originalContent === null) &&
              file.content !== file.originalContent,
          ),
      )
      .max(12)
      .optional(),
  })
  .superRefine((proposal, context) => {
    const paths = [
      proposal.workflowPath,
      ...(proposal.supportingFiles ?? []).map((file) => file.path),
    ];
    const bytes =
      new TextEncoder().encode(proposal.content).byteLength +
      (proposal.supportingFiles ?? []).reduce(
        (sum, file) => sum + new TextEncoder().encode(file.content).byteLength,
        0,
      );
    if (new Set(paths).size !== paths.length || bytes > 262_144)
      context.addIssue({ code: "custom", message: "Duplicate paths or oversized proposal." });
  });

export function setupManualSteps(
  proposal: Pick<PublisherSetupProposal, "repositoryFullName" | "environment" | "ecosystem">,
): string[] {
  return [
    "Review every workflow and script change in GitHub before merging; generated code requires maintainer review.",
    `Create the ${proposal.environment} GitHub Environment and enable the installed Drydock custom deployment-protection rule. Disable administrator bypass if your policy requires it.`,
    `Map ${proposal.repositoryFullName} / ${proposal.environment} as a Drydock release target using the ${SETUP_ARTIFACT_NAMES[proposal.ecosystem]} artifact.`,
    "If your policy requires actions pinned to commit SHAs, pin the artifact upload and download actions before merging.",
    "The setup commit includes [skip ci], so push and pull_request workflows do not run for it. If this repository requires status checks, push another commit or re-run checks before merging.",
    "Keep registry trusted-publishing/OIDC bound to the protected environment and ensure the publish job never rebuilds the reviewed artifact.",
    "Run your next release, complete its review in Drydock, then refresh setup checks. Other workflows and manual publishing paths remain independent.",
  ];
}

function signatureMessage(
  proposal: PublisherSetupProposal,
  organizationId: string,
  userId: string,
) {
  // Earlier proposal formats did not bind a generic agent-reviewed file set.
  return canonicalJson({
    purpose: "drydock.publisher-setup.agent-reviewed.v3",
    proposal,
    organizationId,
    userId,
  });
}
export async function signSetupProposal(
  secret: string,
  proposal: PublisherSetupProposal,
  organizationId: string,
  userId: string,
): Promise<string> {
  return base64UrlEncode(
    await hmacSha256(secret, signatureMessage(proposal, organizationId, userId)),
  );
}
export async function verifySetupProposal(
  secret: string,
  proposal: PublisherSetupProposal,
  token: string,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  if (
    proposal.expiresAt <= Date.now() ||
    proposal.expiresAt > Date.now() + 30 * 60_000 ||
    !/^[A-Za-z0-9_-]{43}$/.test(token)
  )
    return false;
  try {
    return timingSafeEqual(
      await hmacSha256(secret, signatureMessage(proposal, organizationId, userId)),
      base64UrlDecode(token),
    );
  } catch {
    return false;
  }
}
