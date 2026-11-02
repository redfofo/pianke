import { useId } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { SourceEntry } from '../auth';

export function SourceSelection({
  sources,
  value,
  onChange,
  disabled,
}: {
  sources: readonly SourceEntry[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const sourceIds = sources.map((source) => source.id);
  const allSelected = sourceIds.every((source) => value.includes(source));
  const partial = value.length > 0 && !allSelected;
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 border-0 p-0" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">可浏览来源</legend>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-all`}
          checked={allSelected ? true : partial ? 'indeterminate' : false}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked === true ? [...sourceIds] : [])}
        />
        <Label htmlFor={`${id}-all`}>全选</Label>
      </div>
      <div role="group" aria-label="可浏览来源" className="grid grid-cols-2 gap-x-4 gap-y-2">
        {sources.map((source) => (
          <div key={source.id} className="flex items-center gap-2">
            <Checkbox
              id={`${id}-${source.id}`}
              checked={value.includes(source.id)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(
                  checked === true
                    ? sourceIds.filter((item) => item === source.id || value.includes(item))
                    : value.filter((item) => item !== source.id),
                )
              }
            />
            <Label htmlFor={`${id}-${source.id}`}>{source.title}</Label>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {value.length ? `已选 ${value.length} 个来源` : '未选择来源，该账号将无法浏览内容。'}
      </p>
    </fieldset>
  );
}
