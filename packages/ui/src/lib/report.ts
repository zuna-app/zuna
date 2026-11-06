import type { ReportReason } from "@zuna/core";

/** What each reason for reporting someone to a server's admins is called, in the order offered. */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: "Spam",
  harassment: "Harassment",
  inappropriate: "Inappropriate content",
  other: "Something else",
};
