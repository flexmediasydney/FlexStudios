import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ListTodo, CheckCircle2, Clock } from "lucide-react";

export default function AdminTodoList() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
          <ListTodo className="h-8 w-8 text-primary" />
          Admin's Todo List
        </h1>
        <p className="text-muted-foreground mt-2">Personal notes and tasks for app management.</p>
      </div>

      <Card className="border-dashed bg-muted/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-muted-foreground" />
            Coming Soon
          </CardTitle>
          <CardDescription>Your personal notes and task list for this app.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-4">This feature is currently under development. Soon you'll be able to:</p>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Create and manage personal admin tasks
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Set priorities and due dates
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Track completion and progress
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}