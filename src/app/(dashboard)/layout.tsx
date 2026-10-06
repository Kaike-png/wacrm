import type { Metadata } from "next";
import { DashboardShell } from "./dashboard-shell";
// FORK-PATCH(P-014): delinquency banner (past_due / suspended / cancelled) — docs/DELINQUENCY.md
import { TenantAccessNotice } from "@/billing/access-notice";

// Server layout whose only job is to declare "do not index" metadata
// for the authed app. robots.ts already disallows these paths at the
// crawler-level and middleware redirects unauthenticated visitors, so
// this is belt-and-suspenders — but SEO-critical if a URL ever leaks
// via a link shared externally.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DashboardShell>
      <TenantAccessNotice />{/* FORK-PATCH(P-014) */}
      {children}
    </DashboardShell>
  );
}
