#!/usr/bin/env node
/*
 * serverpulse - 服务器指标采集 + 监控面板 (零依赖, Node >= 18)
 * 读 /proc 与 /sys，输出 CPU、内存、磁盘、网络流量。
 *
 * 路由（就这四个，刻意保持轻）:
 *   GET  /            监控面板
 *   GET  /api/stats   面板取数用的 JSON 快照（只给当前值，不存历史）
 *   GET  /login       登录页；POST /login 提交口令
 *   GET  /logout      清除本设备会话
 *   GET  /favicon.ico 图标（免登录，供浏览器/扩展抓取）
 *
 * 鉴权: config.token 非空即开启。口令只在 /login 表单提交一次，之后靠
 *   HttpOnly cookie(sp_session) 维持会话（sessionDays 天，默认 5，自动续期，
 *   落盘 sessions.json，重启不掉线；换 token 会让所有旧会话失效）。
 *   URL 里不出现口令。脚本用 Authorization: Bearer <token> 取数。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.MONITOR_CONFIG || path.join(HERE, 'config.json');

const DEFAULTS = {
  port: 8080,
  host: '0.0.0.0',
  token: '',
  intervalMs: 2000,
  label: '',
  netExclude: ['lo', 'docker0', 'br-', 'veth', 'virbr', 'tun', 'tap'],
  mountsExclude: ['/snap/', '/run/', '/dev/', '/proc/', '/sys/', '/boot/efi'],
  corsOrigin: '*',
  sessionDays: 5,
  sessionFile: false,          // 会话是否落盘；默认只在内存里（服务重启需重新登录）
};

function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
  const cfg = Object.assign({}, DEFAULTS, file);
  if (process.env.MONITOR_PORT) cfg.port = Number(process.env.MONITOR_PORT);
  if (process.env.MONITOR_HOST) cfg.host = process.env.MONITOR_HOST;
  if (process.env.MONITOR_TOKEN !== undefined && process.env.MONITOR_TOKEN !== '') cfg.token = process.env.MONITOR_TOKEN;
  if (process.env.MONITOR_INTERVAL) cfg.intervalMs = Number(process.env.MONITOR_INTERVAL);
  if (process.env.MONITOR_LABEL) cfg.label = process.env.MONITOR_LABEL;
  if (process.env.MONITOR_SESSION_DAYS) cfg.sessionDays = Math.max(1, Number(process.env.MONITOR_SESSION_DAYS) || 5);
  if (process.env.MONITOR_SESSION_FILE === '1' || process.env.MONITOR_SESSION_FILE === 'true') cfg.sessionFile = true;
  return cfg;
}

const cfg = loadConfig();

/* ------------------------------ 登录会话 ------------------------------
 * 口令只在登录表单里提交一次；之后靠 HttpOnly cookie 维持会话，
 * URL 里不出现 token。会话落盘，重启服务不会把已登录设备踢下线；
 * 改了 config.token 之后旧会话全部失效（会话绑定了口令指纹）。
 */
const COOKIE = 'sp_session';
const SESSIONS_FILE = path.join(HERE, 'sessions.json');
const sessionFingerprint = () => crypto.createHash('sha256').update(String(cfg.token)).digest('hex').slice(0, 16);
let sessions = {};
const persistSessions = () => cfg.sessionFile === true;   // 默认 false：完全不落盘
if (persistSessions()) {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (raw && raw.fingerprint === sessionFingerprint() && raw.sessions) sessions = raw.sessions;
  } catch (e) {}
}
let saveTimer = null;
function saveSessions() {
  if (!persistSessions()) return;              // 不落盘：会话只在内存里
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ fingerprint: sessionFingerprint(), sessions: sessions })); } catch (e) {}
}
function saveSoon() {
  if (!persistSessions() || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveSessions(); }, 1500);
}
function pruneSessions() {
  const now = Date.now();
  let n = 0;
  for (const k of Object.keys(sessions)) { if (!sessions[k] || sessions[k].exp < now) { delete sessions[k]; n++; } }
  if (n) saveSoon();
}
function createSession() {
  pruneSessions();
  const id = crypto.randomBytes(24).toString('hex');
  sessions[id] = { exp: Date.now() + Math.max(1, cfg.sessionDays) * 86400000 };
  saveSessions();
  return id;
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// 返回 true = 已登录（顺带滑动续期）
function sessionValid(req, res) {
  if (cfg.token) {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (bearer && bearer === cfg.token) return true;              // 脚本用 Authorization 头，不碰 cookie
  }
  const id = parseCookies(req)[COOKIE];
  if (!id || !sessions[id]) return false;
  const s = sessions[id];
  if (s.exp < Date.now()) { delete sessions[id]; saveSoon(); return false; }
  const fresh = Date.now() + Math.max(1, cfg.sessionDays) * 86400000;
  if (s.exp < fresh - 3600000) { s.exp = fresh; saveSoon(); res.setHeader('Set-Cookie', cookieFor(id, req)); }
  return true;
}
function cookieFor(id, req, maxAgeSec) {
  const secure = (req.headers['x-forwarded-proto'] || '') === 'https';
  const parts = [COOKIE + '=' + id, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=' + Math.max(1, Math.round(maxAgeSec === 0 ? 0 : maxAgeSec !== undefined ? maxAgeSec : cfg.sessionDays * 86400))];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
function safeNext(n) {
  const s = String(n || '/').trim();
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\')) return '/';
  const qAt = s.indexOf('?');
  const path = qAt < 0 ? s : s.slice(0, qAt);
  if (path === '/login' || path === '/logout') return '/';
  let out = path;
  if (qAt >= 0) {
    const keep = s.slice(qAt + 1).split('&').filter((kv) => kv && !/^token=/i.test(kv));
    if (keep.length) out += '?' + keep.join('&');
  }
  return out.slice(0, 200) || '/';
}

function toLogin(req, res, next) {
  const q = '/login' + (next && next !== '/' ? '?next=' + encodeURIComponent(next) : '');
  res.writeHead(302, { Location: q, 'Cache-Control': 'no-store' });
  res.end();
}

/* ------------------------------ /proc 读取 ------------------------------ */

function readFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }

// /proc/stat -> { total, idle, cores: [{total,idle}] }
function readCpuStat() {
  const txt = readFile('/proc/stat');
  if (!txt) return null;
  const out = { total: 0, idle: 0, cores: [] };
  for (const line of txt.split('\n')) {
    if (!/^cpu/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const name = parts[0];
    const n = parts.slice(1).map(Number);
    const user = n[0] || 0, nice = n[1] || 0, system = n[2] || 0, idle = n[3] || 0;
    const iowait = n[4] || 0, irq = n[5] || 0, softirq = n[6] || 0, steal = n[7] || 0;
    const total = user + nice + system + idle + iowait + irq + softirq + steal;
    const idl = idle + iowait;
    const rec = {
      total: total, idle: idl, user: user + nice, system: system + irq + softirq,
      iowait: iowait, steal: steal,
      // guest 时间已包含在 user 内, 单独保留用于调试
    };
    if (name === 'cpu') { out.total = total; out.idle = idl; out.overall = rec; }
    else { rec.name = name; out.cores.push(rec); }
  }
  return out;
}

function readMeminfo() {
  const txt = readFile('/proc/meminfo');
  if (!txt) return null;
  const m = {};
  for (const line of txt.split('\n')) {
    const mm = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (mm) m[mm[1]] = Number(mm[2]) * 1024;
  }
  const total = m.MemTotal || 0;
  const available = (m.MemAvailable !== undefined) ? m.MemAvailable : (m.MemFree || 0);
  const cached = (m.Cached || 0) + (m.SReclaimable || 0) - (m.Shmem || 0);
  const used = Math.max(0, total - available);
  const swapTotal = m.SwapTotal || 0;
  const swapFree = m.SwapFree || 0;
  return {
    total: total, used: used, available: available, free: m.MemFree || 0,
    cached: Math.max(0, cached), buffers: m.Buffers || 0, shared: m.Shmem || 0,
    usage: total ? (used / total) * 100 : 0,
    swapTotal: swapTotal, swapUsed: Math.max(0, swapTotal - swapFree),
    swapUsage: swapTotal ? ((swapTotal - swapFree) / swapTotal) * 100 : 0,
  };
}

function readLoadavg() {
  const t = readFile('/proc/loadavg').trim();
  if (!t) return null;
  const p = t.split(/\s+/);
  const procs = (p[3] || '0/0').split('/');
  return { load1: +p[0], load5: +p[1], load15: +p[2], running: +procs[0] || 0, total: +procs[1] || 0 };
}

// /proc/net/dev -> { ifname: {rxBytes, txBytes, rxPackets, txPackets} }
function readNetDev() {
  const txt = readFile('/proc/net/dev');
  const out = {};
  if (!txt) return out;
  const lines = txt.split('\n').slice(2);
  for (const line of lines) {
    const mm = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!mm) continue;
    const name = mm[1].trim();
    const f = mm[2].trim().split(/\s+/).map(Number);
    out[name] = { rxBytes: f[0] || 0, rxPackets: f[1] || 0, txBytes: f[8] || 0, txPackets: f[9] || 0 };
  }
  return out;
}

// /proc/diskstats -> { dev: {reads, writes, readBytes, writeBytes} } (仅整盘)
function readDiskStats() {
  const txt = readFile('/proc/diskstats');
  const out = {};
  if (!txt) return out;
  for (const line of txt.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const name = f[2];
    if (!/^(vd[a-z]+|sd[a-z]+|hd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$/.test(name)) continue;
    out[name] = {
      reads: Number(f[3]) || 0,
      readBytes: (Number(f[5]) || 0) * 512,
      writes: Number(f[7]) || 0,
      writeBytes: (Number(f[9]) || 0) * 512,
      ioMs: Number(f[12]) || 0,
    };
  }
  return out;
}

function isVirtualFs(t) {
  return /^(proc|sysfs|devtmpfs|tmpfs|cgroup|cgroup2|securityfs|pstore|bpf|autofs|debugfs|tracefs|fusectl|configfs|mqueue|hugetlbfs|ramfs|binfmt_misc|nsfs|overlay|squashfs|devpts|rpc_pipefs|efivarfs|selinuxfs|procfs|squashfs)$/.test(t);
}

// 真实磁盘分区 (来自 /proc/self/mounts + statfs)
function readMounts() {
  const txt = readFile('/proc/self/mounts');
  const seenDev = new Set();
  const seenMp = new Set();
  const list = [];
  for (const line of txt.split('\n')) {
    const f = line.split(/\s+/);
    if (f.length < 3) continue;
    const dev = f[0], mp = f[1], type = f[2];
    if (!/^\/dev\//.test(dev)) continue;
    if (/^\/dev\/loop/.test(dev)) continue;
    if (isVirtualFs(type)) continue;
    if (seenDev.has(dev)) continue;
    if (cfg.mountsExclude.some((p) => mp.startsWith(p) || mp === p)) continue;
    seenDev.add(dev); seenMp.add(mp);
    let total = 0, free = 0, used = 0, usage = 0, files = 0, filesUsed = 0;
    try {
      const s = fs.statfsSync(mp);
      const bs = s.bsize;
      total = bs * s.blocks;
      free = bs * s.bavail;
      used = total - bs * s.bfree;
      usage = total ? (used / total) * 100 : 0;
      files = s.files; filesUsed = s.files - s.ffree;
    } catch (e) { continue; }
    list.push({
      device: dev, mount: mp, fstype: type,
      total: total, used: used, free: free, usage: usage,
      inodes: files, inodesUsed: filesUsed,
    });
  }
  list.sort((a, b) => b.total - a.total);
  return list;
}

function safeReaddir(d) { try { return fs.readdirSync(d); } catch (e) { return []; } }

/* ------------------------------ 进程占用 ------------------------------ */

function readProcCpu() {
  const map = new Map();
  for (const pid of safeReaddir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const st = readFile(path.join('/proc', pid, 'stat'));
    if (!st) continue;
    const close = st.lastIndexOf(')');
    if (close < 0) continue;
    const comm = st.slice(st.indexOf('(') + 1, close);
    const rest = st.slice(close + 2).split(/\s+/);
    const utime = Number(rest[11]) || 0, stime = Number(rest[12]) || 0;
    const rss = (Number(rest[21]) || 0) * 4096;
    map.set(pid, { pid: +pid, name: comm, ticks: utime + stime, rss: rss });
  }
  return map;
}

/* ------------------------------ 采样器 ------------------------------ */

var publicIpCache = '';
let latest = null;
let prev = null;
let procPrev = null;
const HZ = 100;
const startedAt = Date.now();

function ratePerSec(cur, old, key, dtMs) {
  const a = old ? old[key] : 0;
  return dtMs > 0 ? Math.max(0, ((cur[key] - a) / dtMs) * 1000) : 0;
}

function sample() {
  const now = Date.now();
  const cpu = readCpuStat();
  const mem = readMeminfo();
  const load = readLoadavg();
  const net = readNetDev();
  const disk = readDiskStats();
  const dt = prev ? now - prev.t : 0;

  let cpuUsage = 0, cores = [], cpuKind = 'host';
  if (cpu) {
    const t = cpu.total, i = cpu.idle;
    if (prev && prev.cpu && t > prev.cpu.total) {
      cpuUsage = 100 * (1 - (i - prev.cpu.idle) / (t - prev.cpu.total));
    } else cpuUsage = prev ? prev.snap.cpu.usage : 0;
    cores = cpu.cores.map((c, idx) => {
      const p = prev && prev.cpu && prev.cpu.cores[idx];
      let u = 0;
      if (p && c.total > p.total) u = 100 * (1 - (c.idle - p.idle) / (c.total - p.total));
      else if (prev && prev.snap.cpu.cores[idx]) u = prev.snap.cpu.cores[idx].usage;
      return { name: 'cpu' + idx, usage: clampPct(u) };
    });
    cpuUsage = clampPct(cpuUsage);
  }

  // 容器 cgroup 视角 (若在容器内则取 cgroup 限额)
  const cg = readCgroup();
  if (cg.inContainer) cpuKind = 'container';

  const nics = [];
  let rxTotal = 0, txTotal = 0;
  for (const [name, v] of Object.entries(net)) {
    if (cfg.netExclude.some((p) => name === p || name.startsWith(p))) continue;
    const p = prev ? prev.net[name] : null;
    const rx = ratePerSec(v, p, 'rxBytes', dt);
    const tx = ratePerSec(v, p, 'txBytes', dt);
    rxTotal += rx; txTotal += tx;
    nics.push({
      name: name, rxRate: rx, txRate: tx,
      rxTotal: v.rxBytes, txTotal: v.txBytes,
      ip: (os.networkInterfaces()[name] || []).filter((a) => a.family === 'IPv4' || a.family === 4).map((a) => a.address),
    });
  }

  const disks = [];
  let readRate = 0, writeRate = 0;
  for (const [name, v] of Object.entries(disk)) {
    const p = prev ? prev.disk[name] : null;
    const rr = ratePerSec(v, p, 'readBytes', dt);
    const wr = ratePerSec(v, p, 'writeBytes', dt);
    readRate += rr; writeRate += wr;
    disks.push({
      device: name, readRate: rr, writeRate: wr,
      readTotal: v.readBytes, writeTotal: v.writeBytes,
      iops: p ? ratePerSec(v, p, 'reads', dt) + ratePerSec(v, p, 'writes', dt) : 0,
    });
  }

  const mounts = readMounts();

  // top 进程
  const procNow = readProcCpu();
  let procs = [];
  if (procPrev && dt > 0) {
    for (const [pid, cur] of procNow) {
      const old = procPrev.get(pid);
      if (!old) continue;
      const d = cur.ticks - old.ticks;
      if (d <= 0) continue;
      procs.push({ pid: pid, name: cur.name, cpu: (d / (dt / 10)) * 100 / HZ, mem: mem.total ? (cur.rss / mem.total) * 100 : 0 });
    }
    procs.sort((a, b) => b.cpu - a.cpu);
    procs = procs.slice(0, 6);
  }
  procPrev = procNow;

  const snap = {
    ts: now,
    kind: cpuKind,
    system: {
      label: cfg.label || os.hostname(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      kernel: os.release(),
      distro: readDistro(),
      uptime: Math.round(os.uptime()),
      serverUptime: Math.round((now - startedAt) / 1000),
      cpuModel: (os.cpus()[0] || {}).model || 'unknown',
      cpuCores: os.cpus().length,
      cpuCoresEffective: cg.cpuLimit || os.cpus().length,
      ipPrivate: Object.values(os.networkInterfaces()).flat().filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal).map((a) => a.address).join(','),
      port: cfg.port,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    cpu: {
      usage: cpuUsage, cores: cores,
      user: cpu ? clampPct(prev && prev.cpu ? 100 * ((cpu.overall.user - prev.cpu.overall.user) / Math.max(1, cpu.overall.total - prev.cpu.overall.total)) : (prev ? prev.snap.cpu.user : 0)) : 0,
      system: cpu ? clampPct(prev && prev.cpu ? 100 * ((cpu.overall.system - prev.cpu.overall.system) / Math.max(1, cpu.overall.total - prev.cpu.overall.total)) : (prev ? prev.snap.cpu.system : 0)) : 0,
      iowait: cpu ? clampPct(prev && prev.cpu ? 100 * ((cpu.overall.iowait - prev.cpu.overall.iowait) / Math.max(1, cpu.overall.total - prev.cpu.overall.total)) : (prev ? prev.snap.cpu.iowait : 0)) : 0,
      steal: cpu ? clampPct(prev && prev.cpu ? 100 * ((cpu.overall.steal - prev.cpu.overall.steal) / Math.max(1, cpu.overall.total - prev.cpu.overall.total)) : (prev ? prev.snap.cpu.steal : 0)) : 0,
      load1: load ? load.load1 : 0, load5: load ? load.load5 : 0, load15: load ? load.load15 : 0,
      processes: load ? load.total : 0, running: load ? load.running : 0,
      top: procs,
    },
    memory: mem ? Object.assign({}, mem, { usage: clampPct(mem.usage), swapUsage: clampPct(mem.swapUsage) }) : null,
    disk: {
      readRate: readRate, writeRate: writeRate,
      devices: disks, mounts: mounts,
      usage: mounts.length ? Math.max.apply(null, mounts.map((m) => m.usage)) : 0,
    },
    network: {
      rxRate: rxTotal, txRate: txTotal,
      rxTotal: nics.reduce((s, n) => s + n.rxTotal, 0),
      txTotal: nics.reduce((s, n) => s + n.txTotal, 0),
      interfaces: nics,
      primary: (nics.find((n) => n.name === 'eth0') || nics[0] || {}).name || '-',
      publicIp: (latest && latest.network.publicIp) || publicIpCache,
    },
  };

  if (cg.inContainer) {
    snap.container = cg;
    snap.cpu.cgroupUsage = cg.cpuUsage;
    snap.memory.cgroupLimit = cg.memLimit;
    snap.memory.cgroupUsagePct = cg.memPct;
  }

  latest = snap;
  prev = { t: now, cpu: cpu, net: net, disk: disk, snap: snap };
}

function readCgroup() {
  const out = { inContainer: false, memLimit: null, memUsed: null, memPct: null, cpuLimit: null, cpuUsage: null };
  try {
    if (fs.existsSync('/.dockerenv')) out.inContainer = true;
    const info = readFile('/proc/self/cgroup');
    if (/kubepods|docker|containerd|\.service/.test(info) === false && !out.inContainer) {
      // 宿主机 systemd 也可能有 .service, 只在显式 dockerenv 或 cgroup v2 限额生效时处理
    }
    const max = readFile('/sys/fs/cgroup/memory.max').trim();
    const cur = readFile('/sys/fs/cgroup/memory.current').trim();
    if (max && max !== 'max') { out.memLimit = Number(max); out.inContainer = true; }
    if (cur) out.memUsed = Number(cur);
    if (out.memLimit && out.memUsed) out.memPct = clampPct((out.memUsed / out.memLimit) * 100);
    const cw = readFile('/sys/fs/cgroup/cpu.max').trim().split(/\s+/);
    if (cw.length === 2 && cw[0] !== 'max') out.cpuLimit = Number(cw[0]) / Number(cw[1]);
  } catch (e) {}
  return out;
}

let distroCache = null;
function readDistro() {
  if (distroCache !== null) return distroCache;
  const t = readFile('/etc/os-release');
  const m = t.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  distroCache = m ? m[1] : os.type() + ' ' + os.release();
  return distroCache;
}

function clampPct(v) { if (!isFinite(v)) return 0; return Math.min(100, Math.max(0, v)); }

sample();
setInterval(() => { try { sample(); } catch (e) { console.error('sample error', e); } }, cfg.intervalMs);

/* ------------------------------ 公网 IP ------------------------------ */

const IP_SOURCES = [
  ['https://api.ipify.org', ''],
  ['https://ifconfig.me/ip', ''],
  ['https://ipinfo.io/ip', ''],
];
function fetchPublicIp() {
  const tryOne = (u) => new Promise((resolve) => {
    let done = false;
    const req = https.get(u, { timeout: 5000, headers: { 'User-Agent': 'curl/8.0', Accept: 'text/plain' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return finish(''); }
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => finish(b.trim()));
    });
    req.on('error', () => finish(''));
    req.on('timeout', () => { req.destroy(); finish(''); });
    function finish(v) { if (!done) { done = true; resolve(/^[0-9a-fA-F:.]{4,64}$/.test(v) ? v : ''); } }
  });
  return IP_SOURCES.reduce((p, s2) => p.then((ip) => ip || tryOne(s2[0])), Promise.resolve(''));
}
fetchPublicIp().then((ip) => { if (ip) { publicIpCache = ip; if (latest) latest.network.publicIp = ip; } });
setInterval(() => { fetchPublicIp().then((ip) => { if (ip) { publicIpCache = ip; if (latest) latest.network.publicIp = ip; } }); }, 600000);


/* ------------------------------ HTTP 服务 ------------------------------ */

function send(res, code, body, type, extra) {
  const t = type || 'text/plain; charset=utf-8';
  const headers = Object.assign({
    'Content-Type': /charset=/.test(t) ? t : t + '; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': cfg.corsOrigin,
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'X-Content-Type-Options': 'nosniff',
  }, extra || {});
  res.writeHead(code, headers);
  res.end(body);
}

function sendBuf(res, code, buf, type, extra) {
  if (!buf) return sendJson(res, { error: 'not found' }, 404);
  const h = Object.assign({ 'Content-Type': type }, extra || {});
  res.writeHead(code, h);
  res.end(buf);
}

function sendJson(res, obj, code) { send(res, code || 200, JSON.stringify(obj), 'application/json'); }

function staticFile(name) {
  try { return fs.readFileSync(path.join(HERE, name)); } catch (e) { return null; }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
  const p = u.pathname.replace(/\/+$/, '') || '/';

  const authOk = !cfg.token || sessionValid(req, res);

  // 图标是静态图形，不含任何数据：放在鉴权之前，方便浏览器/扩展自动抓 favicon
  if (p === '/favicon.ico' || p === '/apple-touch-icon.png') {
    return sendBuf(res, 200, staticFile('favicon.ico'), 'image/x-icon', { 'Cache-Control': 'public, max-age=604800' });
  }

  const isPage = p === '/';
  if (!authOk && p !== '/login' && p !== '/logout') {
    if (isPage) return toLogin(req, res, safeNext(u.pathname + (u.search || '')));
    return sendJson(res, { error: 'unauthorized', login: '/login' }, 401);
  }

  if (p === '/login') {
    if (!cfg.token) return toLogin(req, res, safeNext(u.searchParams.get('next')));
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const next = safeNext(form.get('next'));
        const given = String(form.get('token') || '').trim();
        const headers = { 'Cache-Control': 'no-store' };
        if (given && given === cfg.token) {
          headers['Set-Cookie'] = cookieFor(createSession(), req);
          headers['Location'] = next;
        } else {
          headers['Location'] = '/login?err=1' + (next !== '/' ? '&next=' + encodeURIComponent(next) : '');
        }
        res.writeHead(302, headers);
        res.end();
      });
      return;
    }
    const f = staticFile('login.html');
    if (!f) return send(res, 500, 'login.html missing');
    const next = safeNext(u.searchParams.get('next'));
    const html = f.toString('utf8')
      .replace('__ERR__', u.searchParams.get('err') ? '口令不正确，再试一次' : '')
      .replace('__NEXT__', JSON.stringify(next).slice(1, -1))
      .replace('__DAYS__', String(Math.max(1, cfg.sessionDays || 5)));
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  if (p === '/logout') {
    const id = parseCookies(req)[COOKIE];
    if (id) { delete sessions[id]; saveSessions(); }
    res.writeHead(302, { Location: '/login', 'Set-Cookie': cookieFor('-', req, 0), 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (p === '/api/stats') {
    const body = Object.assign({ ok: true, config: { intervalMs: cfg.intervalMs } }, latest || {});
    return sendJson(res, body);
  }

  if (p === '/') {
    const f = staticFile('dashboard.html');
    if (!f) return send(res, 500, 'dashboard.html missing');
    return send(res, 200, f, 'text/html; charset=utf-8');
  }

  return sendJson(res, { error: 'not found', path: p }, 404);
});

server.listen(cfg.port, cfg.host, () => {
  console.log('[serverpulse] 监听 http://' + cfg.host + ':' + cfg.port + '  (采样 ' + cfg.intervalMs + 'ms)');
  if (cfg.token) {
    console.log('[serverpulse] 登录口令 ' + cfg.token + '   改口令：编辑 ' + CONFIG_PATH + ' 里的 token 后重启');
    console.log('[serverpulse] 会话：' + (persistSessions() ? '保持 ' + cfg.sessionDays + ' 天，写 ' + SESSIONS_FILE : '保持 ' + cfg.sessionDays + ' 天，只在内存里（不落盘，重启服务需重新登录）'));
  } else {
    console.log('[serverpulse] 未设置 token，任何人可直接访问（只建议内网）');
  }
});

process.on('SIGTERM', () => { console.log('[serverpulse] SIGTERM'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
