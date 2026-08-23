/**
 * vpngate-sstp —— Cloudflare Workers 单文件版（适用于 Dashboard 在线编辑器部署）
 *
 * 功能：抓取 https://www.vpngate.net/api/iphone 的公共 CSV，
 * 解出 SSTP 节点并按行输出：
 *   sstp://vpn:vpn@{hostname}.opengw.net:{port}#{CountryShort}-{IP}
 *
 * 用法：Cloudflare Dashboard -> Workers & Pages -> Create Worker -> Edit code，
 *       全选删除默认代码，粘贴本文件全部内容，Deploy。
 * 访问 https://<worker 名>.<子域>.workers.dev/sstp 即得订阅文本（/ 亦可）。
 */

// ===== 可按需修改的配置 =====
const UPSTREAM_URL = 'https://www.vpngate.net/api/iphone';
/** 版本标记：X-Worker-Version 响应头与帮助页均会显示，用于确认部署是否生效 */
const WORKER_VERSION = '3-diag';
const EDGE_CACHE_TTL = 600; // 边缘缓存秒数；上游列表约每 10 分钟刷新
const SSTP_USERNAME = 'vpn';
const SSTP_PASSWORD = 'vpn';

// ===== vpngate CSV 解析 =====

const OPENGW_SUFFIX_RE = /\.opengw\.net$/i;
/** 裸短名：不含点号的名称（public-vpn-219、vpn123456、land-th 等） */
const BARE_HOSTNAME_RE = /^[\w-]+$/i;
/** IPv4 字面量不能当作主机名补全域名 */
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * 引号感知的单行 CSV 切分（RFC4180 风格："" 表示字面引号）。
 * Operator/Message 字段可能含带引号的逗号，不能简单 split(',')。
 */
function splitCsvLine(line) {
  if (!line.includes('"')) return line.split(',');
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/**
 * 把任意形态的主机名归一化为可连接地址：
 *   - *.opengw.net          -> 统一小写（vpn182686651.opengw.net）
 *   - 裸短名 public-vpn-219 / vpn123456 / land-x -> 补全为 <短名>.opengw.net
 *   - 其他完整域名           -> 原样保留（如 vpngate.dnc.ne.jp）
 *   - IPv4 字面量 / 空值     -> null
 */
function normalizeHostname(rawHost) {
  const host = String(rawHost ?? '').trim().toLowerCase();
  if (!host) return null;
  if (OPENGW_SUFFIX_RE.test(host)) {
    return host.replace(OPENGW_SUFFIX_RE, '') + '.opengw.net';
  }
  if (BARE_HOSTNAME_RE.test(host)) {
    return `${host}.opengw.net`;
  }
  if (host.includes('.') && !IPV4_RE.test(host)) {
    return host;
  }
  return null;
}

/** base64 -> utf-8 文本；失败返回空字符串。 */
function decodeConfig(b64) {
  try {
    const bin = atob(String(b64 ?? '').trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

/**
 * 从 OpenVPN 配置文本提取第一条 remote 行，返回 { host, port }。
 * remote 行是服务器真正可连接的地址，权威度高于 CSV 的 HostName 列；
 * 个别配置省略端口，此时 port 为 null（由调用方决定默认值）。
 */
function extractRemote(configText) {
  const m = /^[ \t]*remote[ \t]+(\S+)(?:[ \t]+(\d{1,5}))?/m.exec(String(configText ?? ''));
  if (!m) return null;
  const portRaw = m[2] ? Number(m[2]) : NaN;
  const port = Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535 ? portRaw : null;
  return { host: m[1], port };
}

/**
 * 解析整个 CSV 文本为节点数组 { host, ip, country, port, score, speed }。
 * 上游结构：前两行 "#" 注释、第三行表头、数据行、末行 "*EOF"。
 * 无配置 / 缺端口的行默认 443；仅主机名完全无法确定的行会被跳过。
 *
 * collectStats 为 true 时返回 { nodes, stats }：stats 含各步骤计数与
 * 最多 5 条被跳过行的样本，用于线上诊断（?debug=1）。
 */
function parseVpngateCsv(csvText, collectStats = false) {
  const nodes = [];
  const stats = {
    totalLines: 0,
    commentOrBlank: 0,
    dataRows: 0,
    parsed: 0,
    skippedShortRow: 0,
    skippedBadHostOrIp: 0,
    skippedSamples: [],
  };
  const sample = (name, reason) => {
    if (stats.skippedSamples.length < 5) {
      stats.skippedSamples.push({ name: String(name).slice(0, 60), reason });
    }
  };

  for (const rawLine of String(csvText ?? '').split(/\r?\n/)) {
    stats.totalLines++;
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('*')) {
      stats.commentOrBlank++;
      continue;
    }
    stats.dataRows++;

    const f = splitCsvLine(line);
    if (f.length < 15) {
      stats.skippedShortRow++;
      sample(f[0], `columns=${f.length}`);
      continue;
    }

    // OpenVPN 配置恒为最后一列且不含逗号，取最后一个字段最稳健，
    // 可容忍未加引号的杂散逗号造成的列偏移。
    const b64 = f[f.length - 1].trim();
    const ip = (f[1] || '').trim();
    const country = (f[6] || '').trim().toUpperCase();
    const score = Number.parseInt(f[2], 10) || 0;
    const speed = Number.parseInt(f[4], 10) || 0;

    // 主机名优先取 base64 配置里 remote 行的（真正可连接的地址），
    // 其次才是 CSV 的 HostName 列；public-vpn-219 等短名/别名行由此不再丢失。
    // 没有 OpenVPN 配置的行（b64 为空时 extractRemote 返回 null）同样走
    // HostName 兜底，端口默认 443，一并输出。
    const remote = extractRemote(decodeConfig(b64));
    const host = normalizeHostname(remote && remote.host) || normalizeHostname(f[0]);
    if (!host || !ip) {
      stats.skippedBadHostOrIp++;
      sample(!ip ? '(empty-ip)' : f[0], !ip ? 'empty-ip' : `host=${String(f[0]).slice(0, 40)}`);
      continue;
    }

    // 无配置或 remote 行未写端口时，按 SSTP/HTTPS 惯例默认 443
    const port = (remote && remote.port) || 443;

    stats.parsed++;
    nodes.push({ host, ip, country, port, score, speed });
  }

  return collectStats ? { nodes, stats } : nodes;
}

/** 拼装单条 sstp URI */
function buildUri(node) {
  return `sstp://${SSTP_USERNAME}:${SSTP_PASSWORD}@${node.host}:${node.port}#${node.country}-${node.ip}`;
}

/** 过滤 / 排序 / 截断 */
function applyFilters(nodes, opts = {}) {
  let out = nodes;
  if (opts.country) {
    const wanted = new Set(
      String(opts.country)
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );
    if (wanted.size > 0) out = out.filter((n) => wanted.has(n.country));
  }
  if (opts.sort === 'speed') out = [...out].sort((a, b) => b.speed - a.speed);
  else if (opts.sort === 'score') out = [...out].sort((a, b) => b.score - a.score);
  if (Number.isFinite(opts.limit) && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}

// ===== Worker 主逻辑 =====

/** 上游故障时兜底用的"最后已知良好结果"（仅存于当前 isolate 内存）。 */
let lastGood = null;
const LAST_GOOD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

    // 以规范化后的 URL 作为边缘缓存键
    const cacheKey = new Request(url.toString(), {
      method: 'GET',
      headers: { 'Accept-Encoding': 'identity' },
    });

    let cached = null;
    try {
      cached = await caches.default.match(cacheKey);
    } catch {
      /* 缓存 API 异常不应影响主流程 */
    }
    if (cached) {
      return respondWithList(await cached.text(), { cache: 'HIT', method: request.method });
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

    // ?debug=1：返回解析诊断（各步骤计数与被跳过样本），不输出列表、不写缓存
    if (url.searchParams.get('debug') === '1') {
      const parsedStats = parseVpngateCsv(csvText, true);
      const diag = { version: WORKER_VERSION, upstreamBytes: csvText.length, ...parsedStats.stats };
      return textResponse(
        200,
        JSON.stringify(diag, null, 2) + '\n',
        { 'Cache-Control': 'no-store', 'X-Cache': 'DEBUG' },
        request.method === 'HEAD',
      );
    }

    const nodes = applyFilters(parseVpngateCsv(csvText), readQuery(url));
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

    const resp = respondWithList(body, { cache: 'MISS', total: nodes.length, method: request.method });

    // 回填边缘缓存与内存兜底
    ctx.waitUntil(
      (async () => {
        try {
          await caches.default.put(cacheKey, resp.clone());
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
  // 健全性检查：确认拿到的是 vpngate CSV 而不是拦截页/错误页
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

function respondWithList(body, { cache, total, method }) {
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
