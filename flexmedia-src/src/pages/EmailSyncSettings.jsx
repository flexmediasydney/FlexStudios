import { useState, useEffect } from "react";
import { Mail, Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import EmailAccountSettingsTab from "@/components/email/EmailAccountSettingsTab";
import EmailLabelsTab from "@/components/email/EmailLabelsTab";

export default function EmailSyncSettings() {
  const [activeTab, setActiveTab] = useState("account");

  const settingsNavigation = [
    {
      id: "account",
      name: "Email account",
      icon: Mail,
      component: EmailAccountSettingsTab,
    },
    {
      id: "labels",
      name: "Labels",
      icon: Tag,
      component: EmailLabelsTab,
    },
  ];

  const ActiveComponent = settingsNavigation.find(
    (nav) => nav.id === activeTab
  )?.component;

  return (
    <div className="flex h-screen">
      <aside className="w-64 border-r bg-card p-6 flex flex-col">
        <h2 className="text-xl font-semibold mb-6">Email Settings</h2>
        <nav className="space-y-1">
          {settingsNavigation.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors w-full justify-start",
                activeTab === item.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.name}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex-1 overflow-y-auto p-6">
        {ActiveComponent && <ActiveComponent />}
      </main>
    </div>
  );
}