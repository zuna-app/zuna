import type { ReportReason } from "@zuna/core";
import { t } from "@/lib/i18n";

/**
 * What each reason for reporting someone to a server's admins is called, in the order offered,
 * in the language shown when it's read.
 */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  get spam() {
    return t("details.report.spam");
  },
  get harassment() {
    return t("details.report.harassment");
  },
  get inappropriate() {
    return t("details.report.inappropriate");
  },
  get other() {
    return t("details.report.other");
  },
};
