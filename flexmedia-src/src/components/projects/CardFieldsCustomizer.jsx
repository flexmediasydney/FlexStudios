import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Settings2, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ALL_CARD_FIELDS, useCardFields } from "./useCardFields";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";

export function CardFieldsCustomizerButton({ onClick }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} className="gap-2">
      <Settings2 className="h-4 w-4" />
      <span className="hidden sm:inline">Card Fields</span>
    </Button>
  );
}

export default function CardFieldsCustomizer({ open, onClose }) {
  const { canSeePricing } = usePermissions();
  const { enabledFields, toggleField, reorderFields, isEnabled } = useCardFields();

  const visibleFields = ALL_CARD_FIELDS.filter(f => !f.requiresPricing || canSeePricing);

  // Build the ordered list for the drag-and-drop:
  // enabled fields first (in their saved order), then disabled fields at the bottom
  const enabledVisible = enabledFields.filter(id => visibleFields.find(f => f.id === id));
  const disabledVisible = visibleFields.filter(f => !enabledFields.includes(f.id));

  const onDragEnd = (result) => {
    if (!result.destination) return;
    // We only drag within the enabled section (indices 0..enabledVisible.length-1)
    const srcIdx = result.source.index;
    const dstIdx = result.destination.index;
    if (srcIdx === dstIdx) return;
    const reordered = [...enabledVisible];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(dstIdx, 0, moved);
    reorderFields(reordered);
  };

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="right" className="w-80 sm:w-96 overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" />
            Customise Card Fields
          </SheetTitle>
          <p className="text-sm text-muted-foreground">
            Toggle fields on/off. Drag enabled fields to reorder them.
          </p>
        </SheetHeader>

        <div className="mt-6 space-y-2">
          {/* Enabled fields — draggable */}
          {enabledVisible.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Enabled · drag to reorder
              </p>
              <DragDropContext onDragEnd={onDragEnd}>
                <Droppable droppableId="enabled-fields">
                  {(provided) => (
                    <div ref={provided.innerRef} {...provided.droppableProps} className="space-y-2">
                      {enabledVisible.map((id, index) => {
                        const field = ALL_CARD_FIELDS.find(f => f.id === id);
                        if (!field) return null;
                        return (
                          <Draggable key={id} draggableId={id} index={index}>
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                className={`flex items-center justify-between p-3 rounded-lg border bg-card transition-shadow ${
                                  snapshot.isDragging ? "shadow-lg ring-2 ring-primary/30" : ""
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <div {...provided.dragHandleProps} className="cursor-grab active:cursor-grabbing touch-none">
                                    <GripVertical className="h-4 w-4 text-muted-foreground" />
                                  </div>
                                  <span className="text-sm font-medium">{field.label}</span>
                                </div>
                                <Switch
                                  checked={true}
                                  onCheckedChange={() => toggleField(id)}
                                />
                              </div>
                            )}
                          </Draggable>
                        );
                      })}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </DragDropContext>
            </div>
          )}

          {/* Disabled fields */}
          {disabledVisible.length > 0 && (
            <div className={enabledVisible.length > 0 ? "mt-6" : ""}>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Disabled
              </p>
              <div className="space-y-2">
                {disabledVisible.map(field => (
                  <div
                    key={field.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                  >
                    <span className="text-sm text-muted-foreground">{field.label}</span>
                    <Switch
                      checked={false}
                      onCheckedChange={() => toggleField(field.id)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}