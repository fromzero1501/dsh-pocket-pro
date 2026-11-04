/**
 * dsh-pocket — 隧道管理。
 *
 * 目标只有一个：把本机的移动端端口映射成一个公网 HTTPS 地址。这里不绑定
 * 任何云厂商，按可用性依次尝试几条常见路径：
 *
 *   cloudflared   `cloudflared tunnel --url …`（Quick Tunnel，无需账号）
 *   localtunnel   `lt --port …`（npm 包，无需账号）
 *   localhost.run `ssh -R 80:127.0.0.1:PORT nokey@localhost.run`
 *   custom        用户自定义命令，输出里出现第一个 https URL 即视为就绪
 *
 * 所有子进程都是本插件自己拉起、自己回收；不依赖 DSH 的 subprocess 服务，
 * 因为隧道进程需要在整个 Host 生命周期里常驻，而不是随某一次工具调用结束。
 *
 * @module dsh-pocket/tunnel
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync,
  truncateSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { cpolarConfigPath, installedCpolar } from './cpolar-install.js';
import { stateDir } from './state.js';

const require = createRequire(import.meta.url);

/** 缓存平台自带二进制路径的解析结果。 */
let bundledCloudflaredPath;

/**
 * 找不到系统 cloudflared 时，使用随插件安装的 Windows x64 预编译二进制。
 * 该包只在 win32-x64 上作为可选依赖安装，其他平台返回 undefined。
 * @returns {string | undefined}
 */
function bundledCloudflared() {
  if (platform() !== 'win32' || process.arch !== 'x64') return undefined;
  if (bundledCloudflaredPath !== undefined) return bundledCloudflaredPath;
  try {
    const resolved = require.resolve('agentroam-cloudflared-win32-x64/archive');
    bundledCloudflaredPath = existsSync(resolved) ? resolved : undefined;
  } catch {
    bundledCloudflaredPath = undefined;
  }
  return bundledCloudflaredPath;
}

/** cpolar 可执行文件的探测缓存：`undefined` 未探测、`null` 已确认不存在。 */
let cpolarPathCache;

/** cpolar 配置文件的探测缓存，语义同上。 */
let cpolarConfigCache;

/**
 * 找 cpolar 可执行文件。优先用插件自己按需装的组件（面板下载的那份），
 * 其次才是官方安装器放进 `~/.cpolar` 的、系统包管理器的和 PATH 上的。
 * @returns {string | undefined}
 */
export function resolveCpolarPath() {
  if (cpolarPathCache !== undefined) return cpolarPathCache ?? undefined;
  const binary = platform() === 'win32' ? 'cpolar.exe' : 'cpolar';
  const candidates = [];
  const managed = installedCpolar();
  if (managed !== undefined) candidates.push(managed.path);
  candidates.push(join(homedir(), '.cpolar', binary));
  const programFiles = process.env.ProgramFiles;
  if (platform() === 'win32' && programFiles !== undefined && programFiles.length > 0) {
    candidates.push(join(programFiles, 'cpolar', binary));
  }
  if (platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData !== undefined && localAppData.length > 0) {
      candidates.push(join(localAppData, 'cpolar', binary));
    }
  }
  cpolarPathCache = candidates.find((candidate) => existsSync(candidate)) ?? null;
  return cpolarPathCache ?? undefined;
}

/**
 * 找 cpolar 配置文件。`cpolar.yml` 里存 authtoken，没有它建链阶段会被服务端拒绝。
 * 面板写入的那份排在前面，用户填完令牌就能直接生效，不必再改插件配置。
 * @returns {string | undefined}
 */
export function resolveCpolarConfig() {
  if (cpolarConfigCache !== undefined) return cpolarConfigCache ?? undefined;
  const managed = cpolarConfigPath();
  if (existsSync(managed)) {
    cpolarConfigCache = managed;
    return managed;
  }
  const candidate = join(homedir(), '.cpolar', 'cpolar.yml');
  cpolarConfigCache = existsSync(candidate) ? candidate : null;
  return cpolarConfigCache ?? undefined;
}

/**
 * 装完组件或写完令牌后，让下一次探测重新找。
 * @returns {void}
 */
export function resetCpolarProbe() {
  cpolarPathCache = undefined;
  cpolarConfigCache = undefined;
}

/**
 * 外出模式的运行记录。它和 `state.json` 分开：`state.json` 记的是用户选择
 * （要不要外出模式），这里记的是上一次真的起了什么进程、拿到了什么地址，
 * 下次启动靠它把还活着的隧道接回来，而不是重新起一个换掉地址。
 */
export function roamRecordPath() {
  return join(stateDir(), 'roam.json');
}

/**
 * 读上一次留下的运行记录。文件不存在或内容损坏一律当作没有。
 * @returns {{ pid?: number, port?: number, url?: string, startedAt?: number } | undefined}
 */
export function readRoamRecord() {
  try {
    const parsed = JSON.parse(readFileSync(roamRecordPath(), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      port: typeof parsed.port === 'number' ? parsed.port : undefined,
      url: typeof parsed.url === 'string' ? parsed.url : undefined,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * 写入运行记录（先写临时文件再改名，避免半截 JSON）。
 * @param {{ pid: number, port: number, url: string, startedAt: number }} record
 * @returns {void}
 */
function writeRoamRecord(record) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    const target = roamRecordPath();
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, target);
  } catch {
    /* 记录写不下去不该拖死隧道本身 */
  }
}

/** 删掉运行记录。 */
export function clearRoamRecord() {
  try {
    writeFileSync(roamRecordPath(), '{}', { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* ignore */
  }
}

/**
 * 进程还在不在。`process.kill(pid, 0)` 不真发信号，只做存在性检查；
 * EPERM 说明进程存在但属于别的用户，同样算活着。
 * @param {number | undefined} pid
 * @returns {boolean}
 */
function processAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 静静地结束一个进程（可能已经是别人杀过的）。
 * @param {number} pid
 * @returns {void}
 */
function killQuietly(pid) {
  try {
    process.kill(pid);
  } catch {
    /* 已经退出 */
  }
}

/**
 * 实拉一次，确认公网地址真的有人应答。这是外出模式最关键的一道校验：
 * 日志里写着地址不代表隧道还活着（Quick Tunnel 就是进程健在、DNS 早没了）。
 * 面板要求令牌，所以 401 同样算「活的」。
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function probeUrl(url) {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
      headers: { accept: 'text/html' },
    });
    return response.status === 200 || response.status === 401 || response.status === 302;
  } catch {
    return false;
  }
}

/** 外出模式的日志文件：进程的输出全写这里，父进程退出也不会写断管道。 */
function roamLogPath() {
  return join(stateDir(), 'cpolar-roam.log');
}

/**
 * 读日志尾部若干字节。cpolar 拿地址是异步的，外出模式下没法用管道读，
 * 只能定期 tail 这个文件。
 * @param {string} path
 * @param {number} limit
 * @returns {string}
 */
function readLogTail(path, limit) {
  let fd;
  try {
    const size = statSync(path).size;
    if (size === 0) return '';
    const length = Math.min(size, limit);
    const buffer = Buffer.allocUnsafe(length);
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 把日志压回上限以内，长期开着不能让文件无限涨。
 * @param {string} path
 * @returns {void}
 */
function trimLog(path) {
  try {
    if (!existsSync(path)) return;
    if (statSync(path).size <= ROAM_LOG_MAX_BYTES) return;
    const tail = readLogTail(path, ROAM_LOG_MAX_BYTES / 2);
    writeFileSync(path, tail, { encoding: 'utf8' });
  } catch {
    /* ignore */
  }
}

/**
 * cpolar 下发的是 `http://xxx.cpolar.top`，但隧道同时监听 443，
 * 把地址升级成 https 才不会让访问令牌明文过网。
 * @param {string} url
 * @returns {string}
 */
function preferHttps(url) {
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
}

/** 免费隧道服务真正给出的公网域名；先按白名单匹配，避免把帮助文档里的链接当成隧道地址。 */
const KNOWN_TUNNEL_URL = /https?:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.(?:trycloudflare\.com|loca\.lt|lhr\.life|localhost\.run|serveo\.net|ngrok\.io|ngrok-free\.app|ngrok-free\.dev|devtunnels\.ms|cpolar\.top|cpolar\.cn|cpolar\.io)(?::\d+)?\/?[^\s"'<>\\]*/u;

/** 自定义命令可能输出任意域名；只排除常见文档站。 */
const GENERIC_URL = /https?:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+(?::\d+)?\/?[^\s"'<>\\]*/gu;

/** 不可能是隧道入口的域名。 */
const NOT_TUNNEL = /(?:^|\.)(?:cloudflare\.com|github\.com|npmjs\.com|cloudflare\.dev)$/iu;

/** 允许的隧道模式。 */
export const TUNNEL_MODES = ['auto', 'cloudflared', 'cpolar', 'localtunnel', 'localhost.run', 'ssh', 'custom', 'off'];

/** 自动模式下尝试顺序。cpolar 排在最后：它需要账号令牌，启动也比 cloudflared 慢，只作为兜底。 */
const AUTO_ORDER = ['cloudflared', 'localtunnel', 'localhost.run', 'cpolar'];

/** 单个隧道程序等待公网地址的上限。 */
const READY_TIMEOUT_MS = 30_000;

/** 外出模式下轮询日志找地址的间隔。 */
const ROAM_POLL_INTERVAL_MS = 400;

/** 外出模式等待地址的上限。比普通模式宽松：冷启动要重新握手 + 分配子域名。 */
const ROAM_READY_TIMEOUT_MS = 60_000;

/** 外出模式日志文件的上限，超了截掉前半段。 */
const ROAM_LOG_MAX_BYTES = 512 * 1024;

/**
 * sshd 拒绝反向转发时的报错：服务器上 `127.0.0.1:sshRemotePort` 已被占用。
 * 最常见的原因是上一条 SSH 会话还没被服务端回收（本机崩溃 / 休眠 / 切换网络后
 * 服务端察觉不到半开连接），sshd 会一直占着那个监听端口。
 */
const SSH_FORWARD_CONFLICT = /remote port forwarding failed|address already in use|cannot listen to (?:remote )?port/iu;

/** 端口被占用时，换用这个区间里随机的回环端口继续尝试。 */
const FALLBACK_REMOTE_PORT_MIN = 20_000;
const FALLBACK_REMOTE_PORT_MAX = 60_000;

/**
 * 判断一次失败是否属于“远程转发端口被占用”。
 * @param {unknown} error
 * @returns {boolean}
 */
function isForwardConflict(error) {
  return SSH_FORWARD_CONFLICT.test(error instanceof Error ? error.message : String(error));
}

/**
 * 挑一个还没试过的随机回环端口，避免再次撞上旧会话。
 * @param {Set<number>} taken
 * @returns {number}
 */
function randomRemotePort(taken) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const port = FALLBACK_REMOTE_PORT_MIN
      + Math.floor(Math.random() * (FALLBACK_REMOTE_PORT_MAX - FALLBACK_REMOTE_PORT_MIN));
    if (!taken.has(port)) return port;
  }
  return FALLBACK_REMOTE_PORT_MIN + (taken.size % (FALLBACK_REMOTE_PORT_MAX - FALLBACK_REMOTE_PORT_MIN));
}

/** 保留多少行输出用于面板排错。 */
const LOG_TAIL_LINES = 6;

/**
 * 给 shell 包装一个参数（Windows cmd 与 POSIX 都只需要处理双引号）。
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  if (!/[\s"&|<>^]/u.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * 在 PATH 里解析命令，尽量拿到可直接执行的绝对路径。
 * Windows 上跳过 `.ps1`（cmd.exe 不能直接执行 PowerShell 脚本）。
 * @param {string} command
 * @returns {string | undefined}
 */
export function resolveCommand(command) {
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : undefined;
  }
  const isWindows = platform() === 'win32';
  try {
    const result = isWindows
      ? spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
      : spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    const candidates = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => {
        if (line.length === 0) return false;
        const lower = line.toLowerCase();
        if (lower.endsWith('.ps1')) return false;
        // Windows 的 `where` 会先列出无扩展名的 shell 脚本；它们不能直接被
        // node 的 spawn 执行，必须让 cmd.exe 代跑，所以优先挑选可执行包装。
        if (isWindows) return /\.(exe|cmd|bat|com)$/u.test(lower);
        return true;
      })
      .sort((left, right) => {
        const rank = (value) => (/\.exe$/iu.test(value) ? 0 : /\.(cmd|bat)$/iu.test(value) ? 1 : 2);
        return rank(left) - rank(right);
      });
    return candidates[0];
  } catch {
    return undefined;
  }
}

/**
 * 等待若干毫秒；用于端口释放的短暂竞态。
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 从一段输出中找第一个公网 URL。
 * @param {string} text
 * @param {string} [provider]
 * @returns {string | undefined}
 */
export function extractUrl(text, provider) {
  const known = KNOWN_TUNNEL_URL.exec(text);
  if (known !== null) {
    const url = known[0].replace(/[.,;:]+$/u, '');
    return provider === 'cpolar' ? preferHttps(url) : url;
  }
  if (provider !== 'custom' && provider !== 'cpolar') return undefined;
  GENERIC_URL.lastIndex = 0;
  let match;
  while ((match = GENERIC_URL.exec(text)) !== null) {
    const url = match[0].replace(/[.,;:]+$/u, '');
    try {
      if (!NOT_TUNNEL.test(new URL(url).hostname)) {
        return provider === 'cpolar' ? preferHttps(url) : url;
      }
    } catch {
      /* 忽略畸形 URL */
    }
  }
  return undefined;
}

/**
 * 把 IPv6 主机名放进 URL 的方括号里。
 * @param {string} host
 * @returns {string}
 */
function urlHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * 展开 SSH 私钥路径里的 `~`；spawn 不会做 shell 展开。
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function expandHome(value) {
  if (value === undefined || value.length === 0) return undefined;
  return value.replace(/^~(?=$|[\\/])/u, homedir());
}

/**
 * 自有服务器模式：本地通过 SSH 反向端口转发到服务器 127.0.0.1，
 * 再由服务器上的一个小 Node TCP 代理监听公网端口，转发到该回环端口。
 * 这样不要求服务器开启 GatewayPorts，也不用改 sshd 配置。
 * @param {number} remotePort
 * @param {number} exposePort
 * @param {string} exposeHost
 * @returns {string}
 */
function sshRelayCommand(remotePort, exposePort, exposeHost) {
  const script = [
    "const net=require('net');",
    `const server=net.createServer((s)=>{const t=net.connect(${remotePort},'127.0.0.1');s.pipe(t).pipe(s);s.on('error',()=>t.destroy());t.on('error',()=>s.destroy());});`,
    `server.listen(${exposePort},'${exposeHost}',()=>console.log('POCKET_RELAY_READY'));`,
    "process.on('SIGHUP',()=>process.exit(0));",
    "process.on('SIGTERM',()=>process.exit(0));",
    "process.stdin.resume();",
    "process.stdin.on('end',()=>process.exit(0));",
    "process.stdin.on('close',()=>process.exit(0));",
  ].join('');
  return `node -e "${script}"`;
}

/**
 * 每个提供方的启动参数。
 * @param {string} provider
 * @param {number} port
 * @param {{
 *   cloudflaredPath?: string,
 *   cpolarPath?: string,
 *   cpolarConfig?: string,
 *   cpolarRegion?: string,
 *   customCommand?: string,
 *   sshHost?: string,
 *   sshUser?: string,
 *   sshPort?: number,
 *   sshKeyPath?: string,
 *   sshRemotePort?: number,
 *   sshExposePort?: number,
 *   sshExposeHost?: string,
 *   sshPublicUrl?: string,
 * }} options
 * @returns {{ command: string, args: string[], shell: boolean, url?: string, readyMarker?: string, keepStdin?: boolean } | undefined}
 */
function commandFor(provider, port, options) {
  switch (provider) {
    case 'cloudflared': {
      const command = options.cloudflaredPath?.trim() || bundledCloudflared() || 'cloudflared';
      return {
        command,
        args: ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
        shell: false,
      };
    }
    case 'cpolar': {
      // cpolar 必须在命令行上显式指定配置文件，否则读不到 authtoken，
      // 会在建链阶段被服务端直接拒绝（而不是给出可读的错误）。
      const command = options.cpolarPath?.trim() || resolveCpolarPath() || 'cpolar';
      const configPath = options.cpolarConfig?.trim() || resolveCpolarConfig();
      const args = ['http', String(port), '-log=stdout'];
      if (configPath !== undefined) args.push(`-config=${configPath}`);
      const region = options.cpolarRegion?.trim();
      if (region !== undefined) args.push(`-region=${region}`);
      return { command, args, shell: false };
    }
    case 'localtunnel':
      return { command: 'lt', args: ['--port', String(port)], shell: false };
    case 'localhost.run':
      return {
        command: 'ssh',
        args: [
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ServerAliveInterval=30',
          '-o', 'ExitOnForwardFailure=yes',
          '-R', `80:127.0.0.1:${port}`,
          'nokey@localhost.run',
        ],
        shell: false,
      };
    case 'ssh': {
      const host = options.sshHost?.trim();
      if (host === undefined || host.length === 0) throw new Error('缺少 sshHost');
      const remotePort = options.sshRemotePort ?? 8790;
      const exposePort = options.sshExposePort ?? 80;
      const exposeHost = options.sshExposeHost?.trim() || '0.0.0.0';
      const sshPort = options.sshPort ?? 22;
      const user = options.sshUser?.trim();
      const target = user !== undefined && user.length > 0 && !host.includes('@') ? `${user}@${host}` : host;
      const key = expandHome(options.sshKeyPath?.trim());
      const args = [
        '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-p', String(sshPort),
        '-R', `127.0.0.1:${remotePort}:127.0.0.1:${port}`,
      ];
      if (key !== undefined) args.push('-i', key, '-o', 'IdentitiesOnly=yes');
      args.push(target, sshRelayCommand(remotePort, exposePort, exposeHost));
      const configured = options.sshPublicUrl?.trim();
      const authority = exposePort === 80 ? urlHost(host) : `${urlHost(host)}:${exposePort}`;
      const url = configured !== undefined && configured.length > 0
        ? configured.replace(/\/+$/u, '')
        : `http://${authority}`;
      return {
        command: 'ssh',
        args,
        shell: false,
        url,
        readyMarker: 'POCKET_RELAY_READY',
        keepStdin: true,
      };
    }
    case 'custom': {
      const template = options.customCommand?.trim();
      if (template === undefined || template.length === 0) return undefined;
      const line = template
        .replaceAll('%PORT%', String(port))
        .replaceAll('{port}', String(port));
      return { command: line, args: [], shell: true };
    }
    default:
      return undefined;
  }
}

/**
 * 一个可启停的隧道。同一时刻最多一条。
 */
export class TunnelManager {
  /**
   * @param {{
   *   port: number,
   *   mode: string,
   *   cloudflaredPath?: string,
   *   cpolarPath?: string,
   *   cpolarConfig?: string,
   *   cpolarRegion?: string,
   *   customCommand?: string,
   *   publicUrl?: string,
   *   sshHost?: string,
   *   sshUser?: string,
   *   sshPort?: number,
   *   sshKeyPath?: string,
   *   sshRemotePort?: number,
   *   sshExposePort?: number,
   *   sshExposeHost?: string,
   *   sshPublicUrl?: string,
   *   onStatus?: (status: object) => void,
   *   log?: (message: string) => void,
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.child = undefined;
    this.generation = 0;
    this.logTail = [];
    /** 外出模式下托管（拉起或接管）的 cpolar 进程号；普通模式恒为 undefined。 */
    this.roamPid = undefined;
    /** 该进程是否是从上一轮运行记录里接管来的（不是本进程拉起的）。 */
    this.roamAdopted = false;
    this.status = {
      state: 'off',
      provider: undefined,
      url: undefined,
      error: undefined,
      startedAt: undefined,
    };
  }

  /** 当前状态快照。 */
  snapshot() {
    return {
      ...this.status,
      log: [...this.logTail],
      mode: this.options.mode,
      sshHost: this.options.sshHost,
      roam: this.options.roam === true,
      roamPid: this.roamPid,
      roamAdopted: this.roamAdopted,
    };
  }

  /**
   * 更新状态并通知观察者。
   * @param {Partial<typeof this.status>} patch
   */
  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    try {
      this.options.onStatus?.(this.snapshot());
    } catch {
      /* 观察者异常不能影响隧道本身 */
    }
  }

  /**
   * 追加一行输出到环形日志。
   * @param {string} line
   */
  pushLog(line) {
    const clean = line.replace(/\u001b\[[0-9;]*m/gu, '').trimEnd();
    if (clean.length === 0) return;
    this.logTail.push(clean.length > 300 ? `${clean.slice(0, 300)}…` : clean);
    if (this.logTail.length > LOG_TAIL_LINES) this.logTail.shift();
  }

  /**
   * 停止当前隧道。
   * @param {{ keepChild?: boolean }} [options] `keepChild` 为真时只解除托管、
   *   不结束外出模式拉起的 cpolar 进程——DSH 退出时用它，隧道要活到下次启动。
   *   普通模式（含 cloudflared / ssh / auto）不受它影响，照旧回收子进程。
   */
  stop(options = {}) {
    this.generation += 1;
    const roamOwned = this.roamPid !== undefined;
    // 只有「外出模式托管的进程」才有资格被放过；其他子进程必须照常回收。
    const keepChild = options.keepChild === true && roamOwned;
    const child = this.child;
    const roamPid = this.roamPid;
    this.child = undefined;
    this.childKeepsStdin = false;
    this.roamPid = undefined;
    this.roamAdopted = false;

    if (!keepChild && child !== undefined && child.exitCode === null && !child.killed) {
      const keepStdin = this.childKeepsStdin === true;
      try {
        if (keepStdin && child.stdin !== null && child.stdin.writable) {
          // 关掉远端 relay 的标准输入让它先自行退出，sshd 会立刻释放反向转发端口。
          // 残留的半开连接正是下次启动报“remote port forwarding failed”的根源。
          child.stdin.end();
          const timer = setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* 进程可能已经退出 */
            }
          }, 500);
          timer.unref?.();
        } else {
          child.kill();
        }
      } catch {
        /* 进程可能已经退出 */
      }
    }

    if (!keepChild && roamOwned) {
      // 接管来的进程没有 this.child，只能按记下的 PID 结束。
      if (processAlive(roamPid)) killQuietly(roamPid);
      clearRoamRecord();
    }

    this.logTail = [];
    this.setStatus({
      state: 'off',
      provider: undefined,
      url: undefined,
      error: undefined,
      startedAt: undefined,
    });
  }

  /**
   * 启动隧道。`auto` 会依次尝试直到拿到地址。
   * @returns {Promise<object>} 最终状态快照
   */
  async start() {
    this.stop();
    const generation = this.generation;
    const mode = this.options.mode;

    if (mode === 'off') {
      this.setStatus({ state: 'off', error: undefined });
      return this.snapshot();
    }

    const manual = this.options.publicUrl?.trim();
    if (manual !== undefined && manual.length > 0) {
      this.setStatus({
        state: 'online',
        provider: 'manual',
        url: manual.replace(/\/+$/u, ''),
        error: undefined,
        startedAt: Date.now(),
      });
      return this.snapshot();
    }

    const sshHost = this.options.sshHost?.trim();
    const candidates = mode === 'auto'
      ? (sshHost !== undefined && sshHost.length > 0
          ? ['cloudflared', 'ssh', 'localtunnel', 'localhost.run']
          : [...AUTO_ORDER])
      : [mode];
    const failures = [];
    for (const provider of candidates) {
      if (generation !== this.generation) return this.snapshot();
      try {
        const url = provider === 'ssh'
          ? await this.#attemptSsh(generation)
          : provider === 'cpolar' && this.options.roam === true
            ? await this.#attemptRoam(generation)
            : await this.#attempt(provider, generation);
        if (url !== undefined) return this.snapshot();
      } catch (error) {
        failures.push(`${provider}: ${String(error?.message ?? error)}`);
        this.pushLog(`[${provider}] ${String(error?.message ?? error)}`);
      }
    }

    if (generation === this.generation) {
      const error = failures.length > 0 ? failures.join('；') : '没有可用的隧道程序';
      this.setStatus({ state: 'error', provider: undefined, url: undefined, error });
    }
    return this.snapshot();
  }

  /**
   * 外出模式：先尝试接管上一次留下、还活着的 cpolar 实例，接管不了才新建。
   *
   * 「还活着」要三件事同时成立：记录里的端口等于当前端口、进程还在、
   * 公网地址实拉有应答。少任何一条都得重建——尤其是第三条，进程健在而
   * 地址失效是这类隧道最常见的假在线。
   * @param {number} generation
   * @returns {Promise<string | undefined>}
   */
  async #attemptRoam(generation) {
    const adopted = await this.#adoptRoam();
    if (adopted !== undefined) return adopted;
    if (generation !== this.generation) return undefined;

    const spec = commandFor('cpolar', this.options.port, this.options);
    if (spec === undefined) throw new Error('缺少启动命令');

    let command = spec.command;
    let useShell = spec.shell;
    if (!useShell) {
      const resolved = resolveCommand(command);
      if (resolved === undefined) throw new Error(`未找到 ${command}`);
      command = resolved;
      useShell = /\.(cmd|bat)$/iu.test(command);
    }
    const line = useShell && !spec.shell
      ? [quote(command), ...spec.args.map(quote)].join(' ')
      : command;

    mkdirSync(stateDir(), { recursive: true });
    const logPath = roamLogPath();
    trimLog(logPath);
    this.setStatus({ state: 'starting', provider: 'cpolar', url: undefined, error: undefined });

    // 输出必须落到文件：走管道的话 DSH 一退出管道就断，cpolar 再写一行日志
    // 就会吃 EPIPE 自行了断——那样「脱离父进程」等于白做。
    const fd = openSync(logPath, 'a');
    let child;
    try {
      child = spawn(useShell ? line : command, useShell ? [] : spec.args, {
        shell: useShell,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env: process.env,
        detached: true,
      });
    } finally {
      closeSync(fd);
    }

    // detached 之后还要 unref，否则 DSH 退出会一直等这个子进程。
    child.unref();
    if (child.pid === undefined) throw new Error('cpolar 进程没有拿到 PID');

    this.child = child;
    this.roamPid = child.pid;
    this.roamAdopted = false;

    const url = await this.#waitRoamUrl(generation, child, logPath);
    if (url !== undefined && generation === this.generation) {
      writeRoamRecord({ pid: child.pid, port: this.options.port, url, startedAt: Date.now() });
      this.options.log?.(`pocket: tunnel online (cpolar roam) ${url}`);
    }
    return url;
  }

  /**
   * 尝试把上一轮的 cpolar 接回来。
   * @returns {Promise<string | undefined>}
   */
  async #adoptRoam() {
    const record = readRoamRecord();
    if (record === undefined || record.url === undefined) return undefined;

    // 端口变了说明本机服务换了端口，旧进程转发的是旧端口，接过来也是死地址。
    if (record.port !== this.options.port) {
      if (processAlive(record.pid)) killQuietly(record.pid);
      clearRoamRecord();
      this.pushLog('[cpolar] 监听端口已变更，重建隧道');
      return undefined;
    }

    // 进程没了但记录还在（崩溃、手动结束）：走新建，不能因为文件里有地址就当在线。
    if (!processAlive(record.pid)) {
      clearRoamRecord();
      return undefined;
    }

    this.setStatus({ state: 'starting', provider: 'cpolar', url: undefined, error: undefined });
    const alive = await probeUrl(record.url);
    if (!alive) {
      killQuietly(record.pid);
      clearRoamRecord();
      this.pushLog('[cpolar] 上次的地址已失效，重建隧道');
      return undefined;
    }

    this.roamPid = record.pid;
    this.roamAdopted = true;
    this.child = undefined;
    this.pushLog(`[cpolar] 接管仍在运行的隧道 ${record.url}`);
    this.setStatus({
      state: 'online',
      provider: 'cpolar',
      url: record.url,
      error: undefined,
      startedAt: record.startedAt ?? Date.now(),
    });
    this.options.log?.(`pocket: tunnel adopted (cpolar roam) ${record.url}`);
    return record.url;
  }

  /**
   * 轮询日志文件，等 cpolar 写出公网地址。
   * @param {number} generation
   * @param {import('node:child_process').ChildProcess} child
   * @param {string} logPath
   * @returns {Promise<string | undefined>}
   */
  async #waitRoamUrl(generation, child, logPath) {
    let offset = 0;
    try {
      offset = statSync(logPath).size;
    } catch {
      /* 文件还没建出来，从 0 开始读 */
    }
    const deadline = Date.now() + ROAM_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (generation !== this.generation) return undefined;

      let chunk = '';
      try {
        const size = statSync(logPath).size;
        if (size > offset) {
          const length = Math.min(size - offset, 256 * 1024);
          const buffer = Buffer.allocUnsafe(length);
          const fd = openSync(logPath, 'r');
          try {
            readSync(fd, buffer, 0, length, offset);
          } finally {
            closeSync(fd);
          }
          chunk = buffer.toString('utf8');
          offset += length;
        }
      } catch {
        /* 读不到就下一轮再试 */
      }

      if (chunk.length > 0) {
        for (const raw of chunk.split(/\r?\n/u)) this.pushLog(raw);
        const url = extractUrl(chunk, 'cpolar');
        if (url !== undefined) {
          this.setStatus({
            state: 'online', provider: 'cpolar', url, error: undefined, startedAt: Date.now(),
          });
          return url;
        }
      }

      if (child.exitCode !== null) {
        const tail = this.logTail.slice(-3).join(' / ');
        throw new Error(`cpolar 进程已退出（code=${String(child.exitCode)}）${tail.length > 0 ? `：${tail}` : ''}`);
      }
      await sleep(ROAM_POLL_INTERVAL_MS);
    }

    try {
      if (child.exitCode === null) child.kill();
    } catch {
      /* 可能已经退出 */
    }
    throw new Error(`${ROAM_READY_TIMEOUT_MS / 1000} 秒内没有拿到公网地址`);
  }

  /**
   * SSH 模式启动。服务器上的 `127.0.0.1:sshRemotePort` 经常被上一条 SSH
   * 会话占着（本机崩溃、休眠、换网络后服务端察觉不到半开连接），sshd 会在
   * 转发建立阶段直接报 `remote port forwarding failed for listen port …`。
   * 这里先在原端口上快速重试一次（覆盖“刚断开、端口正在释放”的窗口），
   * 仍冲突就换随机的回环端口——该端口只在服务器回环上使用，不对外暴露。
   * @param {number} generation
   * @returns {Promise<string | undefined>}
   */
  async #attemptSsh(generation) {
    const configured = this.options.sshRemotePort ?? 8790;
    const taken = new Set([configured]);
    const ports = [configured, configured];
    // 最多再换两个随机端口；端口冲突是启动瞬间就返回的，不会叠加 30 秒超时。
    while (ports.length < 4) {
      const next = randomRemotePort(taken);
      taken.add(next);
      ports.push(next);
    }

    let lastError;
    for (let index = 0; index < ports.length; index += 1) {
      if (generation !== this.generation) return undefined;
      const port = ports[index];
      if (index > 0) {
        this.pushLog(port === configured
          ? `[ssh] 127.0.0.1:${port} 被占用，稍等后重试`
          : `[ssh] 127.0.0.1:${configured} 被占用，改用 ${port} 重试`);
      }
      try {
        const url = await this.#attempt('ssh', generation, port);
        if (url !== undefined) return url;
      } catch (error) {
        lastError = error;
        if (!isForwardConflict(error)) throw error;
        // 上一条连接刚结束时端口通常很快释放，先等一会儿再试同一个端口。
        if (index === 0) await sleep(800);
      }
    }

    const reason = String(lastError?.message ?? lastError ?? '未知错误');
    throw new Error(
      `SSH 反向转发端口不可用（${[...new Set(ports)].join('、')} 均被占用），`
      + `服务器上可能还有未释放的旧会话：${reason}`,
    );
  }

  /**
   * 尝试一个提供方，直到拿到 URL、进程退出或超时。
   * @param {string} provider
   * @param {number} generation
   * @param {number} [remotePort] 覆盖本次使用的远程回环端口（仅 ssh 模式）
   * @returns {Promise<string | undefined>}
   */
  #attempt(provider, generation, remotePort) {
    const options = remotePort === undefined ? this.options : { ...this.options, sshRemotePort: remotePort };
    const spec = commandFor(provider, this.options.port, options);
    if (spec === undefined) throw new Error('缺少启动命令');

    let command = spec.command;
    let useShell = spec.shell;
    if (!useShell) {
      const resolved = resolveCommand(command);
      if (resolved === undefined) throw new Error(`未找到 ${command}`);
      command = resolved;
      // .cmd / .bat 包装器需要 cmd.exe 代跑，否则 spawn 会直接 ENOENT。
      useShell = /\.(cmd|bat)$/iu.test(command);
    }

    const line = useShell && !spec.shell
      ? [quote(command), ...spec.args.map(quote)].join(' ')
      : command;
    this.setStatus({ state: 'starting', provider, url: undefined, error: undefined });

    return new Promise((resolve, reject) => {
      let settled = false;
      let output = '';
      let timer;

      const child = spawn(useShell ? line : command, useShell ? [] : spec.args, {
        shell: useShell,
        windowsHide: true,
        stdio: [spec.keepStdin === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: process.env,
        detached: false,
      });
      this.child = child;
      this.childKeepsStdin = spec.keepStdin === true;

      const finish = (error, url) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (url !== undefined) {
          resolve(url);
          return;
        }
        reject(error ?? new Error('隧道进程结束但没有输出地址'));
      };

      const onData = (chunk) => {
        const text = String(chunk);
        output += text;
        if (output.length > 32_000) output = output.slice(-16_000);
        for (const raw of text.split(/\r?\n/u)) this.pushLog(raw);
        const url = spec.readyMarker !== undefined && text.includes(spec.readyMarker)
          ? spec.url
          : extractUrl(text, provider);
        if (url !== undefined && !settled) {
          this.setStatus({
            state: 'online',
            provider,
            url,
            error: undefined,
            startedAt: Date.now(),
            ...(remotePort !== undefined ? { remotePort } : {}),
          });
          this.options.log?.(`pocket: tunnel online (${provider}) ${url}`);
          finish(undefined, url);
        }
      };

      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      child.once('error', (error) => {
        this.pushLog(`[${provider}] ${error.message}`);
        finish(error);
      });

      child.once('exit', (code, signal) => {
        if (this.child === child) {
          this.child = undefined;
          this.childKeepsStdin = false;
        }
        if (!settled) {
          const tail = this.logTail.slice(-3).join(' / ');
          finish(new Error(`进程已退出（code=${String(code)}, signal=${String(signal)}）${tail.length > 0 ? `：${tail}` : ''}`));
          return;
        }
        if (generation === this.generation && this.status.state === 'online') {
          this.setStatus({
            state: 'error',
            error: `隧道进程已退出（code=${String(code)}）`,
            url: undefined,
          });
        }
      });

      timer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(new Error(`${READY_TIMEOUT_MS / 1000} 秒内没有拿到公网地址`));
      }, READY_TIMEOUT_MS);
      timer.unref?.();
    });
  }
}
