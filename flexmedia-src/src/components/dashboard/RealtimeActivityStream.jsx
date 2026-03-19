import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Clock, User, CheckCircle2, AlertCircle, MessageSquare, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { base44 } from '@/api/base44Client';

const ActivityIcon = ({ type }) => {
  const icons = {
    completed: <CheckCircle2 className="h-4 w-4 text-green-600" />,
    alert: <AlertCircle className="h-4 w-4 text-amber-600" />,
    comment: <MessageSquare className="h-4 w-4 text-blue-600" />,
    update: <Zap className="h-4 w-4 text-purple-600" />
  };
  return icons[type] || icons.update;
};

const ActivityItem = ({ activity, index }) => {
  const getTypeLabel = (type) => {
    const labels = {
      completed: { label: 'Completed', color: 'bg-green-100 text-green-800' },
      alert: { label: 'Alert', color: 'bg-amber-100 text-amber-800' },
      comment: { label: 'Comment', color: 'bg-blue-100 text-blue-800' },
      update: { label: 'Updated', color: 'bg-purple-100 text-purple-800' }
    };
    return labels[type] || labels.update;
  };

  const typeInfo = getTypeLabel(activity.type);
  const timeAgo = getTimeAgo(activity.timestamp);

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ delay: index * 0.05 }}
    >
      <div className="flex gap-4 p-4 rounded-lg border border-border/50 bg-card/50 hover:bg-card transition-colors">
        <div className="mt-1">
          <motion.div
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ duration: 2, repeat: Infinity, delay: index * 0.2 }}
          >
            {ActivityIcon({ type: activity.type })}
          </motion.div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-1">
            <Badge variant="secondary" className={typeInfo.color}>
              {typeInfo.label}
            </Badge>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {timeAgo}
            </span>
          </div>
          <p className="text-sm font-medium text-foreground">{activity.title}</p>
          <p className="text-xs text-muted-foreground mt-1">{activity.description}</p>
          {activity.user && (
            <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              <User className="h-3 w-3" />
              {activity.user}
            </p>
          )}
        </div>
      </div>
    </motion.div>
  );
};

const getTimeAgo = (timestamp) => {
   const now = new Date();
   const date = new Date(timestamp);
   const seconds = Math.floor((now - date) / 1000);

   if (seconds < 60) return 'just now';
   if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
   if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
   if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
   return date.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
 };

export default function RealtimeActivityStream({ maxItems = 10, autoRefresh = true }) {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Subscribe to ProjectActivity changes
    const unsubscribe = base44.entities.ProjectActivity.subscribe((event) => {
      if (event.type === 'create') {
        const newActivity = {
          id: event.id,
          title: event.data.description || 'Project Updated',
          description: event.data.action,
          type: event.data.action === 'delete' ? 'alert' : event.data.action === 'create' ? 'completed' : 'update',
          user: event.data.user_name,
          timestamp: new Date().toISOString(),
          project: event.data.project_title
        };
        setActivities(prev => [newActivity, ...prev.slice(0, maxItems - 1)]);
      }
    });

    setLoading(false);
    return unsubscribe;
  }, [maxItems]);

  return (
    <Card className="bg-gradient-to-br from-card to-secondary/10 border-0 shadow-lg overflow-hidden">
      <div className="p-6 border-b border-border/50">
        <h3 className="text-lg font-semibold">Live Activity Feed</h3>
        <p className="text-xs text-muted-foreground mt-1">Real-time project updates</p>
      </div>
      
      {activities.length === 0 ? (
        <div className="p-12 text-center text-muted-foreground">
          <p className="text-sm">No recent activity</p>
        </div>
      ) : (
        <div className="p-4 space-y-2 max-h-96 overflow-y-auto">
          <AnimatePresence mode="popLayout">
            {activities.map((activity, idx) => (
              <ActivityItem key={activity.id} activity={activity} index={idx} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </Card>
  );
}