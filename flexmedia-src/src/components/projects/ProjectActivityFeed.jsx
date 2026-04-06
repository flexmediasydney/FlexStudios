import React, { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";
import { api } from "@/api/supabaseClient";
import ActivityLogItem from "./ActivityLogItem";

const ITEMS_PER_PAGE = 30;

export default function ProjectActivityFeed({ projectId }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activities, setActivities] = useState([]);
  const [visibleCount, setVisibleCount] = useState(ITEMS_PER_PAGE);

  useEffect(() => {
    if (!projectId) return;

    let mounted = true;
    let retries = 0;

    const fetchActivities = async () => {
      try {
        const data = await api.entities.ProjectActivity.filter({ project_id: projectId }, "-created_date", 100);
        if (mounted) setActivities(data);
      } catch (err) {
        if (retries < 2 && err.message?.includes('Rate limit')) {
          retries++;
          setTimeout(fetchActivities, 2000);
        }
      }
    };

    fetchActivities();

    const unsub = api.entities.ProjectActivity.subscribe((event) => {
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
        <div className="text-center py-12">
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
            <Search className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">No activity yet</p>
          <p className="text-xs text-muted-foreground mt-1">Activity will appear here as changes are made</p>
        </div>
      ) : (
        <div className="pt-2 relative">
          {filtered.slice(0, visibleCount).map(activity => (
            <ActivityLogItem key={activity.id} activity={activity} />
          ))}
          {filtered.length > visibleCount && (
            <div className="flex justify-center pt-3 pb-1">
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setVisibleCount(prev => prev + ITEMS_PER_PAGE)}>
                Show more ({filtered.length - visibleCount} remaining)
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}