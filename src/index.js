import { parseVpngateCsv, applyFilters, buildUri } from './lib/vpngate.js';

const UPSTREAM_URL = 'https://www.vpngate.net/api/iphone';
/** 版本标记：X-Worker-Version 响应头与帮助页均会显示，用于确认部署是否生效 */
const WORKER_VERSION = '3-diag';
/** 上游列表约每 10 分钟刷新一次，边缘缓存 10 分钟足够 */
const EDGE_CACHE_TTL = 600;
/** 上游故障时，隔离内存中最近一次成功结果的最长可用时间 */
const LAST_GOOD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 同一 isolate 内的"最后已知良好结果"，作为上游临时不可用时的兜底。
 * （跨请求保留在模块作用域中； isolate 重启后为空。）
 * @type {{ body: string, at: number } | null}
 */
let lastGood = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(405, 'Method Not Allowed: use GET\n', {}, request.method === 'HEAD');
    }

    // 路由：仅 /sstp 输出订阅内容；首页与其他路径一律不暴露列表。
    // 想更隐蔽可把下面的常量改成自己的私密路径，如 Set(['/sstp/my-token'])
    const LIST_PATHS = new Set(['/sstp', '/sstp/']);
    if (!LIST_PATHS.has(url.pathname)) {
      return textResponse(
        404,
        [
          'vpngate-sstp worker',
          '',
          'GET /sstp    - sstp node list (one per line)',
          '',
          'Query params:',
          '  ?country=JP,HK   filter by CountryShort (comma separated)',
          '  ?limit=50        max nodes returned',
          '  ?sort=score|speed  sort order (default: upstream order)',
          '  ?debug=1         parse diagnostics instead of the list',
          '',
          `Upstream: ${UPSTREAM_URL}`,
          `Version: ${WORKER_VERSION}`,
          '',
        ].join('\n'),
        {},
        request.method === 'HEAD',
      );
    }

    // 以规范化后的 URL 作为缓存键（仅保留受支持的查询参数）
    const cacheKeyUrl = new URL(url.toString());
    const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET', headers: { 'Accept-Encoding': 'identity' } });

    const cache = caches.default;
    let cached = null;
    try {
      cached = await cache.match(cacheKey);
    } catch {
      /* 缓存 API 异常不应影响主流程 */
    }
    if (cached) {
      return respondWithList(await cached.text(), { cache: 'HIT', url, method: request.method });
    }

    let csvText;
    try {
      csvText = await fetchUpstream();
    } catch (err) {
      const staleUsable = lastGood && Date.now() - lastGood.at < LAST_GOOD_MAX_AGE_MS;
      if (staleUsable) {
        return textResponse(
          200,
          lastGood.body,
          {
            'X-Cache': 'STALE',
            'X-Upstream-Error': String(err && err.message ? err.message : err),
          },
          request.method === 'HEAD',
        );
      }
      return textResponse(
        502,
        `Upstream vpngate.net is unreachable right now: ${err && err.message ? err.message : err}\n`,
        {},
        request.method === 'HEAD',
      );
    }

    const opts = readQuery(url);
    // ?debug=1：返回解析诊断（各步骤计数与被跳过样本），不输出列表、不写缓存
    const wantDebug = url.searchParams.get('debug') === '1';
    const parsed = parseVpngateCsv(csvText, wantDebug);
    if (wantDebug) {
      const diag = { version: WORKER_VERSION, upstreamBytes: csvText.length, ...parsed.stats };
      return textResponse(
        200,
        JSON.stringify(diag, null, 2) + '\n',
        { 'Cache-Control': 'no-store', 'X-Cache': 'DEBUG' },
        request.method === 'HEAD',
      );
    }
    const nodes = applyFilters(parsed, opts);
    // 相同 host:port 的重复条目去重，保持首次出现顺序
    const seen = new Set();
    const lines = [];
    for (const n of nodes) {
      const uri = buildUri(n);
      if (seen.has(uri)) continue;
      seen.add(uri);
      lines.push(uri);
    }
    const body = lines.length > 0 ? lines.join('\n') + '\n' : '';

    const resp = respondWithList(body, { cache: 'MISS', total: nodes.length, url, method: request.method });

    // 回填边缘缓存与内存兜底
    ctx.waitUntil(
      (async () => {
        try {
          await cache.put(cacheKey, resp.clone());
        } catch {
          /* ignore */
        }
      })(),
    );
    if (lines.length > 0) lastGood = { body, at: Date.now() };

    return resp;
  },
};

async function fetchUpstream() {
  const res = await fetch(UPSTREAM_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; vpngate-sstp-worker/1.0)',
      Accept: 'text/plain,text/csv,*/*',
    },
    // 让 Cloudflare 边缘也缓存上游响应，降低对 vpngate.net 的回源频率
    cf: { cacheTtl: EDGE_CACHE_TTL, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  // 简单健全性检查：确认拿到的是 vpngate CSV 而不是拦截页
  if (!text.includes('#HostName')) throw new Error('unexpected upstream payload');
  return text;
}

function readQuery(url) {
  const q = url.searchParams;
  const limitRaw = q.get('limit');
  const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
  return {
    country: q.get('country') ?? undefined,
    sort: q.get('sort') ?? undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  };
}

function respondWithList(body, { cache, total, url, method }) {
  return textResponse(
    200,
    body,
    {
      'Cache-Control': `public, max-age=${EDGE_CACHE_TTL}`,
      'X-Cache': cache,
      'X-Worker-Version': WORKER_VERSION,
      ...(total !== undefined ? { 'X-Node-Count': String(total) } : {}),
    },
    method === 'HEAD',
  );
}

function textResponse(status, body, extraHeaders = {}, headOnly = false) {
  const headers = new Headers({
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
  if (headOnly) return new Response(null, { status, headers });
  return new Response(body, { status, headers });
}
