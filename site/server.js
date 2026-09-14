#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MarkdownIt = require('markdown-it');
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
md.enable(['table']);

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.NETWORK_PROTOCOL_PORT || 4173);
const MODULES = [
  ['protocol-abstraction', '协议抽象与编码', 'L1–L7', '横向', 'misc', '编码语言 · 贯穿各层'],
  ['ethernet', 'Ethernet', 'L2', '链路层', 'link', '物理边界'],
  ['vlan-bridge', 'VLAN / Bridge', 'L2', '链路层', 'link', ''],
  ['arp-ndp', 'ARP / NDP', 'L2.5', '邻居/边界层', 'neighbor', '链路与网络之间'],
  ['dhcp', 'DHCP', 'L7', '应用层', 'app', '配置网络层'],
  ['ipv4-ipv6', 'IPv4 / IPv6', 'L3', '网络层', 'net', ''],
  ['icmp', 'ICMP', 'L3', '网络层', 'net', '辅助/差错'],
  ['routing', '路由与转发', 'L3', '网络层', 'net', '控制面'],
  ['udp', 'UDP', 'L4', '传输层', 'transport', ''],
  ['tcp', 'TCP', 'L4', '传输层', 'transport', ''],
  ['dns', 'DNS', 'L7', '应用层', 'app', ''],
  ['tls', 'TLS', 'L5–L6', '会话/表示层', 'session', ''],
  ['http1-1', 'HTTP/1.1', 'L7', '应用层', 'app', ''],
  ['http2', 'HTTP/2', 'L7', '应用层', 'app', ''],
  ['quic-http3', 'QUIC / HTTP/3', 'L4+L7', '传输/应用层', 'transport', 'QUIC 自造传输层'],
  ['rpc', 'RPC 与序列化', 'L7', '应用层', 'app', ''],
  ['high-performance', '高性能网络', '—', '横向', 'misc', '数据路径实现'],
  ['rdma', 'RDMA', 'L4/L5', '传输层', 'transport', '旁路内核'],
  ['custom-protocol', '自定义协议设计', 'L7', '应用层', 'app', '']
];
const DOCS = new Map([
  ['home', { title: '总览', file: 'README.md' }],
  ['roadmap', { title: '学习路线', file: 'network-learning-roadmap.md' }],
  ['design', { title: '项目设计', file: 'protocol-learning-design.md' }]
]);
for (const [id, title] of MODULES) {
  for (const [kind, label, file] of [['index', '模块概览', 'README.md'], ['protocol', '协议设计', 'protocol.md'], ['state-machine', '状态机', 'state-machine.md'], ['references', '参考资料', 'references.md'], ['source', '源码导航', 'src/README.md']]) {
    DOCS.set(`${id}/${kind}`, { title: `${title} · ${label}`, file: path.join(id, file), module: id, kind });
  }
  if (id === 'ipv4-ipv6') DOCS.set('interlude', { title: '间章 · NDP 与双栈上网', file: 'interlude-ndp-dualstack.md' });
}

function safeFile(relative) {
  const target = path.resolve(ROOT, relative);
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) throw new Error('invalid path');
  return target;
}
function markdown(source) { return md.render(source); }
function json(res, value) { res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
function serve(res, file, type) { try { const data = fs.readFileSync(file); res.writeHead(200, {'Content-Type': type}); res.end(data); } catch { res.writeHead(404); res.end('Not found'); } }
function sourceFiles(module) {
  const base = safeFile(path.join(module, 'src/upstream')); const files = [];
  function walk(dir) { for (const item of fs.readdirSync(dir, {withFileTypes:true})) { const full = path.join(dir, item.name); if (item.isDirectory()) walk(full); else files.push(path.relative(ROOT, full)); } }
  walk(base); return files.sort();
}
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/docs') return json(res, { docs: [...DOCS.entries()].map(([id, d]) => ({id, ...d})), modules: MODULES.map(([id, title, layer, layerName, tone, layerDetail]) => ({ id, title, layer, layerName, tone, layerDetail })) });
    if (url.pathname === '/api/doc') { const doc = DOCS.get(url.searchParams.get('id')); if (!doc) throw new Error('not found'); const raw = fs.readFileSync(safeFile(doc.file), 'utf8'); return json(res, {...doc, html: markdown(raw), updated: fs.statSync(safeFile(doc.file)).mtimeMs}); }
    if (url.pathname === '/api/source') { const rel = url.searchParams.get('file'); const raw = fs.readFileSync(safeFile(rel), 'utf8'); return json(res, {file: rel, content: raw}); }
    if (url.pathname === '/api/source-files') { const module = url.searchParams.get('module'); if (!MODULES.some(x => x[0] === module)) throw new Error('not found'); return json(res, {files: sourceFiles(module)}); }
    if (url.pathname === '/styles.css') return serve(res, path.join(__dirname, 'styles.css'), 'text/css; charset=utf-8');
    if (url.pathname === '/app.js') return serve(res, path.join(__dirname, 'app.js'), 'text/javascript; charset=utf-8');
    return serve(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
  } catch (e) { res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); res.end('Not found'); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Network Protocol reader: http://127.0.0.1:${PORT}`));
