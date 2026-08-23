/**
 * vpngate.net CSV 解析与 sstp:// 订阅条目生成。
 *
 * 上游 https://www.vpngate.net/api/iphone 返回纯文本 CSV：
 *   第 1-2 行： "#" 开头的注释
 *   第 3 行  ： 表头
 *              #HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,
 *              NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,
 *              Operator,Message,OpenVPN_ConfigData_Base64
 *   之后每行一台服务器，最后一行为 "*EOF"
 *
 * 关键点：
 *   - 端口不在 CSV 明文里，而是编码在 OpenVPN_ConfigData_Base64 中，
 *     base64 解码后取 "remote <host> <port>" 行的端口与主机名。
 *   - Operator / Message 字段可能包含带引号的逗号，需要引号感知的 CSV 切分。
 *   - HostName 列形态多样：完整 FQDN（vpn123456.opengw.net）、裸短名
 *     （public-vpn-219、vpn123456、land-* 等）、其他完整域名
 *     （vpngate.dnc.ne.jp）。可连接地址以 remote 行为准，HostName 兜底。
 */

/** 输出格式：sstp://vpn:vpn@{host}.opengw.net:{port}#{CountryShort}-{IP} */
export const SSTP_USERNAME = 'vpn';
export const SSTP_PASSWORD = 'vpn';

const OPENGW_SUFFIX_RE = /\.opengw\.net$/i;
/** 裸短名：不含点号的名称（public-vpn-219、vpn123456、land-th 等） */
const BARE_HOSTNAME_RE = /^[\w-]+$/i;
/** IPv4 字面量不能当作主机名补全域名 */
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * 引号感知的单行 CSV 切分（RFC4180 风格："" 表示字面引号）。
 * 无引号时走快速路径。
 */
export function splitCsvLine(line) {
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
export function normalizeHostname(rawHost) {
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

/** base64 -> utf-8 文本；失败返回空字符串。Workers 与 Node 均有 atob。 */
export function decodeConfig(b64) {
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
export function extractRemote(configText) {
  const m = /^[ \t]*remote[ \t]+(\S+)(?:[ \t]+(\d{1,5}))?/m.exec(String(configText ?? ''));
  if (!m) return null;
  const portRaw = m[2] ? Number(m[2]) : NaN;
  const port = Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535 ? portRaw : null;
  return { host: m[1], port };
}

/**
 * 解析整个 CSV 文本为节点数组。
 * 每个元素：{ host, ip, country, port, score, speed }
 * 无配置 / 缺端口的行默认 443；仅主机名完全无法确定的行会被跳过。
 *
 * collectStats 为 true 时返回 { nodes, stats }：stats 含总行数、数据行数、
 * 成功解析数、按原因分类的跳过计数，以及最多 5 条被跳过行的样本，
 * 便于对真实数据做线上诊断（?debug=1）。
 */
export function parseVpngateCsv(csvText, collectStats = false) {
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

    // OpenVPN 配置恒为最后一列且不含逗号，因此取最后一个字段最稳健，
    // 可容忍 Operator/Message 中未加引号的杂散逗号造成的列偏移。
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

/** 拼装单条 sstp URI：sstp://vpn:vpn@{host}:{port}#{CountryShort}-{IP} */
export function buildUri(node) {
  return `sstp://${SSTP_USERNAME}:${SSTP_PASSWORD}@${node.host}:${node.port}#${node.country}-${node.ip}`;
}

/**
 * 过滤 / 排序 / 截断：
 *   opts.country 形如 "JP,HK,US" 的国家短码列表（不区分大小写）
 *   opts.sort    'score' | 'speed' | undefined（保持上游顺序）
 *   opts.limit   最多返回条数
 */
export function applyFilters(nodes, opts = {}) {
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
