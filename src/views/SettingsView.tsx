import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { CircleCheck, FolderSync, GripVertical, RefreshCw, Stethoscope, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import {
  checkSource,
  getCatalogStatus,
  getConfig,
  getEmbyStatus,
  getStatus,
  saveConfig,
  startCatalogSync,
  type CatalogSyncStatus,
  type UpstreamConfig,
} from '../api';
import { useAuth } from '../auth';
import { usePreferences, type ThemeMode } from '../preferences';
import { useOrderedSources, useSources } from '../stores';
import type { Source, SourceHealth } from '../types';
import { EmptyState, LinesSkeleton, Notice, PageHeading } from '../components/common';

const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];
const operations: { key: keyof SourceHealth; label: string }[] = [
  { key: 'browse', label: '分类浏览' },
  { key: 'search', label: '搜索' },
  { key: 'detail', label: '剧集详情' },
  { key: 'playback', label: '实际播放' },
];
type EmbyStatus = Awaited<ReturnType<typeof getEmbyStatus>>;

const message = (reason: unknown, fallback: string) => (reason instanceof Error ? reason.message : fallback);

/** Accepts only an HTTP(S) origin: no credentials, path, query or fragment. */
function parseBackendUrl(draft: string): string | undefined {
  try {
    const parsed = new URL(draft);
    if (
      !/^https?:\/\/[^/?#\\@\s]+\/?$/i.test(draft) ||
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    )
      return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function Section({
  id,
  title,
  description,
  action,
  children,
  className,
  busy,
}: {
  id: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  busy?: boolean;
}) {
  return (
    <Card role="region" aria-labelledby={id} aria-busy={busy || undefined} className={className}>
      <CardHeader>
        <CardTitle id={id} role="heading" aria-level={2}>
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      {children && <CardContent className="flex flex-col gap-3">{children}</CardContent>}
    </Card>
  );
}

function SettingRow({
  label,
  help,
  helpId,
  children,
}: {
  label: React.ReactNode;
  help?: string;
  helpId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {help && (
          <p id={helpId} className="text-xs text-muted-foreground">
            {help}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export default function SettingsView() {
  const user = useAuth((state) => state.user);
  const isAdmin = user?.role === 'admin';
  const catalog = useSources();
  const preferences = usePreferences();
  const [status, setStatus] = useState<Record<string, SourceHealth>>({});
  const [config, setConfig] = useState<UpstreamConfig>();
  const [embyStatus, setEmbyStatus] = useState<EmbyStatus>();
  const [embyStatusError, setEmbyStatusError] = useState('');
  const [embyStatusLoading, setEmbyStatusLoading] = useState(false);
  const [catalogSyncStatus, setCatalogSyncStatus] = useState<CatalogSyncStatus[]>([]);
  const [catalogSyncLoading, setCatalogSyncLoading] = useState(false);
  const [catalogSyncError, setCatalogSyncError] = useState('');
  const [backendDraft, setBackendDraft] = useState('');
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  const backendInput = useRef<HTMLInputElement>(null);
  // Request bookkeeping that must not trigger renders.
  const live = useRef({
    mounted: true,
    saving: false,
    config: undefined as UpstreamConfig | undefined,
    draft: '',
    status: undefined as AbortController | undefined,
    configRequest: undefined as AbortController | undefined,
    emby: undefined as AbortController | undefined,
    catalogStatus: undefined as AbortController | undefined,
    checks: {} as Record<string, AbortController>,
  });
  useEffect(() => {
    live.current.config = config;
    live.current.draft = backendDraft;
    live.current.saving = saving;
  });

  async function loadConfig() {
    if (!isAdmin || live.current.saving) return;
    live.current.configRequest?.abort();
    const controller = new AbortController();
    live.current.configRequest = controller;
    setConfigLoading(true);
    setConfigError('');
    try {
      const result = await getConfig(controller.signal);
      if (controller.signal.aborted) return;
      // Keep an edit in progress; replace the draft only if it still shows the old address.
      if (live.current.draft === (live.current.config?.backendUrl ?? '')) setBackendDraft(result.backendUrl);
      setConfig(result);
    } catch (reason) {
      if (!controller.signal.aborted) setConfigError(message(reason, '上游配置读取失败'));
    } finally {
      if (!controller.signal.aborted) setConfigLoading(false);
    }
  }
  async function refresh() {
    live.current.status?.abort();
    const controller = new AbortController();
    live.current.status = controller;
    setLoading(true);
    setError('');
    try {
      const result = await getStatus(controller.signal);
      // The applied address comes only from /api/config, never from a status response.
      if (!controller.signal.aborted) setStatus(result.sources);
    } catch (reason) {
      if (!controller.signal.aborted) setError(message(reason, '状态读取失败'));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  async function refreshEmbyStatus() {
    if (!isAdmin) return;
    live.current.emby?.abort();
    const controller = new AbortController();
    live.current.emby = controller;
    setEmbyStatusLoading(true);
    setEmbyStatusError('');
    try {
      const result = await getEmbyStatus(controller.signal);
      if (!controller.signal.aborted) setEmbyStatus(result);
    } catch (reason) {
      if (!controller.signal.aborted) setEmbyStatusError(message(reason, 'Emby 状态读取失败'));
    } finally {
      if (!controller.signal.aborted) setEmbyStatusLoading(false);
    }
  }
  async function refreshCatalogStatus() {
    if (!isAdmin) return;
    live.current.catalogStatus?.abort();
    const controller = new AbortController();
    live.current.catalogStatus = controller;
    setCatalogSyncError('');
    try {
      const result = await getCatalogStatus(controller.signal);
      if (!controller.signal.aborted) setCatalogSyncStatus(result.sources);
    } catch (reason) {
      if (!controller.signal.aborted) setCatalogSyncError(message(reason, '目录同步状态读取失败'));
    }
  }
  async function synchronizeCatalog(sourceId?: string) {
    if (catalogSyncLoading) return;
    setCatalogSyncLoading(true);
    setCatalogSyncError('');
    try {
      await startCatalogSync(sourceId);
      await refreshCatalogStatus();
    } catch (reason) {
      setCatalogSyncError(message(reason, '启动目录同步失败'));
    } finally {
      setCatalogSyncLoading(false);
    }
  }
  async function applyConfig(event: FormEvent) {
    event.preventDefault();
    if (!isAdmin || saving || configLoading || !config || configError) return;
    setSaveError('');
    setSaveSuccess('');
    const backendUrl = parseBackendUrl(backendDraft.trim());
    if (!backendUrl) {
      setSaveError('请输入 HTTP(S) 根地址，不含账号密码或路径，例如 http://localhost:3000。');
      backendInput.current?.focus();
      return;
    }
    setSaving(true);
    live.current.saving = true;
    live.current.configRequest?.abort();
    live.current.status?.abort();
    setLoading(false);
    try {
      // Do not abort this write on navigation: the server may already have persisted it.
      const result = await saveConfig(backendUrl);
      if (!result.persisted || !result.backendUrl) throw new Error('未能确认保存结果，请重新读取配置。');
      Object.values(live.current.checks).forEach((controller) => controller.abort());
      if (live.current.mounted) {
        setConfig(result);
        setBackendDraft(result.backendUrl);
        setStatus({});
        setChecking({});
        setCheckErrors({});
        setSaveSuccess(
          result.migrating
            ? '上游地址已保存并应用。已同步的媒体库正在后台迁移到新地址，大型媒体库约需几分钟，期间部分剧目可能暂时打不开。'
            : '上游地址已保存并应用。',
        );
      }
      await useSources.getState().load(true, true);
      if (live.current.mounted) await refresh();
    } catch (reason) {
      if (live.current.mounted) setSaveError(`${message(reason, '保存失败')}；请重新读取配置后重试。`);
    } finally {
      live.current.saving = false;
      if (live.current.mounted) setSaving(false);
    }
  }
  async function check(id: string) {
    if (checking[id] || saving) return;
    const controller = new AbortController();
    live.current.checks[id] = controller;
    setChecking((value) => ({ ...value, [id]: true }));
    setCheckErrors((value) => ({ ...value, [id]: '' }));
    try {
      const result = await checkSource(id, controller.signal);
      if (!controller.signal.aborted) setStatus((value) => ({ ...value, [id]: result }));
    } catch (reason) {
      if (!controller.signal.aborted) setCheckErrors((value) => ({ ...value, [id]: message(reason, '来源检查失败') }));
    } finally {
      if (!controller.signal.aborted) setChecking((value) => ({ ...value, [id]: false }));
      delete live.current.checks[id];
    }
  }
  useEffect(() => {
    const state = live.current;
    state.mounted = true;
    void loadConfig();
    void refresh();
    void refreshEmbyStatus();
    void refreshCatalogStatus();
    return () => {
      state.mounted = false;
      state.configRequest?.abort();
      state.status?.abort();
      Object.values(state.checks).forEach((controller) => controller.abort());
      state.emby?.abort();
      state.catalogStatus?.abort();
    };
    // Initial load only; the buttons below trigger later refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section aria-labelledby="settings-title" className="flex max-w-6xl flex-col gap-4">
      <PageHeading id="settings-title" title="设置">
        <Button
          variant="outline"
          disabled={saving || loading || configLoading || catalog.loading}
          onClick={() => {
            void loadConfig();
            void refresh();
            void refreshEmbyStatus();
            void catalog.load(true);
            void refreshCatalogStatus();
          }}
        >
          {loading || configLoading || catalog.loading ? <Spinner /> : <RefreshCw data-icon="inline-start" />}
          刷新状态
        </Button>
      </PageHeading>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          id="account-title"
          title="当前账号"
          action={
            isAdmin && (
              <Button asChild variant="outline" size="sm">
                <Link to="/admin/users">
                  <Users data-icon="inline-start" />
                  管理账号
                </Link>
              </Button>
            )
          }
        >
          <div className="flex items-center gap-3 [overflow-wrap:anywhere]">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold"
            >
              {user?.username.slice(0, 1).toUpperCase()}
            </span>
            <strong className="font-medium">{user?.username}</strong>
            <Badge variant={isAdmin ? 'default' : 'secondary'}>{isAdmin ? '管理员' : '普通用户'}</Badge>
          </div>
        </Section>
        <Section id="playback-title" title="播放偏好" description="播放偏好、来源显隐与排序仅保存在当前浏览器。">
          <SettingRow label="自动连播" help="播完当前集后播放下一集。">
            <Switch
              checked={preferences.autoplay}
              onCheckedChange={preferences.setAutoplay}
              aria-label="自动播放下一集"
            />
          </SettingRow>
          <SettingRow
            label="服务器代理中转"
            help="关闭后直连视频源，下次播放生效。直连失败不会自动切回中转。"
            helpId="server-proxy-help"
          >
            <Switch
              checked={preferences.serverProxy}
              onCheckedChange={preferences.setServerProxy}
              aria-label="服务器代理中转"
              aria-describedby="server-proxy-help"
            />
          </SettingRow>
          <SettingRow label={<span id="theme-label">外观</span>}>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={preferences.theme}
              onValueChange={(value) => value && preferences.setTheme(value as ThemeMode)}
              aria-labelledby="theme-label"
            >
              {themeOptions.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value} aria-label={option.label} className="px-3">
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </SettingRow>
        </Section>

        {isAdmin && (
          <Section
            id="emby-status-title"
            title="Emby 客户端状态"
            action={
              <Button variant="outline" size="sm" disabled={embyStatusLoading} onClick={() => void refreshEmbyStatus()}>
                {embyStatusLoading ? <Spinner /> : <RefreshCw data-icon="inline-start" />}
                刷新
              </Button>
            }
          >
            {embyStatusError && <Notice title={embyStatusError} />}
            {embyStatus && (
              <div className="grid grid-cols-3 gap-3">
                {[
                  [embyStatus.sessions.length, '活动会话'],
                  [embyStatus.transcodes.length, '转码任务'],
                  [embyStatus.tokens.length, '设备令牌'],
                ].map(([count, label]) => (
                  <div key={label} className="flex flex-col rounded-lg border p-3">
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <strong className="text-2xl font-semibold tabular-nums">{count}</strong>
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        {isAdmin && (
          <Section
            id="catalog-sync-title"
            title="媒体目录同步"
            action={
              <Button
                variant="outline"
                size="sm"
                disabled={catalogSyncLoading}
                onClick={() => void synchronizeCatalog()}
              >
                {catalogSyncLoading ? <Spinner /> : <FolderSync data-icon="inline-start" />}
                立即同步
              </Button>
            }
          >
            {catalogSyncError && <Notice title={catalogSyncError} />}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
              {catalogSyncStatus.map((item) => {
                const title = catalog.sources.find((source) => source.id === item.sourceId)?.title || item.sourceId;
                return (
                  <div
                    key={item.sourceId}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1 rounded-lg border p-3 text-sm"
                  >
                    <strong>{title}</strong>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`同步${title}`}
                      title={`同步${title}`}
                      disabled={catalogSyncLoading || item.state === 'scanning'}
                      onClick={() => void synchronizeCatalog(item.sourceId)}
                    >
                      <FolderSync />
                    </Button>
                    <Badge
                      variant={
                        item.state === 'error' ? 'destructive' : item.state === 'scanning' ? 'outline' : 'secondary'
                      }
                    >
                      {item.state === 'error' ? '失败' : item.state === 'scanning' ? '同步中' : '就绪'}
                    </Badge>
                    <span className="col-span-full text-xs text-muted-foreground">{item.scannedItems} 项</span>
                    {item.error && <p className="col-span-full m-0 text-xs text-muted-foreground">{item.error}</p>}
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {isAdmin && (
          <Section
            id="upstream-title"
            title="上游服务"
            description="所有账号共用此服务，请使用可信地址。切换后需重新打开剧集。"
            className="lg:col-span-2"
            busy={configLoading || saving}
          >
            {configLoading && !config && (
              <p role="status" className="text-sm text-muted-foreground">
                正在读取上游配置…
              </p>
            )}
            {configError && (
              <Notice title={configError}>
                <Button variant="ghost" size="sm" disabled={saving} onClick={() => void loadConfig()}>
                  重新读取配置
                </Button>
              </Notice>
            )}
            {config && (
              <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                当前地址：
                <code className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  {config.backendUrl || '未配置'}
                </code>
                {config.backendUrl && <span>（{config.persisted ? '已保存' : '启动配置'}）</span>}
              </p>
            )}
            <form noValidate onSubmit={applyConfig} className="flex flex-col gap-2">
              <Label htmlFor="upstream-url">上游根地址</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="upstream-url"
                  ref={backendInput}
                  name="backendUrl"
                  type="url"
                  autoComplete="url"
                  spellCheck={false}
                  placeholder="http://localhost:3000"
                  value={backendDraft}
                  onChange={(event) => setBackendDraft(event.target.value)}
                  disabled={configLoading || saving || !config || !!configError}
                  aria-describedby={`upstream-title upstream-format${saveError ? ' upstream-error' : ''}`}
                  aria-invalid={!!saveError}
                  className="min-w-0 flex-[1_1_260px]"
                />
                <Button type="submit" disabled={saving || configLoading || !config || !!configError}>
                  {saving && <Spinner />}保存并应用
                </Button>
              </div>
              <p id="upstream-format" className="text-xs text-muted-foreground">
                仅填 HTTP(S) 根地址，不含账号密码或路径。
              </p>
            </form>
            {saving && (
              <p role="status" className="text-sm text-muted-foreground">
                正在保存并刷新来源…
              </p>
            )}
            {saveError && <Notice id="upstream-error" title={saveError} />}
            {saveSuccess && (
              <p className="flex items-start gap-1.5 text-sm" role="status">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                {saveSuccess}
              </p>
            )}
          </Section>
        )}
      </div>

      <Section
        id="sources-title"
        title="内容来源"
        description="隐藏后不在首页和搜索中显示，不改变账号权限。拖动左侧手柄调整顺序。"
      >
        {error && <Notice title={error} />}
        {catalog.error && (
          <Notice title={catalog.error}>
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => void catalog.load(true)}>
              重新读取来源
            </Button>
          </Notice>
        )}
        {catalog.loading && !catalog.sources.length && <LinesSkeleton rows={6} />}
        {!catalog.loading && !catalog.error && !catalog.sources.length && (
          <EmptyState description={isAdmin ? '暂无可用来源，请在上游启用后刷新。' : '暂无可用来源，请联系管理员。'} />
        )}
        <SortableSources
          status={status}
          checking={checking}
          checkErrors={checkErrors}
          saving={saving}
          onCheck={(id) => void check(id)}
        />
      </Section>
    </section>
  );
}

function SortableSources(props: {
  status: Record<string, SourceHealth>;
  checking: Record<string, boolean>;
  checkErrors: Record<string, string>;
  saving: boolean;
  onCheck: (id: string) => void;
}) {
  const sources = useOrderedSources();
  const setSourceOrder = usePreferences((state) => state.setSourceOrder);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = sources.map((source) => source.id);
  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    setSourceOrder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragEnd={onDragEnd}
      accessibility={{
        screenReaderInstructions: { draggable: '按空格键拿起来源，用上下方向键移动，再按空格键放下，按 Esc 取消。' },
        announcements: {
          onDragStart: ({ active }) => `已拿起 ${title(sources, active.id)}`,
          onDragOver: ({ active, over }) =>
            over ? `${title(sources, active.id)} 移到第 ${ids.indexOf(String(over.id)) + 1} 位` : '',
          onDragEnd: ({ active, over }) =>
            over ? `${title(sources, active.id)} 已放到第 ${ids.indexOf(String(over.id)) + 1} 位` : '已放下',
          onDragCancel: ({ active }) => `已取消移动 ${title(sources, active.id)}`,
        },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-3">
          {sources.map((source) => (
            <SourceHealthCard key={source.id} source={source} {...props} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

const title = (sources: Source[], id: string | number) =>
  sources.find((source) => source.id === id)?.title || String(id);

function SourceHealthCard({
  source,
  status,
  checking,
  checkErrors,
  saving,
  onCheck,
}: {
  source: Source;
  status: Record<string, SourceHealth>;
  checking: Record<string, boolean>;
  checkErrors: Record<string, string>;
  saving: boolean;
  onCheck: (id: string) => void;
}) {
  const enabled = usePreferences((state) => !state.disabledSources.includes(source.id));
  const setSourceEnabled = usePreferences((state) => state.setSourceEnabled);
  // dnd-kit owns this element's transform; nothing else may animate it.
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: source.id,
  });
  const health = status[source.id];
  const switchId = `source-visible-${source.id}`;
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'relative flex flex-col gap-3 rounded-lg border bg-card p-3 sm:p-4',
        isDragging && 'z-10 shadow-lg ring-3 ring-ring/50',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            ref={setActivatorNodeRef}
            variant="ghost"
            size="icon"
            aria-label={`调整${source.title}的顺序`}
            className="-ml-1 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical />
          </Button>
          <div>
            <h3 className="text-sm font-medium">{source.title}</h3>
            <span className="text-xs text-muted-foreground">版本 {source.version || '未提供'}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id={switchId}
              checked={enabled}
              onCheckedChange={(value) => setSourceEnabled(source.id, value)}
              aria-label={`显示${source.title}`}
            />
            <Label htmlFor={switchId} className="font-normal text-muted-foreground">
              {enabled ? '显示' : '隐藏'}
            </Label>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={checking[source.id] || saving}
            onClick={() => onCheck(source.id)}
          >
            {checking[source.id] ? <Spinner /> : <Stethoscope data-icon="inline-start" />}
            检查来源
          </Button>
        </div>
      </div>
      {(source.error || checkErrors[source.id]) && (
        <Notice tone="warning" title={checkErrors[source.id] || source.error} />
      )}
      <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {operations
          .filter(
            (operation) =>
              source.capabilities.includes(operation.key === 'browse' ? 'browser' : operation.key) ||
              health?.[operation.key],
          )
          .map((operation) => {
            const result = health?.[operation.key];
            return (
              <div key={operation.key}>
                <dt className="mb-1.5 text-xs text-muted-foreground">{operation.label}</dt>
                <dd className="m-0">
                  {result ? (
                    <Badge
                      variant={result.ok ? 'secondary' : 'destructive'}
                      className={cn(result.ok && 'text-emerald-700 dark:text-emerald-400')}
                    >
                      {result.ok ? '成功' : '失败'}
                    </Badge>
                  ) : (
                    <Badge variant="outline">尚未{operation.key === 'playback' ? '播放' : '检查'}</Badge>
                  )}
                  {result?.message && (
                    <p className="mt-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{result.message}</p>
                  )}
                  {result?.at && (
                    <time className="text-[11px] text-muted-foreground">
                      {new Date(result.at).toLocaleString('zh-CN')}
                    </time>
                  )}
                </dd>
              </div>
            );
          })}
      </dl>
    </article>
  );
}
