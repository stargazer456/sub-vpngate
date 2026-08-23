import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCsvLine,
  normalizeHostname,
  extractRemote,
  decodeConfig,
  parseVpngateCsv,
  buildUri,
  applyFilters,
} from '../src/lib/vpngate.js';

const HEADER =
  '#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64';

function ovpn(host, port) {
  return [
    '# VPN Gate automatic generated configuration file',
    '# This is a confidential file. Do not distribute.',
    '',
    'client',
    'dev tun',
    'proto udp',
    `remote ${host} ${port}`,
    'cipher AES-128-CBC',
    'auth SHA1',
    'resolv-retry infinite',
    'nobind',
    'persist-key',
    'persist-tun',
    '',
  ].join('\n');
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function row({ host, ip, score = 300000, ping = 10, speed = 5000000, cc = 'JP', extraCols = '', config = '' }) {
  // LogType, Operator, Message 之后是 base64 配置（最后一列）
  return `${host},${ip},${score},${ping},${speed},TestCountry,${cc},5,86400,100,2000,-,VPN Gate,Public VPN Relay Server${extraCols},${config}`;
}

const CSV = [
  '# VPN Gate public csv list',
  '# Generated at 2025-01-01 00:00:00 UTC. Refreshed every 10 minutes.',
  HEADER,
  // 1. 完整 FQDN 主机名，端口 443
  row({ host: 'vpn182686651.opengw.net', ip: '160.16.213.210', cc: 'JP', config: b64(ovpn('vpn182686651.opengw.net', 443)) }),
  // 2. 短名主机形式，端口 5555
  row({ host: 'vpn999000222', ip: '1.2.3.4', cc: 'KR', config: b64(ovpn('vpn999000222.opengw.net', 5555)) }),
  // 3. 非 opengw 公共中继域名 -> 按原样保留（不再丢弃）
  row({ host: 'vpngate.dnc.ne.jp', ip: '5.6.7.8', cc: 'US', config: b64(ovpn('vpngate.dnc.ne.jp', 443)) }),
  // 4. 无 OpenVPN 配置 -> 主机名走 HostName 兜底，端口默认 443
  row({ host: 'vpn777777777.opengw.net', ip: '9.9.9.9', cc: 'CN', config: '' }),
  // 5. remote 行无端口 -> 默认 443（不再整行跳过）
  row({ host: 'vpn666666666.opengw.net', ip: '8.8.4.4', cc: 'DE', config: b64('client\ndev tun\nremote vpn666666666.opengw.net\n') }),
  // 6. Message 含引号包裹的逗号 -> 引号感知解析必须正确
  row({
    host: 'vpn555555555.opengw.net',
    ip: '6.6.6.6',
    cc: 'GB',
    extraCols: ',"Some Operator, Inc.","Thank you, users!"',
    config: b64(ovpn('vpn555555555.opengw.net', 992)),
  }),
  // 7. 多条 remote 行时取第一条
  row({ host: 'vpn444444444.opengw.net', ip: '7.7.7.7', cc: 'SG', config: b64(ovpn('vpn444444444.opengw.net', 443) + 'remote vpn444444444.opengw.net 1194\n') }),
  // 8. 裸短名别名 public-vpn-N -> 以 remote 行的 FQDN 为准
  row({ host: 'public-vpn-219', ip: '133.11.226.163', cc: 'JP', config: b64(ovpn('public-vpn-219.opengw.net', 443)) }),
  // 9. land-* 之类的裸短名同理
  row({ host: 'land-th', ip: '27.254.145.215', cc: 'TH', config: b64(ovpn('land-th.opengw.net', 995)) }),
  // 10. HostName 列是别名而 remote 行有真 FQDN -> 取 remote 行主机与端口
  row({ host: 'some-alias-name', ip: '10.0.0.1', cc: 'CA', config: b64(ovpn('vpn123123123.opengw.net', 1194)) }),
  '*EOF',
  '',
].join('\n');

test('splitCsvLine handles plain and quoted fields', () => {
  assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsvLine('a,"b,1","c""x",d'), ['a', 'b,1', 'c"x', 'd']);
});

test('normalizeHostname accepts bare aliases and other domains', () => {
  assert.equal(normalizeHostname('VPN182686651.opengw.NET'), 'vpn182686651.opengw.net');
  assert.equal(normalizeHostname('vpn999000222'), 'vpn999000222.opengw.net');
  assert.equal(normalizeHostname('public-vpn-219'), 'public-vpn-219.opengw.net');
  assert.equal(normalizeHostname('land-th'), 'land-th.opengw.net');
  assert.equal(normalizeHostname('v-dot-pn-ams2.opengw.net'), 'v-dot-pn-ams2.opengw.net');
  // 其他完整域名原样保留；IPv4 与垃圾输入返回 null
  assert.equal(normalizeHostname('vpngate.dnc.ne.jp'), 'vpngate.dnc.ne.jp');
  assert.equal(normalizeHostname('192.168.1.1'), null);
  assert.equal(normalizeHostname('not ok!'), null);
  assert.equal(normalizeHostname(''), null);
});

test('extractRemote returns host and optional port from first remote line', () => {
  assert.deepEqual(extractRemote(ovpn('h.example', 443)), { host: 'h.example', port: 443 });
  const twoRemotes = ovpn('a.example', 443) + '\nremote b.example 1194\n';
  assert.deepEqual(extractRemote(twoRemotes), { host: 'a.example', port: 443 }); // 第一条优先
  assert.deepEqual(extractRemote('client\nremote onlyhost\n'), { host: 'onlyhost', port: null });
  assert.deepEqual(extractRemote('remote h 70000'), { host: 'h', port: null }); // 越界端口按缺失处理
  assert.equal(extractRemote(''), null);
});

test('decodeConfig round-trips base64 utf-8', () => {
  assert.equal(decodeConfig(b64('remote h 992')), 'remote h 992');
  assert.equal(decodeConfig('!!!not-base64!!!'), '');
});

test('parseVpngateCsv keeps bare-alias / other-domain / no-config rows', () => {
  const nodes = parseVpngateCsv(CSV);
  // 全部 10 行数据均应保留：无配置行默认 443 一并输出
  assert.equal(nodes.length, 10);

  assert.deepEqual(
    { host: nodes[0].host, ip: nodes[0].ip, country: nodes[0].country, port: nodes[0].port },
    { host: 'vpn182686651.opengw.net', ip: '160.16.213.210', country: 'JP', port: 443 },
  );
  assert.equal(nodes[1].host, 'vpn999000222.opengw.net');
  assert.equal(nodes[1].port, 5555);

  // 非 opengw 域名保留为自身域名
  assert.equal(nodes[2].host, 'vpngate.dnc.ne.jp');
  assert.equal(nodes[2].country, 'US');

  // 无配置行：HostName 兜底 + 默认端口 443
  assert.deepEqual(
    { host: nodes[3].host, ip: nodes[3].ip, country: nodes[3].country, port: nodes[3].port },
    { host: 'vpn777777777.opengw.net', ip: '9.9.9.9', country: 'CN', port: 443 },
  );

  // remote 行无端口时同样默认 443
  assert.equal(nodes[4].host, 'vpn666666666.opengw.net');
  assert.equal(nodes[4].port, 443);

  // 带引号逗号的行：CountryShort 必须仍正确
  assert.equal(nodes[5].country, 'GB');
  assert.equal(nodes[5].port, 992);

  // 用户反馈的丢失形态：public-vpn-* 与 land-* 等裸短名
  assert.equal(nodes[7].host, 'public-vpn-219.opengw.net');
  assert.equal(nodes[7].ip, '133.11.226.163');
  assert.equal(nodes[8].host, 'land-th.opengw.net');
  assert.equal(nodes[8].port, 995);

  // remote 行权威：别名行取到真实 FQDN 与端口
  assert.equal(nodes[9].host, 'vpn123123123.opengw.net');
  assert.equal(nodes[9].port, 1194);
});

test('buildUri exact format', () => {
  const [n] = parseVpngateCsv(CSV);
  assert.equal(buildUri(n), 'sstp://vpn:vpn@vpn182686651.opengw.net:443#JP-160.16.213.210');
});

test('applyFilters country/limit/sort', () => {
  const nodes = parseVpngateCsv(CSV);
  // JP 有两行（完整 FQDN + public-vpn-219），KR 一行
  assert.equal(applyFilters(nodes, { country: 'jp,kr' }).length, 3);
  assert.equal(applyFilters(nodes, { limit: 2 }).length, 2);
  const bySpeed = applyFilters(nodes, { sort: 'speed' });
  assert.ok(bySpeed[0].speed >= bySpeed[bySpeed.length - 1].speed);
  assert.deepEqual(applyFilters(nodes, {}), nodes);
});
