import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertCircle, CheckCircle2, Clock, X, Bell } from 'lucide-react';
import { cn } from '@/lib/utils';

const PriorityBadge = ({ priority }) => {
  const styles = {
    critical: 'bg-red-100 text-red-800 border-red-300',
    high: 'bg-orange-100 text-orange-800 border-orange-300',
    medium: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    low: 'bg-blue-100 text-blue-800 border-blue-300'
  };
  return (
    <Badge variant="outline" className={cn(styles[priority] || styles.medium)}>
      {(priority || 'medium').toUpperCase()}
    </Badge>
  );
};

const TicketItem = ({ ticket, onDismiss, index }) => {
  const getPulseIntensity = (priority) => {
    const intensities = {
      critical: 'shadow-lg shadow-red-500/50',
      high: 'shadow-lg shadow-orange-500/30',
      medium: 'shadow-lg shadow-yellow-500/20',
      low: 'shadow-lg shadow-blue-500/10'
    };
    return intensities[priority] || intensities.medium;
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: -30, y: -20 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      exit={{ opacity: 0, x: 30, y: -20 }}
      transition={{ delay: index * 0.1 }}
      className={cn(
        'p-4 rounded-lg border bg-card relative overflow-hidden',
        getPulseIntensity(ticket.priority)
      )}
    >
      {/* Animated background shimmer */}
      <motion.div
        className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent"
        animate={{ x: ['-100%', '100%'] }}
        transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
      />

      <div className="relative z-10 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 flex-1">
            <motion.div
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              {ticket.priority === 'critical' ? (
                <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
              ) : (
                <Bell className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
              )}
            </motion.div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <h4 className="font-semibold text-sm">{ticket.title}</h4>
                <PriorityBadge priority={ticket.priority} />
              </div>
              <p className="text-xs text-muted-foreground">{ticket.description}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 flex-shrink-0"
            onClick={() => onDismiss(ticket.id)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {getTimeAgo(ticket.createdAt)}
        </div>

        {ticket.action && (
          <Button size="sm" variant="outline" className="text-xs w-full">
            {ticket.action}
          </Button>
        )}
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
  return `${Math.floor(seconds / 3600)}h ago`;
};

export default function AlertTicketsPanel({ initialTickets = [] }) {
  const [tickets, setTickets] = useState(initialTickets);
  const [dismissedCount, setDismissedCount] = useState(0);

  const criticalCount = tickets.filter(t => t.priority === 'critical').length;
  const highCount = tickets.filter(t => t.priority === 'high').length;

  const handleDismiss = (ticketId) => {
    setTickets(prev => prev.filter(t => t.id !== ticketId));
    setDismissedCount(prev => prev + 1);
  };

  return (
    <div className="space-y-4">
      {/* Header with stats */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Alerts & Tickets</h3>
        <div className="flex items-center gap-2">
          {criticalCount > 0 && (
            <motion.div
              animate={{ scale: [1, 1.1, 1] }}
              transition={{ duration: 1, repeat: Infinity }}
              className="flex items-center gap-1 px-2 py-1 rounded-full bg-red-100 text-red-700 text-xs font-medium"
            >
              <AlertCircle className="h-3 w-3" />
              {criticalCount} Critical
            </motion.div>
          )}
          {highCount > 0 && (
            <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-orange-100 text-orange-700 text-xs font-medium">
              <Bell className="h-3 w-3" />
              {highCount} High
            </div>
          )}
        </div>
      </div>

      {/* Tickets list */}
      <Card className="bg-gradient-to-br from-card to-secondary/10 border-0 shadow-lg p-4 space-y-2 max-h-96 overflow-y-auto">
        <AnimatePresence mode="popLayout">
          {tickets.length === 0 ? (
            <motion.div
              className="p-8 text-center text-muted-foreground"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
              >
                <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-600" />
              </motion.div>
              <p className="text-sm">All systems nominal</p>
              {dismissedCount > 0 && (
                <p className="text-xs text-muted-foreground mt-2">
                  Resolved {dismissedCount} {dismissedCount === 1 ? 'alert' : 'alerts'} today
                </p>
              )}
            </motion.div>
          ) : (
            tickets.map((ticket, idx) => (
              <TicketItem
                key={ticket.id}
                ticket={ticket}
                onDismiss={handleDismiss}
                index={idx}
              />
            ))
          )}
        </AnimatePresence>
      </Card>
    </div>
  );
}