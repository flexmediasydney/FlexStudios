import React from "react";
import EmailInboxMain from "@/components/email/EmailInboxMain";
import EmailErrorBoundary from "@/components/email/ErrorBoundary";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import Breadcrumb from "@/components/common/Breadcrumb";

export default function Inbox() {
  return (
    // Outer: email-specific boundary — full-screen "Reload page" for total inbox crashes
    <EmailErrorBoundary>
      {/* Layout's <main> has pt-14 lg:pt-12 (48-56px top bar offset). Using
          h-screen here would = 100vh and overflow the viewport by the top-bar
          height. Compute height so the pagination bar stays pinned inside. */}
      <div className="h-[calc(100dvh-3.5rem)] lg:h-[calc(100dvh-3rem)] bg-background flex flex-col">
        <div className="px-6 pt-4 pb-2 border-b bg-gradient-to-b from-muted/10">
          <Breadcrumb items={[{ label: "Inbox" }]} className="mb-2" />
        </div>
        {/* overflow-hidden (not overflow-auto) so EmailInboxMain's internal
            flex-col h-full actually constrains: the virtualized list scrolls
            inside, and the pagination bar stays pinned to the viewport bottom.
            Previous overflow-auto let content push past h-screen, and the
            pagination bar ended up ~y=2886 — invisible and unclickable. */}
        <div className="flex-1 overflow-hidden min-h-0">
          <ErrorBoundary fallbackLabel="Email Messages" compact>
            <EmailInboxMain />
          </ErrorBoundary>
        </div>
      </div>
    </EmailErrorBoundary>
  );
}
