import { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation } from "@tanstack/react-query";
import { useEntityList } from "@/components/hooks/useEntityData";
import { validateField, LIMITS } from "@/components/hooks/useFormValidation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { 
  FolderOpen, Link as LinkIcon, Copy, ExternalLink, 
  Eye, Download, Calendar, Shield, CheckCircle 
} from "lucide-react";
import { format } from "date-fns";
import { safeWindowOpen } from '@/utils/sanitizeHtml';

export default function MediaDeliveryManager({ projectId, project }) {
  const [config, setConfig] = useState({
    dropbox_link: "",
    access_code: "",
    is_published: false,
    expiry_date: "",
    download_enabled: true,
    watermark_enabled: false
  });

  const { data: allMedia = [], loading: mediaLoading } = useEntityList(
    projectId ? "ProjectMedia" : null,
    null,
    null,
    projectId ? (m) => m.project_id === projectId : null
  );
  const mediaConfig = allMedia[0] || null;

  useEffect(() => {
    let mounted = true;
    if (mediaConfig && mounted) {
      setConfig({
        dropbox_link: mediaConfig.dropbox_link || "",
        access_code: mediaConfig.access_code || "",
        is_published: mediaConfig.is_published || false,
        expiry_date: mediaConfig.expiry_date || "",
        download_enabled: mediaConfig.download_enabled ?? true,
        watermark_enabled: mediaConfig.watermark_enabled || false
      });
    }
    return () => { mounted = false; };
  }, [mediaConfig?.id]);

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      const saveData = { ...data, project_id: projectId };
      if (mediaConfig?.id) {
        return api.entities.ProjectMedia.update(mediaConfig.id, saveData);
      } else {
        return api.entities.ProjectMedia.create(saveData);
      }
    },
    onSuccess: () => toast.success("Media delivery settings saved"),
    onError: () => toast.error("Failed to save settings")
  });

  const handleSave = () => {
    if (!projectId) {
      toast.error("No project ID");
      return;
    }
    const linkErr = validateField("dropbox_link", config.dropbox_link);
    if (linkErr) { toast.error(linkErr); return; }
    saveMutation.mutate(config);
  };

  const copyClientLink = () => {
    if (!projectId) {
      toast.error("No project ID");
      return;
    }
    try {
      const clientUrl = `${window.location.origin}${window.location.pathname}#/ClientGallery?project=${projectId}`;
      navigator.clipboard.writeText(clientUrl);
      toast.success("Client link copied to clipboard");
    } catch {
      toast.error("Failed to copy link");
    }
  };

  const isConfigured = config.dropbox_link && config.is_published;

  if (mediaLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Media Delivery</CardTitle>
          <CardDescription>Configure Dropbox link and client access</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="animate-spin h-6 w-6 border-2 border-primary/30 border-t-primary rounded-full mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Loading media settings...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Media Delivery</CardTitle>
            <CardDescription>Configure Dropbox link and client access</CardDescription>
          </div>
          {isConfigured && (
            <Badge className="gap-1 bg-green-100 text-green-700">
              <CheckCircle className="h-3 w-3" />
              Published
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Dropbox Link */}
        <div className="space-y-2">
          <Label htmlFor="dropbox_link">Dropbox Shared Folder Link</Label>
          <div className="flex gap-2">
            <Input
              id="dropbox_link"
              type="url"
              placeholder="https://www.dropbox.com/sh/..."
              value={config.dropbox_link}
              onChange={(e) => setConfig({ ...config, dropbox_link: e.target.value.slice(0, LIMITS.url) })}
            />
            {config.dropbox_link && (
              <Button
                variant="outline"
                size="icon"
                onClick={() => safeWindowOpen(config.dropbox_link)}
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Share a Dropbox folder and paste the link here
          </p>
        </div>

        {/* Access Settings */}
        <div className="space-y-4 pt-4 border-t">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Publish to Client</Label>
              <p className="text-xs text-muted-foreground">
                Make media accessible via client gallery link
              </p>
            </div>
            <Switch
              checked={config.is_published}
              onCheckedChange={(checked) => setConfig({ ...config, is_published: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Enable Downloads</Label>
              <p className="text-xs text-muted-foreground">
                Allow clients to download files
              </p>
            </div>
            <Switch
              checked={config.download_enabled}
              onCheckedChange={(checked) => setConfig({ ...config, download_enabled: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Watermark Preview</Label>
              <p className="text-xs text-muted-foreground">
                Show watermarked preview only (coming soon)
              </p>
            </div>
            <Switch
              checked={config.watermark_enabled}
              onCheckedChange={(checked) => setConfig({ ...config, watermark_enabled: checked })}
              disabled
            />
          </div>
        </div>

        {/* Optional Settings */}
        <div className="space-y-4 pt-4 border-t">
          <div className="space-y-2">
            <Label htmlFor="access_code">Access Code (Optional)</Label>
            <Input
              id="access_code"
              type="text"
              placeholder="Leave empty for no password"
              value={config.access_code}
              onChange={(e) => setConfig({ ...config, access_code: e.target.value.slice(0, LIMITS.code) })}
            />
            <p className="text-xs text-muted-foreground">
              Require clients to enter this code to view media
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="expiry_date">Access Expiry Date (Optional)</Label>
            <Input
              id="expiry_date"
              type="date"
              value={config.expiry_date}
              onChange={(e) => setConfig({ ...config, expiry_date: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Access will be disabled after this date
            </p>
          </div>
        </div>

        {/* Client Link */}
        {config.is_published && (
          <div className="space-y-3 pt-4 border-t bg-muted/50 -mx-6 px-6 -mb-6 pb-6">
            <Label>Client Gallery Link</Label>
            <div className="flex gap-2">
              <Input
                value={`${window.location.origin}${window.location.pathname}#/ClientGallery?project=${projectId}`}
                readOnly
                className="bg-background"
              />
              <Button variant="outline" onClick={copyClientLink}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Share this link with your client to view their media
            </p>
          </div>
        )}

        {/* Stats */}
        {mediaConfig && (
          <div className="grid grid-cols-2 gap-4 pt-4 border-t">
            <div className="flex items-center gap-2 text-sm">
              <Eye className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Views:</span>
              <span className="font-medium">{mediaConfig.view_count || 0}</span>
            </div>
            {mediaConfig.last_viewed && (
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Last viewed:</span>
                <span className="font-medium">
                  {format(new Date(mediaConfig.last_viewed), "MMM d")}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button onClick={handleSave} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "Saving..." : "Save Settings"}
          </Button>
          {config.is_published && (
            <Button variant="outline" onClick={copyClientLink}>
              <Copy className="h-4 w-4 mr-2" />
              Copy Client Link
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}