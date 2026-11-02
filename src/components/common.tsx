import type { ReactNode } from 'react';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function PageHeading({
  id,
  title,
  description,
  children,
  className,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 id={id} className="text-xl font-semibold tracking-tight">
          {title}
        </h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{children}</div>}
    </div>
  );
}

const noticeIcons = { error: CircleAlert, warning: TriangleAlert, info: Info };

/** Inline status message. `error` is announced as an alert; the others are polite. */
export function Notice({
  tone = 'error',
  title,
  children,
  className,
  id,
}: {
  tone?: 'error' | 'warning' | 'info';
  title: ReactNode;
  children?: ReactNode;
  className?: string;
  id?: string;
}) {
  const Icon = noticeIcons[tone];
  return (
    <Alert
      id={id}
      role={tone === 'error' ? 'alert' : 'status'}
      variant={tone === 'error' ? 'destructive' : 'default'}
      className={cn(
        '[overflow-wrap:anywhere]',
        tone === 'warning' && 'border-warning/40 text-warning',
        tone === 'info' && 'text-muted-foreground',
        className,
      )}
    >
      <Icon />
      <AlertTitle className="font-normal whitespace-pre-line">{title}</AlertTitle>
      {children && <AlertDescription className="mt-1 flex flex-wrap items-center gap-3">{children}</AlertDescription>}
    </Alert>
  );
}

/** Error with recovery actions, used where a whole list or page failed. */
export function StatePanel({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 [&>a]:text-sm [&>a]:underline [&>a]:underline-offset-4"
      role="alert"
    >
      <Notice title={message} className="w-full" />
      {children}
    </div>
  );
}

export function EmptyState({ description, children }: { description: ReactNode; children?: ReactNode }) {
  return (
    <Empty className="border py-12">
      <EmptyHeader>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && (
        <EmptyContent className="[&>a:not([data-slot])]:text-sm [&>a:not([data-slot])]:underline [&>a:not([data-slot])]:underline-offset-4">
          {children}
        </EmptyContent>
      )}
    </Empty>
  );
}

export function LinesSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 py-2" aria-hidden="true">
      <Skeleton className="h-4 w-2/5" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={cn('h-4', index === rows - 1 ? 'w-3/5' : 'w-full')} />
      ))}
    </div>
  );
}

export function CoverSkeletonGrid({ count = 10 }: { count?: number }) {
  return (
    <div className="cover-grid" aria-label="正在加载剧目" aria-busy="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index}>
          <Skeleton className="mb-2 aspect-[3/4] w-full rounded-lg" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ))}
    </div>
  );
}

export function LoadingRing({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-6 animate-spin rounded-full border-2 border-white/20 border-t-white/80',
        className,
      )}
      aria-hidden="true"
    />
  );
}

/** Form field error text, linked to its input with aria-describedby. */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-sm text-destructive" role="alert">
      {children}
    </p>
  );
}
