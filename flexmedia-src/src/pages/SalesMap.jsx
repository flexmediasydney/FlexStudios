import { MapPin } from "lucide-react";

export default function SalesMap() {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh] text-center px-6">
      <div className="h-16 w-16 rounded-full bg-amber-100 flex items-center justify-center mb-4">
        <MapPin className="h-8 w-8 text-amber-600" />
      </div>
      <h2 className="text-lg font-semibold text-foreground">Sales Map</h2>
      <p className="text-sm text-muted-foreground mt-2 max-w-md">
        Geographic view of all contacts and organisations with cadence health indicators. Coming soon — agencies need geocoded addresses first.
      </p>
    </div>
  );
}
