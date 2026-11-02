import { useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { login } from '../auth';
import { FieldError, Notice } from '../components/common';
import { PasswordInput } from '../components/PasswordInput';

export default function LoginView() {
  const [query] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [usernameError, setUsernameError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const usernameInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    const nameError = username.trim() ? '' : '请输入用户名。';
    const secretError = password ? '' : '请输入密码。';
    setUsernameError(nameError);
    setPasswordError(secretError);
    if (nameError || secretError) {
      (nameError ? usernameInput : passwordInput).current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await login(username.trim(), password, query.get('redirect'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请重试。');
      setSubmitting(false);
    }
  }

  return (
    <Card role="region" aria-labelledby="login-title">
      <CardHeader>
        <CardTitle id="login-title" role="heading" aria-level={1} className="text-xl font-semibold tracking-tight">
          登录到片刻
        </CardTitle>
        <CardDescription>登录后继续观看，收藏与观看进度会保存在你的账号中。</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate aria-busy={submitting} onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-username">用户名</Label>
            <Input
              id="login-username"
              ref={usernameInput}
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              disabled={submitting}
              value={username}
              aria-invalid={!!usernameError}
              aria-describedby={usernameError ? 'login-username-error' : undefined}
              onChange={(event) => {
                setUsername(event.target.value);
                setUsernameError('');
                setError('');
              }}
            />
            {usernameError && <FieldError id="login-username-error">{usernameError}</FieldError>}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="login-password">密码</Label>
            <PasswordInput
              id="login-password"
              ref={passwordInput}
              name="password"
              autoComplete="current-password"
              disabled={submitting}
              value={password}
              aria-invalid={!!passwordError}
              aria-describedby={passwordError ? 'login-password-error' : undefined}
              onChange={(event) => {
                setPassword(event.target.value);
                setPasswordError('');
                setError('');
              }}
            />
            {passwordError && <FieldError id="login-password-error">{passwordError}</FieldError>}
          </div>
          {error && <Notice title={error} />}
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting && <Spinner />}登录
          </Button>
          {submitting && (
            <p role="status" className="text-sm text-muted-foreground">
              正在登录，请稍候…
            </p>
          )}
        </form>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-muted-foreground">本站不开放注册。如需账号或忘记密码，请联系管理员。</p>
      </CardFooter>
    </Card>
  );
}
