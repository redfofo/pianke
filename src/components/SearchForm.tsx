import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

export function SearchForm({
  initial,
  label,
  busy,
  onSubmit,
  className,
  placeholder = '搜索剧名…',
}: {
  initial: string;
  label: string;
  placeholder?: string;
  busy?: boolean;
  onSubmit: (keyword: string) => void;
  className?: string;
}) {
  const [keyword, setKeyword] = useState(initial);
  const [synced, setSynced] = useState(initial);
  // Follow the URL (back/forward, clearing the search) without overwriting what the user is typing.
  if (synced !== initial) {
    setSynced(initial);
    setKeyword(initial);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(keyword.trim());
  }
  return (
    <form role="search" onSubmit={submit} className={cn('flex w-full shrink-0 gap-2 sm:w-72 xl:w-80', className)}>
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          name="keyword"
          autoComplete="off"
          placeholder={placeholder}
          aria-label={label}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          className="pl-8"
        />
      </div>
      <Button type="submit" disabled={busy}>
        {busy && <Spinner />}搜索
      </Button>
    </form>
  );
}
