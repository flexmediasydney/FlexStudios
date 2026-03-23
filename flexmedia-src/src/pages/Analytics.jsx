import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart2, FileBarChart, Users, Activity } from "lucide-react";
import BusinessIntelligence from "./BusinessIntelligence";
import Reports from "./Reports";
import EmployeeUtilization from "./EmployeeUtilization";
import TeamPulsePage from "./TeamPulsePage";

const TABS = [
  { id: "overview",      label: "Overview",       icon: BarChart2,    component: BusinessIntelligence },
  { id: "reports",       label: "Reports",        icon: FileBarChart, component: Reports },
  { id: "utilisation",   label: "Utilisation",    icon: Users,        component: EmployeeUtilization },
  { id: "pulse",         label: "Team Pulse",     icon: Activity,     component: TeamPulsePage },
];

export default function Analytics() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(
    searchParams.get("tab") || "overview"
  );

  // Keep URL in sync so deep-links work
  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setSearchParams({ tab }, { replace: true });
  };

  // Sync if URL param changes externally
  useEffect(() => {
    const t = searchParams.get("tab");
    if (t && t !== activeTab) setActiveTab(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col flex-1 min-h-0">
        {/* Top tab bar */}
        <div className="border-b bg-card px-4 pt-3 shrink-0">
          <TabsList className="gap-1 bg-transparent p-0 h-auto">
            {TABS.map(({ id, label, icon: Icon }) => (
              <TabsTrigger
                key={id}
                value={id}
                className="flex items-center gap-1.5 px-4 py-2.5 text-sm
                           rounded-none border-b-2 border-transparent
                           data-[state=active]:border-primary
                           data-[state=active]:text-primary
                           data-[state=active]:bg-transparent
                           data-[state=inactive]:text-muted-foreground
                           hover:text-foreground transition-colors"
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {/* Each tab renders the full existing page component */}
        {TABS.map(({ id, component: Component }) => (
          <TabsContent key={id} value={id} className="mt-0 p-0 flex-1 min-h-0">
            <div className="h-full overflow-y-auto">
              <Component />
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}