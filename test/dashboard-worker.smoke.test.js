/**
 * 冒烟测试：直接调用 dashboard-worker.js（将粘贴到 Cloudflare Dashboard 的那份文件）
 * 的默认导出 fetch 处理器，通过 mock 全局 fetch / caches 验证端到端行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dashboard-worker.js';

// ---------- 构造模拟上游 CSV ----------

const HEADER =
  '#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64';

function ovpn(host, port) {
  return ['client', 'dev tun', 'proto udp', `remote ${host} ${port}`, 'cipher AES-128-CBC'].join('\n');
}
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');
function row({ host, ip, score = 300000, ping = 10, speed = 5000000, cc = 'JP', extraCols = '', config = '' }) {
  return `${host},${ip},${score},${ping},${speed},TestCountry,${cc},5,86400,100,2000,-,VPN Gate,Public VPN Relay Server${extraCols},${config}`;
}

const FAKE_CSV = [
  '# VPN Gate public csv list',
  '# Generated at 2025-01-01 00:00:00 UTC.',
  HEADER,
  row({ host: 'vpn182686651.opengw.net', ip: '160.16.213.210', cc: 'JP', speed: 9000000, config: b64(ovpn('vpn182686651.opengw.net', 443)) }),
  row({ host: 'vpn999000222', ip: '1.2.3.4', cc: 'KR', speed: 1000, config: b64(ovpn('vpn999000222.opengw.net', 5555)) }),
  row({ host: 'vpngate.dnc.ne.jp', ip: '5.6.7.8', cc: 'US', config: b64(ovpn('vpngate.dnc.ne.jp', 443)) }), // 非 opengw 域名 -> 按原域名保留
  row({ host: 'vpn777777777.opengw.net', ip: '9.9.9.9', cc: 'CN', config: '' }), // 无配置 -> HostName 兜底 + 默认 443
  row({
    host: 'vpn555555555.opengw.net',
    ip: '6.6.6.6',
    cc: 'GB',
    extraCols: ',"Some Operator, Inc.","Thank you, users!"',
    config: b64(ovpn('vpn555555555.opengw.net', 992)),
  }),
  // 用户反馈曾丢失的裸短名形态
  row({ host: 'public-vpn-219', ip: '133.11.226.163', cc: 'JP', speed: 4000000, config: b64(ovpn('public-vpn-219.opengw.net', 443)) }),
  row({ host: 'land-th', ip: '27.254.145.215', cc: 'TH', config: b64(ovpn('land-th.opengw.net', 995)) }),
  '*EOF',
  '',
].join('\n');

const EXPECTED_ALL =
  [
    'sstp://vpn:vpn@vpn182686651.opengw.net:443#JP-160.16.213.210',
    'sstp://vpn:vpn@vpn999000222.opengw.net:5555#KR-1.2.3.4',
    'sstp://vpn:vpn@vpngate.dnc.ne.jp:443#US-5.6.7.8',
    'sstp://vpn:vpn@vpn777777777.opengw.net:443#CN-9.9.9.9',
    'sstp://vpn:vpn@vpn555555555.opengw.net:992#GB-6.6.6.6',
    'sstp://vpn:vpn@public-vpn-219.opengw.net:443#JP-133.11.226.163',
    'sstp://vpn:vpn@land-th.opengw.net:995#TH-27.254.145.215',
  ].join('\n') + '\n';

// ---------- mock 环境 ----------

/** 有状态的边缘缓存 mock，可验证 MISS -> HIT */
function makeCacheMock() {
  const store = new Map();
  return {
    async match(req) {
      return store.get(req.url) ?? null;
    },
    async put(req, res) {
      store.set(req.url, res);
    },
  };
}

/**
 * 安装全局 fetch / caches mock。
 * ctx.waitUntil 记录 promise，用 awaitPending() 确定性等待回填完成。
 */
let upstreamCalls = 0;
let upstreamImpl = null;

function installEnv() {
  const pending = [];
  const cacheMock = makeCacheMock();
  upstreamCalls = 0;
  upstreamImpl = null; // 重置上游 mock，避免上一个用例的故障模拟泄漏
  globalThis.caches = { default: cacheMock };
  globalThis.fetch = async (...args) => {
    upstreamCalls++;
    if (upstreamImpl) return upstreamImpl(...args);
    return new Response(FAKE_CSV, { status: 200 });
  };
  const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
  return { ctx, awaitPending: () => Promise.all(pending), getUpstreamCalls: () => upstreamCalls };
}

const BASE = 'https://vg.example.workers.dev';

test('GET /sstp returns full list, one uri per line, exact format', async () => {
  installEnv();
  assert.equal(typeof worker.fetch, 'function');
  const r = await worker.fetch(new Request(`${BASE}/sstp`), {}, { waitUntil() {} });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.equal(await r.text(), EXPECTED_ALL);
});

test('GET / must NOT expose the list (help only)', async () => {
  installEnv();
  const r = await worker.fetch(new Request(`${BASE}/`), {}, { waitUntil() {} });
  assert.equal(r.status, 404);
  const text = await r.text();
  assert.ok(text.includes('vpngate-sstp worker'));
  assert.ok(!text.includes('sstp://'), '首页不得包含任何节点内容');
});

test('GET /sstp/ (trailing slash) serves the list', async () => {
  installEnv();
  const r = await worker.fetch(new Request(`${BASE}/sstp/`), {}, { waitUntil() {} });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), EXPECTED_ALL);
});

test('query params: country filter + sort=speed + limit', async () => {
  installEnv();
  const r = await worker.fetch(new Request(`${BASE}/sstp?country=jp&sort=speed&limit=5`), {}, { waitUntil() {} });
  // 两台 JP 节点按速度降序：9000000 的完整 FQDN 在前，4000000 的 public-vpn-219 在后
  assert.equal(
    await r.text(),
    [
      'sstp://vpn:vpn@vpn182686651.opengw.net:443#JP-160.16.213.210',
      'sstp://vpn:vpn@public-vpn-219.opengw.net:443#JP-133.11.226.163',
    ].join('\n') + '\n',
  );
});

test('unknown path returns help with 404', async () => {
  installEnv();
  const r = await worker.fetch(new Request(`${BASE}/nope`), {}, { waitUntil() {} });
  assert.equal(r.status, 404);
  assert.ok((await r.text()).includes('vpngate-sstp worker'));
});

test('HEAD returns headers without body', async () => {
  installEnv();
  const r = await worker.fetch(new Request(`${BASE}/sstp`, { method: 'HEAD' }), {}, { waitUntil() {} });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '');
});

test('cache MISS then HIT; upstream called only once', async () => {
  const env = installEnv();
  const url = `${BASE}/sstp`;
  const r1 = await worker.fetch(new Request(url), {}, env.ctx);
  assert.equal(r1.headers.get('X-Cache'), 'MISS');
  assert.equal(env.getUpstreamCalls(), 1);
  await r1.text();
  await env.awaitPending(); // 等 waitUntil 的 cache.put 完成

  const r2 = await worker.fetch(new Request(url), {}, env.ctx);
  assert.equal(r2.headers.get('X-Cache'), 'HIT');
  assert.equal(env.getUpstreamCalls(), 1); // 未再回源
  assert.equal(await r2.text(), EXPECTED_ALL);
});

test('upstream failure: warm isolate serves STALE last-good', async () => {
  // 前面的测试已让模块级 lastGood 有值（同一进程内顺序执行）
  installEnv();
  upstreamImpl = async () => new Response('503 Service Unavailable', { status: 503 });

  const stale = await worker.fetch(new Request(`${BASE}/sstp`), {}, { waitUntil() {} });
  assert.equal(stale.headers.get('X-Cache'), 'STALE');
  assert.equal(stale.status, 200);
  const text = await stale.text();
  assert.ok(text.startsWith('sstp://vpn:vpn@'), 'STALE 内容应为 sstp 列表');
});

test('cold isolate + upstream failure returns 502 (fresh module instance)', async () => {
  // 用带 query 的导入获得全新模块实例（lastGood 为空），模拟冷启动
  const freshWorker = (await import('../dashboard-worker.js?cold=1')).default;
  installEnv();
  // 显式模拟上游持续失败
  upstreamImpl = async () => new Response('err', { status: 500 });

  const bad = await freshWorker.fetch(new Request(`${BASE}/sstp`), {}, { waitUntil() {} });
  assert.equal(bad.status, 502);
  assert.ok((await bad.text()).includes('unreachable'));
});

test('?debug=1 returns diagnostics instead of the list', async () => {
  installEnv();
  const r = await worker.fetch(new Request(`${BASE}/sstp?debug=1`), {}, { waitUntil() {} });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('X-Cache'), 'DEBUG');
  const text = await r.text();
  assert.ok(text.includes('"version"'), text);
  assert.ok(text.includes('"upstreamBytes"'));
  assert.ok(text.includes('"dataRows": 7'), text);
  assert.ok(text.includes('"parsed": 7'));
  assert.ok(text.includes('"skippedShortRow": 0'));
});

test('list responses carry X-Worker-Version header', async () => {
  installEnv();
  const r = await worker.fetch(new Request(`${BASE}/sstp`), {}, { waitUntil() {} });
  assert.equal(r.headers.get('X-Worker-Version'), '3-diag');
});
