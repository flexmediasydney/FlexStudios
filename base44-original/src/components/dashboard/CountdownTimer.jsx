import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Card } from '@/components/ui/card';
import { Clock, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

const TimeUnit = ({ label, value, isWarning = false }) => {
  return (
    <motion.div
      className="flex flex-col items-center"
      initial={{ scale: 1 }}
      animate={{ scale: isWarning ? [1, 1.05, 1] : 1 }}
      transition={{ duration: isWarning ? 0.6 : 0.3, repeat: isWarning ? Infinity : 0 }}
    >
      <motion.div
        className={cn(
          'relative w-16 h-16 rounded-lg flex items-center justify-center font-mono font-bold text-xl',
          isWarning 
            ? 'bg-red-100 text-red-700 shadow-lg shadow-red-200' 
            : 'bg-gradient-to-br from-primary/20 to-primary/10 text-primary border border-primary/20'
        )}
        key={value}
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
      >
        {String(value).padStart(2, '0')}
      </motion.div>
      <label className="text-xs font-medium text-muted-foreground mt-2 uppercase tracking-wider">
        {label}
      </label>
    </motion.div>
  );
};

export default function CountdownTimer({ 
  targetDate, 
  title = 'Countdown', 
  onComplete = null,
  warningThreshold = 3600000 // 1 hour in ms
}) {
  const [timeLeft, setTimeLeft] = useState(null);
  const [isWarning, setIsWarning] = useState(false);
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date().getTime();
      const target = new Date(targetDate).getTime();
      const difference = target - now;

      if (difference <= 0) {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0 });
        setIsComplete(true);
        if (onComplete) onComplete();
        clearInterval(timer);
        return;
      }

      setIsWarning(difference <= warningThreshold);

      const days = Math.floor(difference / (1000 * 60 * 60 * 24));
      const hours = Math.floor((difference / (1000 * 60 * 60)) % 24);
      const minutes = Math.floor((difference / 1000 / 60) % 60);
      const seconds = Math.floor((difference / 1000) % 60);

      setTimeLeft({ days, hours, minutes, seconds });
    }, 1000);

    return () => clearInterval(timer);
  }, [targetDate, onComplete, warningThreshold]);

  if (!timeLeft) {
    return (
      <Card className="p-8 bg-gradient-to-br from-card to-secondary/10">
        <div className="text-center text-muted-foreground">Loading countdown...</div>
      </Card>
    );
  }

  return (
    <Card className={cn(
      'p-8 bg-gradient-to-br from-card to-secondary/10 border-0 shadow-lg',
      isComplete && 'ring-2 ring-green-500',
      isWarning && 'ring-2 ring-red-500'
    )}>
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          {isWarning && (
            <motion.div animate={{ rotate: [0, 15, -15, 0] }} transition={{ duration: 0.5, repeat: Infinity }}>
              <AlertTriangle className="h-5 w-5 text-red-600" />
            </motion.div>
          )}
          <h3 className="text-lg font-semibold">{title}</h3>
        </div>

        {isComplete ? (
          <motion.div
            className="text-center py-4 bg-green-100 rounded-lg"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200 }}
          >
            <p className="text-green-800 font-bold">Completed!</p>
          </motion.div>
        ) : (
          <div className="grid grid-cols-4 gap-2 md:gap-4">
            <TimeUnit label="Days" value={timeLeft.days} isWarning={isWarning} />
            <TimeUnit label="Hours" value={timeLeft.hours} isWarning={isWarning} />
            <TimeUnit label="Minutes" value={timeLeft.minutes} isWarning={isWarning} />
            <TimeUnit label="Seconds" value={timeLeft.seconds} isWarning={isWarning} />
          </div>
        )}

        <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
          <motion.div
            className={cn(
              'h-full',
              isWarning ? 'bg-gradient-to-r from-red-500 to-orange-500' : 'bg-gradient-to-r from-green-500 to-blue-500'
            )}
            initial={{ width: '100%' }}
            animate={{ width: isComplete ? '0%' : 'auto' }}
            transition={{ duration: 1 }}
          />
        </div>

        {timeLeft.days === 0 && timeLeft.hours === 0 && timeLeft.minutes < 5 && (
          <motion.p
            className="text-xs text-amber-600 font-medium text-center"
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            ⚡ Urgent - Less than 5 minutes remaining
          </motion.p>
        )}
      </div>
    </Card>
  );
}