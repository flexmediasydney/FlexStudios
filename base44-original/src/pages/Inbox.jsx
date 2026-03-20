import React from "react";
import EmailInboxMain from "@/components/email/EmailInboxMain";
import EmailErrorBoundary from "@/components/email/ErrorBoundary";
import Breadcrumb from "@/components/common/Breadcrumb";

export default function Inbox() {
  return (
    <EmailErrorBoundary>
      <div className="h-screen bg-background flex flex-col">
        <div className="px-6 pt-4 pb-2 border-b bg-gradient-to-b from-muted/10">
          <Breadcrumb items={[{ label: "Inbox" }]} className="mb-2" />
        </div>
        <div className="flex-1 overflow-auto">
          <EmailInboxMain />
        </div>
      </div>
    </EmailErrorBoundary>
  );
}