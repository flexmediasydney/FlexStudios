import { useState, useEffect, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Layers, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { parseTS, relativeTime } from "@/components/tonomo/tonomoUtils";

/**
 * BookingHealthMonitor — compact health dashboard for the Tonomo bookings engine.
 * Designed to be embedded on the main Dashboard page.
 * Displays queue depth, processing rate, error rate, and last successful sync.
 * Uses polling (via react-query refetchInterval) to stay up to date.
 */
export default function BookingHealthMonitor() {
  const queryClient = useQueryClient();

  const { data: queue = [] } = useQuery({
    queryKey: ['healthMonitor-queue'],
    queryFn: () => api.entities.TonomoProcessingQueue.list('-created_date', 200),
    refetchInterval: 10000,
  });

  const { data: settings } = useQuery({
    queryKey: ['healthMonitor-settings'],
    queryFn: async () => {
      const all = await api.entities.TonomoIntegrationSettings.list('-created_date', 1);
      return all[0] || null;
    },
    refetchInterval: 30000,
  });

  // Derived metrics
  const metrics = useMemo(() => {
    const pending = queue.filter(q => q.status === 'pending').length;
    const processing = queue.filter(q => q.status === 'processing').length;
    const completed = queue.filter(q => q.status === 'completed');
    const failed = queue.filter(q => q.status === 'failed').length;
    const deadLetter = queue.filter(q => q.status === 'dead_letter').length;

    const queueDepth = pending + processing;

    // Processing rate: completed items in the last hour
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentCompleted = completed.filter(q => {
      const d = parseTS(q.processed_at);
      return d && d.getTime() > oneHourAgo;
    });
    const processingRate = recentCompleted.length;

    // Error rate: failed + dead_letter as percentage of all non-pending
    const totalProcessed = completed.length + failed + deadLetter;
    const errorRate = totalProcessed > 0
      ? Math.round(((failed + deadLetter) / totalProcessed) * 100)
      : 0;

    // Last successful sync
    const lastSuccess = completed
      .map(q => parseTS(q.processed_at))
      .filter(Boolean)
      .sort((a, b) => b.getTime() - a.getTime())[0] || null;

    // Overall health status
    let healthStatus, healthColor, healthLabel;
    if (deadLetter > 3 || errorRate > 20) {
      healthStatus = 'error';
      healthColor = 'bg-red-500';
      healthLabel = 'Unhealthy';
    } else if (queueDepth > 10 || errorRate > 5) {
      healthStatus = 'warning';
      healthColor = 'bg-yellow-500';
      healthLabel = 'Degraded';
    } else {
      healthStatus = 'healthy';
      healthColor = 'bg-green-500';
      healthLabel = 'Healthy';
    }

    return {
      queueDepth,
      processingRate,
      errorRate,
      lastSuccess,
      healthStatus,
      healthColor,
      healthLabel,
      pending,
      processing,
      failed,
      deadLetter,
    };
  }, [queue]);

  // Heartbeat freshness — re-evaluate periodically, not just when settings change
  const [freshnessTick, setFreshnessTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFreshnessTick(t => t + 1), 30000); // tick every 30s
    return () => clearInterval(timer);
  }, []);

  const heartbeatFresh = useMemo(() => {
    if (!settings?.heartbeat_at) return false;
    const hb = parseTS(settings.heartbeat_at);
    return hb && (Date.now() - hb.getTime()) < 10 * 60 * 1000; // within 10 min
  }, [settings, freshnessTick]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Bookings Engine
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <div className={`h-2 w-2 rounded-full ${metrics.healthColor} ${metrics.healthStatus !== 'healthy' ? 'animate-pulse' : ''}`} />
            <span className="text-[11px] font-medium text-muted-foreground">{metrics.healthLabel}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-3">
          {/* Queue Depth */}
          <div className="rounded-lg border p-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <Layers className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Queue Depth</span>
            </div>
            <p className={`text-xl font-bold tabular-nums ${metrics.queueDepth > 5 ? 'text-amber-600' : ''}`}>
              {metrics.queueDepth}
            </p>
            {metrics.queueDepth > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {metrics.pending} pending, {metrics.processing} processing
              </p>
            )}
          </div>

          {/* Processing Rate */}
          <div className="rounded-lg border p-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <CheckCircle2 className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Rate / hr</span>
            </div>
            <p className="text-xl font-bold tabular-nums text-green-600">
              {metrics.processingRate}
            </p>
            <p className="text-[10px] text-muted-foreground">completed last hour</p>
          </div>

          {/* Error Rate */}
          <div className="rounded-lg border p-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <AlertTriangle className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Error Rate</span>
            </div>
            <p className={`text-xl font-bold tabular-nums ${
              metrics.errorRate > 10 ? 'text-red-600' :
              metrics.errorRate > 0 ? 'text-amber-600' : 'text-green-600'
            }`}>
              {metrics.errorRate}%
            </p>
            {(metrics.failed > 0 || metrics.deadLetter > 0) && (
              <p className="text-[10px] text-muted-foreground">
                {metrics.failed} failed, {metrics.deadLetter} dead
              </p>
            )}
          </div>

          {/* Last Successful Sync */}
          <div className="rounded-lg border p-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Last Sync</span>
            </div>
            <p className="text-sm font-semibold">
              {metrics.lastSuccess ? relativeTime(metrics.lastSuccess) : 'Never'}
            </p>
            <div className="flex items-center gap-1 mt-0.5">
              <div className={`h-1.5 w-1.5 rounded-full ${heartbeatFresh ? 'bg-green-500' : 'bg-red-500'}`} />
              <p className="text-[10px] text-muted-foreground">
                Heartbeat: {settings?.heartbeat_at ? relativeTime(parseTS(settings.heartbeat_at)) : 'None'}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
