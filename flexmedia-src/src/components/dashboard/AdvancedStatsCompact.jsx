import React from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown, Activity, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

const StatCompact = ({ label, current, previous, format = 'number', icon: Icon }) => {
  const change = current - previous;
  const percentChange = previous !== 0 ? ((change / previous) * 100).toFixed(1) : 0;
  const isPositive = change >= 0;

  const formatValue = (val) => {
    if (format === 'number') return val.toLocaleString();
    if (format === 'time') return `${val}h`;
    if (format === 'percent') return `${val}%`;
    return val;
  };

  return (
    <motion.div
      className="p-3 rounded-lg bg-secondary/50 border border-border/30 hover:border-border/60 transition-colors"
      whileHover={{ scale: 1.02 }}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
          <motion.div
            className="text-xl font-bold mt-1 tabular-nums"
            key={current}
            initial={{ scale: 1.1 }}
            animate={{ scale: 1 }}
            transition={{ duration: 0.2 }}
          >
            {formatValue(current)}
          </motion.div>
        </div>
        <div className="flex items-center gap-2">
          <motion.div
            className={cn(
              'p-2 rounded-lg',
              isPositive ? 'bg-green-100' : 'bg-red-100'
            )}
            animate={{ rotate: [0, 5, -5, 0] }}
            transition={{ duration: 0.5, repeat: Infinity, repeatDelay: 2 }}
          >
            {isPositive ? (
              <TrendingUp className="h-4 w-4 text-green-600" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-600" />
            )}
          </motion.div>
          <div className="text-right">
            <motion.span
              className={cn(
                'text-xs font-bold',
                isPositive ? 'text-green-600' : 'text-red-600'
              )}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              {isPositive ? '+' : ''}{percentChange}%
            </motion.span>
            <p className="text-xs text-muted-foreground">vs prev</p>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export default function AdvancedStatsCompact({ stats = [] }) {
  const defaultStats = [
    {
      label: 'Revenue',
      current: stats[0]?.current || 24500,
      previous: stats[0]?.previous || 22100,
      format: 'currency',
      icon: Zap
    },
    {
      label: 'Utilization',
      current: stats[1]?.current || 87,
      previous: stats[1]?.previous || 82,
      format: 'percent',
      icon: Activity
    },
    {
      label: 'Completion',
      current: stats[2]?.current || 94,
      previous: stats[2]?.previous || 89,
      format: 'percent',
      icon: Activity
    },
    {
      label: 'Avg Time',
      current: stats[3]?.current || 3.2,
      previous: stats[3]?.previous || 3.8,
      format: 'time',
      icon: Activity
    }
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
      {defaultStats.map((stat, idx) => (
        <motion.div
          key={idx}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: idx * 0.05 }}
        >
          <StatCompact {...stat} />
        </motion.div>
      ))}
    </div>
  );
}