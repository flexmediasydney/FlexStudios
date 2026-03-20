import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function Modal({ open, title, description, children, footer, onOpenChange, size = "default" }) {
  const sizeClass = { small: "sm:max-w-sm", default: "sm:max-w-md", large: "sm:max-w-lg", xlarge: "sm:max-w-2xl" }[size];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={sizeClass}>
        {(title || description) && (
          <DialogHeader>
            {title && <DialogTitle>{title}</DialogTitle>}
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
        )}
        <div>{children}</div>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}