import { AlertTriangle, Ban, CheckCircle2, Clock, Hourglass, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { titleCase } from "@/lib/format";

type Variant = "default" | "secondary" | "success" | "warning" | "destructive" | "outline" | "sky" | "violet";

interface StatusEntry {
  variant: Variant;
  label: string;
  icon?: typeof CheckCircle2;
}

const RESERVATION_MAP: Record<string, StatusEntry> = {
  HELD: { variant: "warning", icon: Hourglass, label: "Seats held" },
  CONFIRMED: { variant: "success", icon: CheckCircle2, label: "Confirmed" },
  EXPIRED: { variant: "secondary", icon: Clock, label: "Expired" },
  RELEASED: { variant: "secondary", icon: Ban, label: "Released" },
  FAILED: { variant: "destructive", icon: XCircle, label: "Failed" },
};

const PAYMENT_MAP: Record<string, StatusEntry> = {
  INITIATED: { variant: "sky", icon: Loader2, label: "Initiated" },
  PENDING: { variant: "warning", icon: Hourglass, label: "Pending reconciliation" },
  RECONCILING: { variant: "violet", icon: Loader2, label: "Reconciling" },
  SUCCESS: { variant: "success", icon: CheckCircle2, label: "Payment successful" },
  FAILED: { variant: "destructive", icon: XCircle, label: "Payment failed" },
};

const QUEUE_MAP: Record<string, StatusEntry> = {
  WAITING: { variant: "warning", icon: Hourglass, label: "Waiting in queue" },
  READY: { variant: "success", icon: CheckCircle2, label: "Admitted" },
  PROCESSING: { variant: "sky", icon: Loader2, label: "Processing" },
  CONSUMED: { variant: "secondary", icon: CheckCircle2, label: "Token used" },
  EXPIRED: { variant: "destructive", icon: Clock, label: "Token expired" },
};

const AVAILABILITY_MAP: Record<string, StatusEntry> = {
  AVAILABLE: { variant: "success", label: "Available" },
  LIMITED: { variant: "warning", label: "Limited" },
  RAC_ONLY: { variant: "sky", label: "RAC only" },
  NOT_AVAILABLE: { variant: "destructive", label: "Not available" },
};

const SEVERITY_MAP: Record<string, StatusEntry> = {
  info: { variant: "sky", icon: CheckCircle2, label: "Info" },
  warning: { variant: "warning", icon: AlertTriangle, label: "Warning" },
  error: { variant: "destructive", icon: ShieldAlert, label: "Error" },
};

export type StatusKind = "reservation" | "payment" | "queue" | "availability" | "severity";

export function StatusPill({
  status,
  kind = "reservation",
  showLabel = true,
  className,
}: {
  status: string | null | undefined;
  kind?: StatusKind;
  showLabel?: boolean;
  className?: string;
}) {
  if (!status) return <Badge variant="secondary" className={className}>Unknown</Badge>;

  const table =
    kind === "payment"
      ? PAYMENT_MAP
      : kind === "queue"
        ? QUEUE_MAP
        : kind === "availability"
          ? AVAILABILITY_MAP
          : kind === "severity"
            ? SEVERITY_MAP
            : RESERVATION_MAP;

  const entry: StatusEntry = table[status] ?? { variant: "secondary", label: titleCase(status) };
  const Icon = entry.icon;

  return (
    <Badge variant={entry.variant} className={cn("capitalize", className)}>
      {Icon ? <Icon className="h-3 w-3 shrink-0" aria-hidden /> : null}
      {showLabel ? entry.label : null}
    </Badge>
  );
}
