import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function BountyBoard() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold">Bounty Board</h1>
        <p className="text-muted-foreground mt-2">Community bounties and tasks.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming Soon</CardTitle>
          <CardDescription>Post and track bounties for community contributions.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Placeholder content - implementation in progress.</p>
        </CardContent>
      </Card>
    </div>
  );
}