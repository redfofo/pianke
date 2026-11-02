import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowLeft, CircleCheck, RefreshCw, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { createUser, listSourceEntries, listUsers, saveUserSources, type SourceEntry, type User } from '../auth';
import { sourceCatalog } from '../source-catalog';
import { FieldError, Notice, PageHeading } from '../components/common';
import { PasswordInput } from '../components/PasswordInput';
import { SourceSelection } from '../components/SourceSelection';

const message = (reason: unknown, fallback: string) => (reason instanceof Error ? reason.message : fallback);
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

function sourceSummary(user: User, sources: readonly SourceEntry[]): string {
  if (user.role === 'admin' || sources.every((source) => user.sourceIds.includes(source.id))) return '全部来源';
  return (
    sources
      .filter((source) => user.sourceIds.includes(source.id))
      .map((source) => source.title)
      .join('、') || '无可浏览来源'
  );
}

export default function AdminUsersView() {
  const queryClient = useQueryClient();
  const usersQuery = useQuery({ queryKey: ['admin-users'], queryFn: listUsers, staleTime: 0 });
  // Sources added upstream appear here without a player release; the built-in list covers a failed request.
  const sourcesQuery = useQuery({ queryKey: ['admin-sources'], queryFn: listSourceEntries, staleTime: 0 });
  const sources = sourcesQuery.data || sourceCatalog;
  const allSourceIds = sources.map((source) => source.id);
  const users = usersQuery.data || [];
  const loading = usersQuery.isFetching;
  const loaded = usersQuery.isSuccess;
  const loadError = usersQuery.error ? message(usersQuery.error, '账号列表读取失败，请重试。') : '';
  const setUsers = (update: (list: User[]) => User[]) =>
    queryClient.setQueryData<User[]>(['admin-users'], (list) => update(list || []));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [usernameError, setUsernameError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [createError, setCreateError] = useState('');
  const [success, setSuccess] = useState('');
  const [creating, setCreating] = useState(false);
  // null selects every source, including ones still loading.
  const [newSourceDraft, setNewSources] = useState<string[] | null>(null);
  const newSources = newSourceDraft ?? allSourceIds;
  const [editingId, setEditingId] = useState('');
  const [sourceDraft, setSourceDraft] = useState<string[]>([]);
  const [savingSources, setSavingSources] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [sourceSuccess, setSourceSuccess] = useState('');
  const usernameInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);

  function refresh() {
    if (loading || creating || savingSources || editingId) return;
    void usersQuery.refetch();
    void sourcesQuery.refetch();
  }

  function editSources(user: User) {
    setEditingId(user.id);
    setSourceDraft([...user.sourceIds]);
    setSourceError('');
    setSourceSuccess('');
  }
  async function applySources(event: FormEvent) {
    event.preventDefault();
    if (savingSources || !editingId) return;
    setSavingSources(true);
    setSourceError('');
    try {
      const user = await saveUserSources(editingId, sourceDraft);
      setUsers((list) => list.map((item) => (item.id === user.id ? user : item)));
      setEditingId('');
      setSourceSuccess(`「${user.username}」的来源权限已保存。`);
    } catch (reason) {
      setSourceError(message(reason, '来源权限保存失败，请重试。'));
    } finally {
      setSavingSources(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (creating || loading) return;
    setCreateError('');
    setSuccess('');
    const name = username.trim();
    const nameError = /^[A-Za-z0-9_][A-Za-z0-9_.-]{2,31}$/.test(name)
      ? ''
      : '用户名需为 3–32 个字符，以字母、数字或下划线开头，仅含字母、数字、下划线、点或短横线。';
    const secretError = password.length >= 10 && password.length <= 128 ? '' : '密码需为 10–128 个字符。';
    setUsernameError(nameError);
    setPasswordError(secretError);
    if (nameError || secretError) {
      (nameError ? usernameInput : passwordInput).current?.focus();
      return;
    }
    setCreating(true);
    try {
      const user = await createUser(name, password, newSources);
      setUsers((list) => [...list, user]);
      setUsername('');
      setPassword('');
      setNewSources(null);
      setSuccess(`账号「${user.username}」已创建。`);
    } catch (reason) {
      setCreateError(message(reason, '账号创建失败，请重试。'));
    } finally {
      setCreating(false);
    }
  }
  const clearCreateMessages = () => {
    setCreateError('');
    setSuccess('');
  };

  return (
    <section aria-labelledby="users-title" className="flex max-w-5xl flex-col gap-4">
      <PageHeading id="users-title" title="账号管理">
        <Button asChild variant="outline">
          <Link to="/settings">
            <ArrowLeft data-icon="inline-start" />
            返回设置
          </Link>
        </Button>
      </PageHeading>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card role="region" aria-labelledby="create-user-title">
          <CardHeader>
            <CardTitle id="create-user-title" role="heading" aria-level={2}>
              添加普通账号
            </CardTitle>
            <CardDescription>新账号默认可浏览全部来源，可按需取消勾选。</CardDescription>
          </CardHeader>
          <CardContent>
            <form noValidate aria-busy={creating} onSubmit={submit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-username">用户名</Label>
                <Input
                  id="new-username"
                  ref={usernameInput}
                  name="username"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={creating}
                  value={username}
                  aria-invalid={!!usernameError}
                  aria-describedby={`username-format${usernameError ? ' new-username-error' : ''}`}
                  onChange={(event) => {
                    setUsername(event.target.value);
                    setUsernameError('');
                    clearCreateMessages();
                  }}
                />
                <p id="username-format" className="text-xs text-muted-foreground">
                  3–32 个字母、数字或 _ . -，不能以点或短横线开头，不区分大小写。
                </p>
                {usernameError && <FieldError id="new-username-error">{usernameError}</FieldError>}
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-password">初始密码</Label>
                <PasswordInput
                  id="new-password"
                  ref={passwordInput}
                  name="password"
                  autoComplete="new-password"
                  disabled={creating}
                  value={password}
                  aria-invalid={!!passwordError}
                  aria-describedby={`password-format${passwordError ? ' new-password-error' : ''}`}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setPasswordError('');
                    clearCreateMessages();
                  }}
                />
                <p id="password-format" className="text-xs text-muted-foreground">
                  10–128 个字符。请为每个账号设置不同的密码。
                </p>
                {passwordError && <FieldError id="new-password-error">{passwordError}</FieldError>}
              </div>
              <SourceSelection sources={sources} value={newSources} onChange={setNewSources} disabled={creating} />
              {createError && <Notice title={createError} />}
              <Button type="submit" disabled={creating || loading} className="self-start">
                {creating ? <Spinner /> : <UserPlus data-icon="inline-start" />}创建账号
              </Button>
              {creating && (
                <p className="text-sm text-muted-foreground" role="status">
                  正在创建账号…
                </p>
              )}
              {success && (
                <p className="flex items-center gap-1.5 text-sm" role="status">
                  <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                  {success}
                </p>
              )}
            </form>
          </CardContent>
        </Card>
        <Card role="region" aria-labelledby="user-list-title" aria-busy={loading}>
          <CardHeader>
            <CardTitle id="user-list-title" role="heading" aria-level={2}>
              已有账号{loaded && <span className="text-muted-foreground tabular-nums">（{users.length}）</span>}
            </CardTitle>
            <CardAction>
              <Button variant="outline" size="sm" disabled={creating || loading || !!editingId} onClick={refresh}>
                {loading ? <Spinner /> : <RefreshCw data-icon="inline-start" />}刷新列表
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {loadError && <Notice title={loadError} />}
            {sourceSuccess && (
              <p className="flex items-center gap-1.5 text-sm" role="status">
                <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                {sourceSuccess}
              </p>
            )}
            {loading && !loaded ? (
              <p className="text-sm text-muted-foreground" role="status">
                正在读取账号…
              </p>
            ) : (
              loaded && !users.length && <p className="text-sm text-muted-foreground">暂无账号。</p>
            )}
            {users.length > 0 && (
              <ul aria-label="账号列表" className="flex flex-col divide-y rounded-lg border">
                {users.map((user) => (
                  <li key={user.id} className="flex flex-col gap-2 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold"
                        >
                          {user.username.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="grid min-w-0 leading-tight">
                          <strong className="truncate text-sm font-medium">{user.username}</strong>
                          <span className="text-xs text-muted-foreground">
                            创建于{' '}
                            <time dateTime={new Date(user.createdAt).toISOString()}>
                              {dateFormat.format(user.createdAt)}
                            </time>
                          </span>
                        </div>
                        <Badge variant={user.role === 'admin' ? 'default' : 'secondary'}>
                          {user.role === 'admin' ? '管理员' : '普通用户'}
                        </Badge>
                      </div>
                      {user.role !== 'admin' && editingId !== user.id && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!!editingId || loading}
                          onClick={() => editSources(user)}
                        >
                          编辑来源
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {sourceSummary(user, sources)}
                    </p>
                    {editingId === user.id && (
                      <form
                        aria-label={`${user.username}的来源权限`}
                        aria-busy={savingSources}
                        onSubmit={applySources}
                        className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3"
                      >
                        <SourceSelection
                          sources={sources}
                          value={sourceDraft}
                          onChange={setSourceDraft}
                          disabled={savingSources}
                        />
                        {sourceError && <Notice title={sourceError} />}
                        <div className="flex gap-2">
                          <Button type="submit" size="sm" disabled={savingSources}>
                            {savingSources && <Spinner />}保存权限
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={savingSources}
                            onClick={() => {
                              setEditingId('');
                              setSourceError('');
                            }}
                          >
                            取消
                          </Button>
                        </div>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
