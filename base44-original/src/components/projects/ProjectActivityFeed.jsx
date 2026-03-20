import React, { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { base44 } from "@/api/base44Client";
import ActivityLogItem from "./ActivityLogItem";

export default function ProjectActivityFeed({ projectId }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activities, setActivities] = useState([]);

  useEffect(() => {
    if (!projectId) return;

    let mounted = true;
    let retries = 0;

    const fetchActivities = async () => {
      try {
        const data = await base44.entities.ProjectActivity.filter({ project_id: projectId }, "-created_date", 100);
        if (mounted) setActivities(data);
      } catch (err) {
        if (retries < 2 && err.message?.includes('Rate limit')) {
          retries++;
          setTimeout(fetchActivities, 2000);
        }
      }
    };

    fetchActivities();

    const unsub = base44.entities.ProjectActivity.subscribe((event) => {
      if (!mounted || event.data?.project_id !== projectId) return;

      if (event.type === 'create') {
        setActivities(prev => [event.data, ...prev].slice(0, 100));
      } else if (event.type === 'update') {
        setActivities(prev => prev.map(a => a.id === event.id ? event.data : a));
      } else if (event.type === 'delete') {
        setActivities(prev => prev.filter(a => a.id !== event.id));
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [projectId]);

  const filtered = searchQuery
    ? activities.filter(a =>
        a.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        a.user_name?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : activities;

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search activity..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No activity yet</p>
      ) : (
        <div className="pt-2">
          {filtered.map(activity => (
            <ActivityLogItem key={activity.id} activity={activity} />
          ))}
        </div>
      )}
    </div>
  );
}