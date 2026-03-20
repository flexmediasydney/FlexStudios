import React, { useState, useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import { fmtTimestampCustom } from '@/components/utils/dateUtils';

export default function ConcurrentEditDetector({ project, onRefresh }) {
  const [concurrentEdit, setConcurrentEdit] = useState(null);
  const currentUserEmail = useRef(null);
  const lastKnownVersion = useRef(project?.updated_date ?? null);

  useEffect(() => {
    const getUser = async () => {
      const user = await base44.auth.me();
      currentUserEmail.current = user?.email;
    };
    getUser();
  }, []);

  useEffect(() => {
    if (!project?.id || !currentUserEmail.current) return;

    let mounted = true;

    const unsub = base44.entities.Project.subscribe((event) => {
      if (!mounted || event.id !== project.id) return;

      const data = event.data;
      if (data?.created_by !== currentUserEmail.current && data?.updated_by && data?.updated_by !== currentUserEmail.current) {
        setConcurrentEdit({
          lastUpdated: fmtTimestampCustom(data.updated_date || data.created_date, { dateStyle: 'short', timeStyle: 'short' }),
          detected: true
        });
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [project?.id]);

  if (!concurrentEdit?.detected) return null;

  return (
    <Alert className="border-yellow-200 bg-yellow-50 text-yellow-900 mb-4">
      <AlertTriangle className="h-4 w-4 text-yellow-600" />
      <AlertTitle>Project Updated by Another User</AlertTitle>
      <AlertDescription className="flex items-center justify-between gap-2 mt-2">
        <span>This project was modified at {concurrentEdit.lastUpdated}. Your edits may conflict.</span>
        <Button 
          size="sm" 
          variant="outline"
          onClick={() => { onRefresh(); setConcurrentEdit(null); lastKnownVersion.current = project.updated_date; }}
          className="border-yellow-300 hover:bg-yellow-100"
        >
          Refresh
        </Button>
      </AlertDescription>
    </Alert>
  );
}