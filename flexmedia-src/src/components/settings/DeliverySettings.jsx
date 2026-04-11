import { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation } from "@tanstack/react-query";
import { isTransientError } from "@/lib/networkResilience";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Clock, Palette, Save } from "lucide-react";

const DAYS = [
  { key: "monday", label: "Monday" },
  { key: "tuesday", label: "Tuesday" },
  { key: "wednesday", label: "Wednesday" },
  { key: "thursday", label: "Thursday" },
  { key: "friday", label: "Friday" },
  { key: "saturday", label: "Saturday" },
  { key: "sunday", label: "Sunday" }
];

const DEFAULT_SETTINGS = {
  working_hours: {
    monday: { enabled: true, start: "09:00", end: "17:00" },
    tuesday: { enabled: true, start: "09:00", end: "17:00" },
    wednesday: { enabled: true, start: "09:00", end: "17:00" },
    thursday: { enabled: true, start: "09:00", end: "17:00" },
    friday: { enabled: true, start: "09:00", end: "17:00" },
    saturday: { enabled: false, start: "09:00", end: "17:00" },
    sunday: { enabled: false, start: "09:00", end: "17:00" }
  },
  countdown_thresholds: { grey_to_yellow: 50, yellow_to_orange: 75, orange_to_red: 90 }
};

export default function DeliverySettings() {
  const [localSettings, setLocalSettings] = useState(DEFAULT_SETTINGS);
  const [hasChanges, setHasChanges] = useState(false);

  // Real-time subscription
  const { data: settingsList, loading } = useEntityList("DeliverySettings");
  const savedSettings = settingsList?.[0] || null;

  useEffect(() => {
    if (savedSettings) {
      setLocalSettings({
        working_hours: savedSettings.working_hours || DEFAULT_SETTINGS.working_hours,
        countdown_thresholds: savedSettings.countdown_thresholds || DEFAULT_SETTINGS.countdown_thresholds
      });
      setHasChanges(false);
    }
  }, [savedSettings?.id, savedSettings?.updated_date]);

  const saveMutation = useMutation({
    retry: (failureCount, error) => failureCount < 2 && isTransientError(error),
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 4000),
    mutationFn: async (data) => {
      if (savedSettings?.id) {
        return api.entities.DeliverySettings.update(savedSettings.id, data);
      }
      return api.entities.DeliverySettings.create(data);
    },
    onSuccess: () => {
      setHasChanges(false);
      toast.success("Settings saved");
    },
    onError: (err) => {
      const hint = isTransientError(err) ? ' — check your connection and try again' : '';
      toast.error(`Failed to save settings${hint}`);
    },
  });

  const updateWorkingHours = (day, field, value) => {
    setLocalSettings(prev => ({
      ...prev,
      working_hours: { ...prev.working_hours, [day]: { ...prev.working_hours[day], [field]: value } }
    }));
    setHasChanges(true);
  };

  const updateThreshold = (field, value) => {
    // Allow empty string while user is typing; clamp on save via validateAndSave
    const num = value === "" ? 0 : parseFloat(value);
    if (isNaN(num)) return;
    const clamped = Math.min(100, Math.max(0, num));
    setLocalSettings(prev => ({
      ...prev,
      countdown_thresholds: { ...prev.countdown_thresholds, [field]: clamped }
    }));
    setHasChanges(true);
  };

  const validateAndSave = () => {
    const { grey_to_yellow, yellow_to_orange, orange_to_red } = localSettings.countdown_thresholds;
    if (grey_to_yellow >= yellow_to_orange || yellow_to_orange >= orange_to_red) {
      toast.error("Thresholds must be in ascending order: grey < yellow < orange < red");
      return;
    }
    saveMutation.mutate(localSettings);
  };

  if (loading) {
    return <div className="flex items-center justify-center p-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>;
  }

  return (
    <div className="space-y-6">
      {hasChanges && (
        <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          <span className="text-sm text-amber-700 font-medium">You have unsaved changes</span>
          <Button size="sm" onClick={validateAndSave} disabled={saveMutation.isPending} className="gap-2">
            <Save className="h-4 w-4" />
            {saveMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            <CardTitle>Working Hours</CardTitle>
          </div>
          <CardDescription>Set working hours for each day. Used for deadline calculations and countdown timers.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {DAYS.map(day => (
            <div key={day.key} className="flex items-center gap-4 flex-wrap">
              <div className="w-28">
                <Label className="font-medium">{day.label}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={localSettings.working_hours[day.key]?.enabled || false}
                  onCheckedChange={(checked) => updateWorkingHours(day.key, "enabled", checked)}
                />
                <span className="text-sm text-muted-foreground w-16">
                  {localSettings.working_hours[day.key]?.enabled ? "Working" : "Off"}
                </span>
              </div>
              {localSettings.working_hours[day.key]?.enabled && (
                <>
                  <Input
                    type="time"
                    value={localSettings.working_hours[day.key]?.start || "09:00"}
                    onChange={(e) => updateWorkingHours(day.key, "start", e.target.value)}
                    className="w-32"
                  />
                  <span className="text-muted-foreground">to</span>
                  <Input
                    type="time"
                    value={localSettings.working_hours[day.key]?.end || "17:00"}
                    onChange={(e) => updateWorkingHours(day.key, "end", e.target.value)}
                    className="w-32"
                  />
                </>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Palette className="h-5 w-5" />
            <CardTitle>Countdown Timer Colors</CardTitle>
          </div>
          <CardDescription>Configure when countdown timers change colour as deadlines approach</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="w-32 h-8 bg-gray-200 rounded flex items-center justify-center text-xs font-medium">Grey</div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">0% to</span>
                <Input
                  type="number"
                  value={localSettings.countdown_thresholds.grey_to_yellow}
                  onChange={(e) => updateThreshold("grey_to_yellow", e.target.value)}
                  className="w-20"
                  min="0"
                  max="100"
                />
                <span className="text-sm">%</span>
              </div>
            </div>
            <div className="flex items-center gap-4 flex-wrap">
              <div className="w-32 h-8 bg-yellow-200 rounded flex items-center justify-center text-xs font-medium">Yellow</div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">{localSettings.countdown_thresholds.grey_to_yellow}% to</span>
                <Input
                  type="number"
                  value={localSettings.countdown_thresholds.yellow_to_orange}
                  onChange={(e) => updateThreshold("yellow_to_orange", e.target.value)}
                  className="w-20"
                  min="0"
                  max="100"
                />
                <span className="text-sm">%</span>
              </div>
            </div>
            <div className="flex items-center gap-4 flex-wrap">
              <div className="w-32 h-8 bg-orange-200 rounded flex items-center justify-center text-xs font-medium">Orange</div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">{localSettings.countdown_thresholds.yellow_to_orange}% to</span>
                <Input
                  type="number"
                  value={localSettings.countdown_thresholds.orange_to_red}
                  onChange={(e) => updateThreshold("orange_to_red", e.target.value)}
                  className="w-20"
                  min="0"
                  max="100"
                />
                <span className="text-sm">%</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="w-32 h-8 bg-red-200 rounded flex items-center justify-center text-xs font-medium animate-pulse">Red (Flash)</div>
              <span className="text-sm text-muted-foreground">{localSettings.countdown_thresholds.orange_to_red}% - 100% (overdue flashes)</span>
            </div>
          </div>

          <Separator />

          <div className="bg-muted/50 rounded-lg p-4 space-y-2">
            <p className="text-sm font-medium">Configuration Rules:</p>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>All thresholds must be in ascending order</li>
              <li>Values represent the percentage of time elapsed from task creation to due date</li>
              <li>Past 100% the timer turns red and flashes to indicate overdue</li>
            </ul>
          </div>

          <Button onClick={validateAndSave} disabled={saveMutation.isPending}>
            <Save className="h-4 w-4 mr-2" />
            {saveMutation.isPending ? "Saving..." : "Save Settings"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}