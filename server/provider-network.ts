import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import type { LookupAddress } from 'node:dns';
import { backendUrl } from './config.js';

// BlockList maps IPv4 into IPv6 internally; keep families separate so denying mapped
// IPv6 destinations does not accidentally deny every ordinary IPv4 destination.
const blockedIPv4 = new BlockList();
const blockedIPv6 = new BlockList();
for (const [network, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blockedIPv4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::',128],['::1',128],['::ffff:0:0',96],['64:ff9b::',96],['64:ff9b:1::',48],['100::',64],['2001::',23],['2002::',16],['fc00::',7],['fe80::',10],['ff00::',8]] as const) blockedIPv6.addSubnet(network, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blockedIPv4.check(address, 'ipv4') : family === 6 && !blockedIPv6.check(address, 'ipv6');
}

// Fake-IP DNS (Clash/mihomo/sing-box) answers with synthetic addresses that the local gateway maps back to the
// requested domain. Trusting such a range delegates the final destination to that gateway, so LAN, loopback and
// multicast space can never be trusted this way.
const neverTrusted: [number, number][] = [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['224.0.0.0',4],['240.0.0.0',4]].map(([network, prefix]) => ipv4Range(network as string, prefix as number));
function ipv4Range(network: string, prefix: number): [number, number] {
  const value = network.split('.').reduce((total, part) => total * 256 + Number(part), 0);
  const size = 2 ** (32 - prefix);
  const start = value - (value % size);
  return [start, start + size - 1];
}
let trustedSpec: string | undefined;
let trustedList: BlockList | undefined;
function trustedFakeIp(): BlockList | undefined {
  const spec = (process.env.TRUSTED_FAKE_IP_CIDRS || '').trim();
  if (spec === trustedSpec) return trustedList;
  const list = new BlockList();
  for (const entry of spec.split(',').map(item => item.trim()).filter(Boolean)) {
    const match = entry.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
    const prefix = Number(match?.[2]);
    if (!match || isIP(match[1]!) !== 4 || prefix < 8 || prefix > 32) throw new Error(`TRUSTED_FAKE_IP_CIDRS 只接受 IPv4 CIDR（前缀 8–32）：${entry}`);
    const [start, end] = ipv4Range(match[1]!, prefix);
    if (neverTrusted.some(([low, high]) => start <= high && low <= end)) throw new Error(`TRUSTED_FAKE_IP_CIDRS 不能包含内网、环回或组播地址：${entry}`);
    list.addSubnet(match[1]!, prefix, 'ipv4');
  }
  trustedSpec = spec;
  trustedList = spec ? list : undefined;
  return trustedList;
}
/** Public addresses, plus the explicitly trusted fake-IP ranges of the local DNS gateway. */
export function isAllowedUpstreamAddress(address: string): boolean {
  if (isPublicAddress(address)) return true;
  return isIP(address) === 4 && !!trustedFakeIp()?.check(address, 'ipv4');
}

const dnsCache = new Map<string, { addresses: LookupAddress[]; expires: number }>();
/** Optional numeric-IP DoH endpoint bypasses fake-IP DNS without trusting private destinations. */
export async function resolveUpstreamHost(host: string, configuredBackend = false): Promise<LookupAddress[]> {
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  const endpoint = process.env.UPSTREAM_DOH_URL;
  if (!endpoint || configuredBackend) return lookup(host, { all: true });
  const cached = dnsCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.addresses;
  const url = new URL(endpoint);
  const resolverIP = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || !isIP(resolverIP) || !isPublicAddress(resolverIP) || url.username || url.password) throw new Error('UPSTREAM_DOH_URL 必须使用公网 IP 的 HTTPS DNS JSON 接口');
  url.searchParams.set('name', host);
  url.searchParams.set('type', 'A');
  const response = await fetch(url, { headers: { accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`加密 DNS 返回 HTTP ${response.status}`);
  let text = '';
  for await (const chunk of response.body || []) {
    text += Buffer.from(chunk).toString('utf8');
    if (text.length > 65536) throw new Error('加密 DNS 响应过大');
  }
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || !('Answer' in data) || !Array.isArray(data.Answer)) throw new Error(`加密 DNS 未能解析 ${host}`);
  const addresses: LookupAddress[] = [];
  let ttl = 300;
  for (const answer of data.Answer) {
    if (!answer || typeof answer !== 'object' || !('type' in answer) || answer.type !== 1 || !('data' in answer) || typeof answer.data !== 'string') continue;
    if (!isPublicAddress(answer.data)) throw new Error('加密 DNS 返回非公网地址');
    addresses.push({ address: answer.data, family: 4 });
    if ('TTL' in answer && typeof answer.TTL === 'number') ttl = Math.min(ttl, Math.max(1, answer.TTL));
  }
  if (!addresses.length) throw new Error(`加密 DNS 没有返回 ${host} 的公网地址`);
  if (dnsCache.size >= 2000) dnsCache.clear();
  dnsCache.set(host, { addresses, expires: Date.now() + ttl * 1000 });
  return addresses;
}
export interface RequestOptions { method?: string; headers?: Record<string,string>; body?: string; timeout?: number; maxBytes?: number; redirects?: number; signal?: AbortSignal; allowBackend?: boolean; validateUrl?: (url: URL) => void | Promise<void>; }
export interface NetworkResponse { status: number; ok: boolean; headers: Record<string,string>; data: string; url: string; }
export interface BinaryNetworkResponse extends Omit<NetworkResponse, 'data'> { data: Buffer; }
async function validatedAddresses(url: URL, allowBackend: boolean): Promise<LookupAddress[]> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('不允许的上游地址');
  const configuredBackend = allowBackend && url.origin === backendUrl;
  const addresses = await resolveUpstreamHost(url.hostname.replace(/^\[|\]$/g, ''), configuredBackend);
  if (!addresses.length || (!configuredBackend && addresses.some(address => !isAllowedUpstreamAddress(address.address)))) throw new Error('拒绝访问非公网地址');
  return addresses;
}
/** Validate nested proxy targets without making a request or granting the backend exception. */
export async function assertPublicUpstreamUrl(input: string): Promise<void> {
  await validatedAddresses(new URL(input), false);
}
export async function safeRequest(input: string, options: RequestOptions = {}): Promise<NetworkResponse> {
  const response = await safeBinaryRequest(input, options);
  return { ...response, data: response.data.toString('utf8') };
}
/** Shares the DNS-pinned transport and redirect checks with text/widget requests. */
export async function safeBinaryRequest(input: string, options: RequestOptions = {}): Promise<BinaryNetworkResponse> {
  const deadline = Date.now() + Math.min(Math.max(options.timeout || 15000, 100), 60000);
  let url = new URL(input);
  let headers = { ...options.headers };
  let method = options.method || 'GET';
  let body = options.body;
  const maxBytes = Math.min(options.maxBytes || 8 * 1024 * 1024, 16 * 1024 * 1024);
  for (let hop = 0; hop <= (options.redirects ?? 5); hop++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('不允许的上游地址');
    if (options.signal?.aborted) throw new Error('上游请求已取消');
    const { promise: dnsDeadline, reject: rejectDns } = Promise.withResolvers<never>();
    const dnsTimer = setTimeout(() => rejectDns(new Error('上游 DNS 超时')), Math.max(1, deadline - Date.now()));
    dnsTimer.unref();
    const addresses = await Promise.race([(async () => {
      await options.validateUrl?.(url);
      return validatedAddresses(url, !!options.allowBackend);
    })(), dnsDeadline]).finally(() => clearTimeout(dnsTimer));
    if (options.signal?.aborted) throw new Error('上游请求已取消');
    if (Date.now() >= deadline) throw new Error('上游请求超时');
    const address = addresses[0]!;
    const { promise, resolve, reject } = Promise.withResolvers<BinaryNetworkResponse>();
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(url, {
        method, headers: { 'accept-encoding': 'identity', ...headers }, signal: options.signal, family: address.family,
        lookup: (_hostname, _opts, callback) => callback(null, address.address, address.family),
      }, res => {
        const chunks: Buffer[] = [];
        let length = 0;
        res.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > maxBytes) { request.destroy(new Error('上游响应超过大小限制')); return; }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            let bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, length);
            const encoding = res.headers['content-encoding'];
            const unzipOptions = { maxOutputLength: maxBytes };
            if (encoding === 'gzip') bytes = gunzipSync(bytes, unzipOptions);
            else if (encoding === 'deflate') bytes = inflateSync(bytes, unzipOptions);
            else if (encoding === 'br') bytes = brotliDecompressSync(bytes, unzipOptions);
            else if (encoding && encoding !== 'identity') throw new Error('不支持的上游压缩格式');
            const responseHeaders: Record<string,string> = {};
            for (const [key,value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
            resolve({ status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, headers: responseHeaders, data: bytes, url: url.href });
          } catch (error) { reject(error); }
        });
      });
      const timer = setTimeout(() => request.destroy(new Error('上游请求超时')), Math.max(1, deadline - Date.now()));
      request.on('close', () => clearTimeout(timer));
      request.on('error', reject);
      request.end(body);
    const response = await promise;
    if (![301,302,303,307,308].includes(response.status) || !response.headers.location || options.redirects === 0) return response;
    const next = new URL(response.headers.location, url);
    if (next.origin !== url.origin) headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !['authorization','proxy-authorization','cookie','host','x-api-key','x-auth-token'].includes(key.toLowerCase())));
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
    url = next;
  }
  throw new Error('上游重定向次数过多');
}
