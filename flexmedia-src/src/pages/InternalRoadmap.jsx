import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function InternalRoadmap() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold">Internal Roadmap</h1>
        <p className="text-muted-foreground mt-2">Product development roadmap and feature tracking.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming Soon</CardTitle>
          <CardDescription>Like the Monday.com board we used to have - track features and milestones.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Placeholder content - implementation in progress.</p>
        </CardContent>
      </Card>
    </div>
  );
}