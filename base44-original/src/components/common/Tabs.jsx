import { Tabs as TabsUI, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export function TabsWithContent({ tabs = [], defaultValue, onValueChange }) {
  return (
    <TabsUI defaultValue={defaultValue || tabs[0]?.value} onValueChange={onValueChange}>
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.value} value={tab.value} className="mt-4">
          {tab.content}
        </TabsContent>
      ))}
    </TabsUI>
  );
}