import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-surface-2 text-foreground border-border",
        outline: "bg-transparent text-muted border-border",
        primary: "bg-primary/10 text-primary border-primary/20",
        success: "bg-success-bg text-success border-success/20",
        warning: "bg-warning-bg text-warning border-warning/20",
        critical: "bg-critical-bg text-critical border-critical/20",
        info: "bg-info-bg text-info border-info/20",
        neutral: "bg-neutral-bg text-neutral border-neutral/20",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
