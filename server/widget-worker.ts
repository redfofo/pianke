import { createContext, Script } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { load } from 'cheerio/slim';

interface RequestMessage { kind: 'start'; code: string; functionName: string; argument: unknown; backendUrl: string; }
interface HttpReply { kind: 'http-result'; id: number; response?: { status: number; headers: Record<string,string>; data: string; url: string }; error?: string; }
interface Pending { resolve: (value: HttpReply) => void; reject: (error: Error) => void; }
const pending = new Map<number, Pending>();
let sequence = 0;
let started = false;
const timers = new Set<NodeJS.Timeout>();
const logs: string[] = [];
const sendLog = (...values: unknown[]) => {
  const message = values.map(value => value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value)).join(' ').slice(0, 1200);
  logs.push(message);
  if (logs.length > 12) logs.shift();
};
async function request(input: string | URL | Request, options: RequestInit & { timeout?: number; allow_redirects?: boolean } = {}): Promise<Response> {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  if (options.signal?.aborted) throw new Error('请求已取消');
  const headers = Object.fromEntries(new Headers(options.headers).entries());
  const body = options.body == null ? undefined : typeof options.body === 'string' ? options.body : options.body instanceof URLSearchParams ? options.body.toString() : (() => { throw new Error('组件请求正文格式不支持'); })();
  const id = ++sequence;
  const { promise, resolve, reject } = Promise.withResolvers<HttpReply>();
  const abort = () => { pending.delete(id); process.send?.({ kind: 'http-cancel', id }); reject(new Error('请求已取消')); };
  options.signal?.addEventListener('abort', abort, { once: true });
  pending.set(id, { resolve: response => { options.signal?.removeEventListener('abort', abort); resolve(response); }, reject });
  process.send?.({ kind: 'http', id, url, options: { method: options.method || 'GET', headers, body, timeout: options.timeout, redirects: options.allow_redirects === false || options.redirect === 'manual' ? 0 : 5 } });
  const reply = await promise;
  if (reply.error || !reply.response) throw new Error(reply.error || '宿主网络响应缺失');
  const data = reply.response;
  const response = new Response([204,205,304].includes(data.status) ? null : data.data, { status: data.status, headers: data.headers });
  Object.defineProperty(response, 'url', { value: data.url });
  return response;
}
process.on('message', async (message: RequestMessage | HttpReply) => {
  if (message.kind === 'http-result') {
    pending.get(message.id)?.resolve(message);
    pending.delete(message.id);
    return;
  }
  if (message.kind !== 'start' || started) return;
  started = true;
  try {
    const http = async (url: string, options: RequestInit & { timeout?: number; allow_redirects?: boolean } = {}) => {
      const response = await request(url, options);
      const result = { data: await response.text(), status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers.entries()), url: response.url };
      // Widget.http follows the throwing HTTP-client convention; native fetch below does not.
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}: ${response.url}`), { status: response.status, statusCode: response.status, response: result });
      return result;
    };
    // VM only supplies widget namespace semantics; the OS child and Node permission model are the isolation boundary.
    const context = createContext({
      Widget: { http: { get: http, post: (url: string, body: unknown, options: RequestInit = {}) => http(url, { ...options, method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }) }, html: { load } },
      fetch: request, URL, URLSearchParams, Headers, Request, Response, AbortController, AbortSignal,
      TextEncoder, TextDecoder, atob, btoa, crypto: webcrypto,
      console: { log: sendLog, warn: sendLog, error: sendLog, info: sendLog, debug: sendLog },
      setTimeout: (callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
        const timer = setTimeout(() => { timers.delete(timer); callback(...args); }, Math.min(Math.max(Number(delay) || 0, 0), 60000));
        timers.add(timer);
        return timer;
      },
      clearTimeout: (timer: NodeJS.Timeout) => { clearTimeout(timer); timers.delete(timer); },
      __argument: message.argument,
    });
    new Script(message.code, { filename: 'upstream-widget.js' }).runInContext(context, { timeout: 3000 });
    new Script(`CAPY_BACKEND_URL = ${JSON.stringify(message.backendUrl)}; if (typeof MISSAV_PLAYER_MODE !== "undefined") MISSAV_PLAYER_MODE = "hls";`).runInContext(context, { timeout: 1000 });
    if (!/^[A-Za-z_$][\w$]*$/.test(message.functionName)) throw new Error('组件函数名称无效');
    const result: unknown = await new Script(`${message.functionName}(__argument)`).runInContext(context, { timeout: 3000 });
    process.send?.({ kind: 'result', result, logs });
  } catch (error) {
    process.send?.({ kind: 'result', error: error instanceof Error ? error.message : String(error), logs });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }
});
process.on('disconnect', () => process.exit(0));
