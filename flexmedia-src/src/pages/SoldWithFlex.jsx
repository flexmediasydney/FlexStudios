import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function SoldWithFlex() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold">Sold with Flex</h1>
        <p className="text-muted-foreground mt-2">Leaderboard and links for successful Flex deals.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming Soon</CardTitle>
          <CardDescription>This page will display your Flex sales leaderboard and related links.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Placeholder content - implementation in progress.</p>
        </CardContent>
      </Card>
    </div>
  );
}