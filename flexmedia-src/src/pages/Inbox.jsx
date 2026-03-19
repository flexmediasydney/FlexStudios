import React from "react";
import EmailInboxMain from "@/components/email/EmailInboxMain";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import Breadcrumb from "@/components/common/Breadcrumb";

export default function Inbox() {
  return (
    <ErrorBoundary fallbackLabel="Email Inbox">
      <div className="h-screen bg-background flex flex-col">
        <div className="px-6 pt-4 pb-2 border-b bg-gradient-to-b from-muted/10">
          <Breadcrumb items={[{ label: "Inbox" }]} className="mb-2" />
        </div>
        <div className="flex-1 overflow-auto">
          <ErrorBoundary fallbackLabel="Email Messages" compact>
            <EmailInboxMain />
          </ErrorBoundary>
        </div>
      </div>
    </ErrorBoundary>
  );
}
