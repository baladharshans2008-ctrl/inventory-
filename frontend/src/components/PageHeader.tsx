import { cn } from "@/lib/utils";

export function PageHeader({
  kicker,
  title,
  description,
  actions,
  className,
}: {
  kicker?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-5 py-8 lg:flex-row lg:items-end lg:justify-between", className)}>
      <div className="max-w-3xl animate-fade-up">
        {kicker ? <p className="kicker">{kicker}</p> : null}
        <h1 className="mt-2 text-balance text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-3 text-balance text-sm leading-relaxed text-muted-foreground sm:text-base">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  icon: Icon,
  actions,
  className,
}: {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="flex items-start gap-3">
        {Icon ? (
          <span className="mt-0.5 grid h-9 w-9 place-items-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.08] text-cyan-300">
            <Icon className="h-4.5 w-4.5" />
          </span>
        ) : null}
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {description ? <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function DataRow({
  label,
  value,
  mono = false,
  className,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-2", className)}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn("text-right text-sm font-medium", mono && "font-mono tabular-nums")}>{value}</span>
    </div>
  );
}
