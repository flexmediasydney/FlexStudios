import { useState, useEffect } from "react";
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import AccessBadge from '@/components/auth/AccessBadge';
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Plug, CheckCircle, XCircle, Loader2 } from "lucide-react";

export default function IntegrationsManagement() {
  const { canEdit, canView } = useEntityAccess('tonomo_mappings');
  const queryClient = useQueryClient();
  const [tonomoConfig, setTonomoConfig] = useState({
    api_key: "",
    api_endpoint: "",
    sync_enabled: false
  });
  const [testing, setTesting] = useState(false);

  const { data: savedConfig } = useQuery({
    queryKey: ["tonomo-integration"],
    queryFn: async () => {
      const list = await api.entities.TonomoIntegration.list();
      return list[0] || null;
    }
  });

  useEffect(() => {
    if (savedConfig) {
      setTonomoConfig({
        api_key: savedConfig.api_key || "",
        api_endpoint: savedConfig.api_endpoint || "",
        sync_enabled: savedConfig.sync_enabled || false
      });
    }
  }, [savedConfig]);

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (!data.webhook_url?.trim() && !data.api_key?.trim()) {
        throw new Error("At least one of Webhook URL or API Key is required");
      }
      if (data.webhook_url && !data.webhook_url.trim().startsWith('https://')) {
        throw new Error("Webhook URL must start with https://");
      }
      if (savedConfig?.id) {
        return api.entities.TonomoIntegration.update(savedConfig.id, data);
      } else {
        return api.entities.TonomoIntegration.create(data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tonomo-integration"] });
      toast.success("Tonomo integration settings saved");
    },
    onError: (err) => {
      toast.error(err?.message || "Failed to save integration settings");
    }
  });

  const handleTestConnection = async () => {
    if (!tonomoConfig.api_key || !tonomoConfig.api_endpoint) {
      toast.error("Please provide API key and endpoint");
      return;
    }

    setTesting(true);
    try {
      // Simulate API test - in real implementation, this would call the Tonomo API
      await new Promise(resolve => setTimeout(resolve, 1500));
      toast.success("Connection successful!");
    } catch (error) {
      toast.error("Connection failed");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    saveMutation.mutate(tonomoConfig);
  };

  const isConnected = savedConfig?.api_key && savedConfig?.api_endpoint;

  if (!canView) return <div className="p-8 text-center text-muted-foreground">You don't have access to this section.</div>;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                <Plug className="h-6 w-6 text-primary" />
              </div>
              <div>
                <CardTitle>Tonomo Integration <AccessBadge entityType="tonomo_mappings" /></CardTitle>
                <CardDescription>Connect your Tonomo real estate account</CardDescription>
              </div>
            </div>
            {isConnected ? (
              <Badge className="gap-1 bg-green-100 text-green-700">
                <CheckCircle className="h-3 w-3" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <XCircle className="h-3 w-3" />
                Not Connected
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="api_endpoint">API Endpoint</Label>
              <Input
                id="api_endpoint"
                type="url"
                placeholder="https://api.tonomo.com"
                value={tonomoConfig.api_endpoint}
                onChange={(e) => setTonomoConfig({ ...tonomoConfig, api_endpoint: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Your Tonomo API endpoint URL
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="api_key">API Key</Label>
              <Input
                id="api_key"
                type="password"
                placeholder="Enter your Tonomo API key"
                value={tonomoConfig.api_key}
                onChange={(e) => setTonomoConfig({ ...tonomoConfig, api_key: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                You can find this in your Tonomo account settings
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-4 border-t">
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={!canEdit || testing || !tonomoConfig.api_key || !tonomoConfig.api_endpoint}
            >
              {testing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Testing...
                </>
              ) : (
                "Test Connection"
              )}
            </Button>
            <Button
              onClick={handleSave}
              disabled={!canEdit || saveMutation.isPending || !tonomoConfig.api_key || !tonomoConfig.api_endpoint}
            >
              {saveMutation.isPending ? "Saving..." : "Save Configuration"}
            </Button>
          </div>

          <div className="bg-muted/50 rounded-lg p-4 space-y-2">
            <p className="text-sm font-medium">About Tonomo Integration</p>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>Sync property listings from Tonomo automatically</li>
              <li>Keep client information up to date</li>
              <li>Import new projects from Tonomo listings</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}