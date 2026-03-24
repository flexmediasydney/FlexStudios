import React, { useState, useEffect } from 'react';
import { api } from '@/api/supabaseClient';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, AlertTriangle, Zap, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from 'sonner';

const severityColors = {
  critical: 'bg-red-50 border-red-200 text-red-900',
  high: 'bg-orange-50 border-orange-200 text-orange-900',
  medium: 'bg-yellow-50 border-yellow-200 text-yellow-900',
  low: 'bg-blue-50 border-blue-200 text-blue-900'
};

const severityBadgeColors = {
  critical: 'bg-red-100 text-red-800',
  high: 'bg-orange-100 text-orange-800',
  medium: 'bg-yellow-100 text-yellow-800',
  low: 'bg-blue-100 text-blue-800'
};

export default function DataIntegrityMonitor() {
  const [expandedIssues, setExpandedIssues] = useState({});
  const [repairingIssue, setRepairingIssue] = useState(null);

  const { data: auditResult, isLoading, refetch } = useQuery({
    queryKey: ['product-category-audit'],
    queryFn: async () => {
      const res = await api.functions.invoke('auditProductCategoryIntegrity', {});
      return res.data;
    },
    staleTime: 5 * 60 * 1000
  });

  const handleRepair = async (issue) => {
    if (!issue.fixable) {
      toast.error('This issue requires manual intervention');
      return;
    }

    setRepairingIssue(issue.product_id || issue.category_id);
    try {
      const issueId = `${issue.type}:${issue.product_id || issue.category_id}|${issue.category || issue.invalid_type_id || issue.project_type_id}`;
      const res = await api.functions.invoke('repairProductCategoryIssues', {
        issue_id: issueId,
        action: issue.type
      });

      if (res.data.repaired.length > 0) {
        toast.success(`Fixed ${res.data.repaired.length} issue(s)`);
        refetch();
      } else if (res.data.failed.length > 0) {
        toast.error(`Could not repair: ${res.data.failed[0].reason}`);
      }
    } catch (error) {
      toast.error(error.message || 'Failed to repair issue');
    } finally {
      setRepairingIssue(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!auditResult || auditResult.summary.total_issues === 0) {
    return (
      <div className="border rounded-lg bg-green-50 border-green-200 p-4 flex items-start gap-3">
        <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
        <div>
          <p className="font-semibold text-green-900">No integrity issues detected</p>
          <p className="text-sm text-green-700 mt-1">All products and categories are properly configured.</p>
        </div>
      </div>
    );
  }

  const { issues = [], summary = {} } = auditResult;
  const hasHighSeverity = summary.by_severity?.critical > 0 || summary.by_severity?.high > 0;

  return (
    <div className="space-y-4">
      {hasHighSeverity && (
        <div className="border rounded-lg bg-red-50 border-red-200 p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="font-semibold text-red-900">Critical data integrity issues detected</p>
            <p className="text-sm text-red-700 mt-1">
              {summary.by_severity?.critical + summary.by_severity?.high} issue(s) requiring attention
            </p>
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-3">
        {Object.entries(summary.by_severity || {}).map(([severity, count]) => (
          <Card key={severity} className="bg-muted/50">
            <CardContent className="pt-4">
              <div className="text-sm text-muted-foreground capitalize">{severity}</div>
              <div className="text-2xl font-bold mt-1">{count}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Issues List */}
      <div className="space-y-2">
        {issues.map((issue, idx) => {
          const isExpanded = expandedIssues[issue.product_id || issue.category_id];
          const issueKey = issue.product_id || issue.category_id;

          return (
            <div
              key={idx}
              className={`border rounded-lg p-3 ${severityColors[issue.severity]}`}
            >
              <div
                className="flex items-start gap-3 cursor-pointer hover:opacity-80"
                onClick={() =>
                  setExpandedIssues(prev => ({
                    ...prev,
                    [issueKey]: !prev[issueKey]
                  }))
                }
              >
                <AlertTriangle className={`h-4 w-4 mt-0.5 flex-shrink-0 ${
                  issue.severity === 'critical' ? 'text-red-600' :
                  issue.severity === 'high' ? 'text-orange-600' :
                  issue.severity === 'medium' ? 'text-yellow-600' :
                  'text-blue-600'
                }`} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium truncate">{issue.description}</p>
                    <Badge className={severityBadgeColors[issue.severity]} variant="secondary">
                      {issue.severity}
                    </Badge>
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 flex-shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedIssues(prev => ({
                      ...prev,
                      [issueKey]: !prev[issueKey]
                    }));
                  }}
                >
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              </div>

              {isExpanded && (
                <div className="mt-3 pt-3 border-t border-current border-opacity-20 space-y-2 text-sm">
                  {issue.product_id && <p><strong>Product ID:</strong> {issue.product_id}</p>}
                  {issue.product_name && <p><strong>Product:</strong> {issue.product_name}</p>}
                  {issue.category_id && <p><strong>Category ID:</strong> {issue.category_id}</p>}
                  {issue.category_name && <p><strong>Category:</strong> {issue.category_name}</p>}
                  {issue.category && <p><strong>Invalid Category:</strong> {issue.category}</p>}
                  {issue.invalid_type_id && <p><strong>Invalid Type ID:</strong> {issue.invalid_type_id}</p>}

                  {issue.fixable && (
                    <div className="mt-3 flex gap-2">
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => handleRepair(issue)}
                        disabled={repairingIssue === (issue.product_id || issue.category_id)}
                        className="gap-1"
                      >
                        {repairingIssue === (issue.product_id || issue.category_id) ? (
                          <>
                            <div className="h-3 w-3 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />
                            Repairing...
                          </>
                        ) : (
                          <>
                            <Zap className="h-3 w-3" />
                            Auto-Fix
                          </>
                        )}
                      </Button>
                      <p className="text-xs text-current opacity-70 flex items-center">
                        Click to automatically repair this issue
                      </p>
                    </div>
                  )}

                  {!issue.fixable && (
                    <div className="mt-2 p-2 bg-card bg-opacity-30 rounded text-xs">
                      <p className="opacity-75">⚠️ This issue requires manual intervention</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          className="gap-1"
        >
          <RefreshCw className="h-4 w-4" />
          Re-audit
        </Button>
        <p className="text-xs text-muted-foreground flex items-center">
          Last checked: {new Date(auditResult.timestamp).toLocaleString()}
        </p>
      </div>
    </div>
  );
}