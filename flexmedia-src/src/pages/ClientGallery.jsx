import { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Camera, MapPin, Calendar, ExternalLink, Lock, 
  Download, Eye, CheckCircle, AlertCircle 
} from "lucide-react";
import { format } from "date-fns";
import { safeWindowOpen } from '@/utils/sanitizeHtml';

export default function ClientGallery() {
  const urlParams = new URLSearchParams(window.location.search);
  const projectId = urlParams.get("project");
  const [accessCode, setAccessCode] = useState("");
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [error, setError] = useState("");

  const { data: project, isLoading: projectLoading } = useQuery({
    queryKey: ["client-project", projectId],
    queryFn: async () => {
      const projects = await api.entities.Project.list();
      return projects.find(p => p.id === projectId);
    },
    enabled: !!projectId
  });

  const { data: mediaConfig, isLoading: mediaLoading } = useQuery({
    queryKey: ["client-media", projectId],
    queryFn: async () => {
      const list = await api.entities.ProjectMedia.list();
      return list.find(m => m.project_id === projectId);
    },
    enabled: !!projectId
  });

  const { data: client } = useQuery({
    queryKey: ["client-info", project?.client_id],
    queryFn: async () => {
      const clients = await api.entities.Client.list();
      return clients.find(c => c.id === project.client_id);
    },
    enabled: !!project?.client_id
  });

  const trackViewMutation = useMutation({
    mutationFn: async () => {
      if (mediaConfig?.id) {
        await api.entities.ProjectMedia.update(mediaConfig.id, {
          view_count: (mediaConfig.view_count || 0) + 1,
          last_viewed: new Date().toISOString()
        });
      }
    }
  });

  useEffect(() => {
    if (mediaConfig && !mediaConfig.access_code) {
      setIsUnlocked(true);
      trackViewMutation.mutate();
    }
  }, [mediaConfig]);

  const handleUnlock = () => {
    if (accessCode === mediaConfig?.access_code) {
      setIsUnlocked(true);
      setError("");
      trackViewMutation.mutate();
    } else {
      setError("Incorrect access code");
    }
  };

  // Check expiry
  const isExpired = mediaConfig?.expiry_date && new Date(mediaConfig.expiry_date) < new Date();

  if (projectLoading || mediaLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-6">
        <Card className="w-full max-w-2xl">
          <CardContent className="p-12 text-center">
            <Skeleton className="h-8 w-48 mx-auto mb-4" />
            <Skeleton className="h-4 w-64 mx-auto" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!project || !mediaConfig) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-6">
        <Card className="w-full max-w-2xl">
          <CardContent className="p-12 text-center">
            <AlertCircle className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
            <h2 className="text-2xl font-bold mb-2">Gallery Not Found</h2>
            <p className="text-muted-foreground">
              This project gallery doesn't exist or has been removed.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!mediaConfig.is_published) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-6">
        <Card className="w-full max-w-2xl">
          <CardContent className="p-12 text-center">
            <Eye className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
            <h2 className="text-2xl font-bold mb-2">Gallery Not Published</h2>
            <p className="text-muted-foreground">
              This gallery is not yet available. Please check back later.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isExpired) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-6">
        <Card className="w-full max-w-2xl">
          <CardContent className="p-12 text-center">
            <Calendar className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
            <h2 className="text-2xl font-bold mb-2">Access Expired</h2>
            <p className="text-muted-foreground">
              Access to this gallery has expired on {format(new Date(mediaConfig.expiry_date), "MMMM d, yyyy")}.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (mediaConfig.access_code && !isUnlocked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardContent className="p-8">
            <div className="text-center mb-6">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Lock className="h-8 w-8 text-primary" />
              </div>
              <h2 className="text-2xl font-bold mb-2">Protected Gallery</h2>
              <p className="text-muted-foreground text-sm">
                Enter the access code to view your media
              </p>
            </div>
            <div className="space-y-4">
              <Input
                type="password"
                placeholder="Enter access code"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleUnlock()}
              />
              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
              <Button className="w-full" onClick={handleUnlock}>
                Unlock Gallery
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-6xl mx-auto p-6 lg:p-8 space-y-8">
        {/* Header */}
        <Card className="border-2">
          <CardContent className="p-8">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Camera className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <h1 className="text-3xl font-bold mb-1">{project.title}</h1>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <MapPin className="h-4 w-4" />
                    <span>{project.property_address}</span>
                  </div>
                </div>
              </div>
              <Badge className="gap-1 bg-green-100 text-green-700">
                <CheckCircle className="h-3 w-3" />
                Ready
              </Badge>
            </div>

            {client && (
              <div className="pt-4 border-t">
                <p className="text-sm text-muted-foreground mb-1">Prepared for</p>
                <p className="font-medium">
                  {client.agent_name} • {client.agency_name}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Media Gallery */}
        <Card>
          <CardContent className="p-8">
            <div className="text-center space-y-6">
              <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                <ExternalLink className="h-10 w-10 text-primary" />
              </div>
              
              <div>
                <h2 className="text-2xl font-bold mb-2">Your Media Files</h2>
                <p className="text-muted-foreground max-w-md mx-auto">
                  Click the button below to access your high-resolution photos and media files stored securely on Dropbox.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 justify-center pt-4">
                <Button
                  size="lg"
                  onClick={() => safeWindowOpen(mediaConfig.dropbox_link)}
                  className="gap-2"
                >
                  <ExternalLink className="h-5 w-5" />
                  Open Media Gallery
                </Button>
                
                {mediaConfig.download_enabled && (
                  <Button
                    size="lg"
                    variant="outline"
                    onClick={() => safeWindowOpen(mediaConfig.dropbox_link)}
                    className="gap-2"
                  >
                    <Download className="h-5 w-5" />
                    Download All
                  </Button>
                )}
              </div>

              {/* Info Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-8">
                <div className="p-4 rounded-lg bg-muted/50">
                  <CheckCircle className="h-6 w-6 text-green-600 mx-auto mb-2" />
                  <p className="text-sm font-medium">High Resolution</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Professional quality images
                  </p>
                </div>
                <div className="p-4 rounded-lg bg-muted/50">
                  <Download className="h-6 w-6 text-primary mx-auto mb-2" />
                  <p className="text-sm font-medium">Download Ready</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Save to your device
                  </p>
                </div>
                <div className="p-4 rounded-lg bg-muted/50">
                  <Eye className="h-6 w-6 text-primary mx-auto mb-2" />
                  <p className="text-sm font-medium">Easy Sharing</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Share with your team
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Instructions */}
        <Card className="bg-blue-50 border-blue-200">
          <CardContent className="p-6">
            <h3 className="font-semibold mb-2 flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-blue-600" />
              How to Access Your Files
            </h3>
            <ul className="text-sm text-muted-foreground space-y-1 ml-7">
              <li>• Click "Open Media Gallery" to view all your files on Dropbox</li>
              <li>• You can preview images directly in your browser</li>
              <li>• Download individual files or use "Download All" for the complete set</li>
              <li>• Files are available in high resolution, perfect for print and web</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}