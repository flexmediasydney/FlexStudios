import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, AlertCircle, Clock, Zap, Target } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const MetricCard = ({ label, value, unit, trend, icon: Icon, color = 'primary' }) => {
  const colors = {
    primary: 'text-blue-600',
    success: 'text-green-600',
    warning: 'text-amber-600',
    destructive: 'text-red-600'
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Card className="p-6 bg-gradient-to-br from-card to-secondary/20 border-0 shadow-lg">
        <div className="flex justify-between items-start mb-4">
          <div>
            <p className="text-sm text-muted-foreground font-medium">{label}</p>
            <div className="flex items-baseline gap-1 mt-2">
              <motion.span
                className="text-3xl font-bold tracking-tight"
                key={value}
                initial={{ scale: 1.2, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.2 }}
              >
                {value}
              </motion.span>
              <span className="text-sm text-muted-foreground">{unit}</span>
            </div>
          </div>
          <motion.div
            className={cn('p-3 rounded-xl bg-secondary', colors[color])}
            whileHover={{ scale: 1.1 }}
          >
            <Icon className="h-5 w-5" />
          </motion.div>
        </div>
        {trend && (
          <motion.div
            className="flex items-center gap-1 text-xs font-medium"
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
          >
            <TrendingUp className={cn("h-4 w-4", trend.positive ? 'text-green-600' : 'text-red-600')} />
            <span className={trend.positive ? 'text-green-600' : 'text-red-600'}>
              {trend.positive ? '+' : ''}{trend.value}% vs last week
            </span>
          </motion.div>
        )}
      </Card>
    </motion.div>
  );
};

export default function LiveMetricsPanel({ metrics = [] }) {
  const defaultMetrics = [
    {
      id: 'active_projects',
      label: 'Active Projects',
      value: metrics[0]?.value || 0,
      unit: 'projects',
      icon: Target,
      color: 'primary',
      trend: { positive: true, value: 12 }
    },
    {
      id: 'hours_logged',
      label: 'Hours Logged Today',
      value: metrics[1]?.value || 0,
      unit: 'hrs',
      icon: Clock,
      color: 'success',
      trend: { positive: true, value: 8 }
    },
    {
      id: 'pending_tasks',
      label: 'Pending Tasks',
      value: metrics[2]?.value || 0,
      unit: 'tasks',
      icon: AlertCircle,
      color: 'warning'
    },
    {
      id: 'efficiency',
      label: 'Team Efficiency',
      value: metrics[3]?.value || 94,
      unit: '%',
      icon: Zap,
      color: 'success',
      trend: { positive: true, value: 5 }
    }
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {defaultMetrics.map((metric) => (
        <MetricCard key={metric.id} {...metric} />
      ))}
    </div>
  );
}