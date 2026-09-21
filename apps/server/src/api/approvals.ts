import type { ApprovalToken } from "@umail/api-contract";

export const APPROVAL_TTL_HOURS = 24;

export function approvalReviewUrl(applicationUrl: URL, token: ApprovalToken): string {
  return new URL(`/approvals/${encodeURIComponent(token)}`, applicationUrl.origin).href;
}
