import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export default function SimpleTabs({ tabs = [], defaultTab = "0" }) {
  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList>
        {tabs.map((tab, idx) => (
          <TabsTrigger key={idx} value={String(idx)}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab, idx) => (
        <TabsContent key={idx} value={String(idx)}>
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}