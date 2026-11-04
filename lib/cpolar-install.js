/**
 * dsh-pocket — cpolar 组件的按需安装。
 *
 * cpolar 不在 npm 上，官方只提供整包安装程序；把它打进本插件再分发既不合适
 * （cpolar 是商业软件，上游许可证不覆盖它的二进制），也会让只想用 cloudflared
 * 的人平白多下十几兆。所以这里走「用的时候再装」：用户第一次选 cpolar 时，
 * 从 cpolar 官方地址取安装包，按固定指纹校验，解出可执行文件落到插件自己的
 * 状态目录里。
 *
 * 指纹是硬编码的：下载包与解出来的可执行文件各校验一次 sha256。官方发布
 * 换了包就必然对不上，安装会失败而不是装进一个来路不明的二进制。
 *
 * @module dsh-pocket/cpolar-install
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inflateRawSync } from 'node:zlib';
import { stateDir } from './state.js';

/**
 * 官方发布信息。每一项都在本机实测过：下载包长度、下载包 sha256、
 * 解包后可执行文件的长度与 sha256 全部与官方当前发布一致。
 */
export const CPOLAR_RELEASES = Object.freeze({
  'win32-x64': Object.freeze({
    version: '3.3.18',
    url: 'https://www.cpolar.com/static/downloads/releases/3.3.18/cpolar-stable-windows-amd64-setup.zip',
    archiveBytes: 7_603_505,
    archiveSha256: 'fb8cf60289058ee26079f995d2eeea0b21768a742d90c93015afe96e83428830',
    archiveKind: 'zip-msi',
    msiMember: 'cpolar_amd64.msi',
    executableName: 'cpolar.exe',
    executableBytes: 19_637_680,
    executableSha256: 'b2d865ee505e842d22ceca5493a872efa893a79b079a7a8ee2bd3aa5343a5c41',
  }),
  'linux-x64': Object.freeze({
    version: '3.3.18',
    url: 'https://www.cpolar.com/static/downloads/releases/3.3.18/cpolar-stable-linux-amd64.tar.gz',
    archiveBytes: 7_404_781,
    archiveSha256: '5cd3320c4369928ccb509c4f5fa2ec3b86151ead77e1b77c1694aa64c43e32e7',
    archiveKind: 'tar-gz',
    executableName: 'cpolar',
    executableBytes: 19_328_632,
    executableSha256: 'c076e1109372a3f88031841c5989030e49b6871b54aee3260c796da9122dec05',
  }),
  'linux-arm64': Object.freeze({
    version: '3.3.18',
    url: 'https://www.cpolar.com/static/downloads/releases/3.3.18/cpolar-stable-linux-arm64.tar.gz',
    archiveBytes: 6_855_666,
    archiveSha256: '8a61a97983f18ae5ffb4b8bac4c9b3d8e2399a6ee101844e7b0b30d7f326157c',
    archiveKind: 'tar-gz',
    executableName: 'cpolar',
    executableBytes: 19_017_169,
    executableSha256: '8d76a1b7e518df45f387f107c7a428079c67ecd9b971a2915c53b947ea9b443a',
  }),
});

/** cpolar 账号控制台：拿 authtoken 的地方。 */
export const CPOLAR_TOKEN_URL = 'https://dashboard.cpolar.com/auth';

/**
 * 当前平台可用的官方发布。
 * @returns {typeof CPOLAR_RELEASES[keyof typeof CPOLAR_RELEASES] | undefined}
 */
export function cpolarRelease() {
  return CPOLAR_RELEASES[`${platform()}-${arch()}`];
}

/** 插件自管的组件根目录。 */
export function cpolarComponentsDir() {
  return join(stateDir(), 'components', 'cpolar');
}

/** 插件自管的 cpolar 配置文件；authtoken 填在这里就不用再改插件配置。 */
export function cpolarConfigPath() {
  return join(stateDir(), 'cpolar.yml');
}

/**
 * 比较两个点分版本号。
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareVersions(left, right) {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * 已经装好的 cpolar 可执行文件；有多个版本时取最高的那个。
 * 只认大小完全对得上的文件，避免把解包残留当成可用二进制。
 * @returns {{ version: string, path: string } | undefined}
 */
export function installedCpolar() {
  const release = cpolarRelease();
  if (release === undefined) return undefined;
  const root = cpolarComponentsDir();
  if (!existsSync(root)) return undefined;
  let best;
  for (const version of readdirSyncSafe(root)) {
    const candidate = join(root, version, release.executableName);
    if (!existsSync(candidate)) continue;
    try {
      // 同步 stat：只在状态查询里用，目录最多几项。
      const size = statSyncSafe(candidate);
      if (size !== release.executableBytes) continue;
    } catch {
      continue;
    }
    if (best === undefined || compareVersions(version, best.version) > 0) {
      best = { version, path: candidate };
    }
  }
  return best;
}

/** `readdir` 的同步安全版本，目录不存在时返回空数组。 */
function readdirSyncSafe(path) {
  try {
    // 用 readdirSync 而不是异步版本：调用点都在同步状态查询里。
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** `stat` 的同步安全版本，失败时返回 -1。 */
function statSyncSafe(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/**
 * 组件安装状态，供面板显示。
 * @returns {{
 *   supported: boolean,
 *   installed: boolean,
 *   version: string | undefined,
 *   path: string | undefined,
 *   expectedVersion: string | undefined,
 *   archiveBytes: number | undefined,
 *   downloadUrl: string | undefined,
 *   tokenConfigured: boolean,
 *   configPath: string,
 *   tokenUrl: string,
 * }}
 */
export function cpolarInstallState() {
  const release = cpolarRelease();
  const installed = installedCpolar();
  return {
    supported: release !== undefined,
    installed: installed !== undefined,
    version: installed?.version,
    path: installed?.path,
    expectedVersion: release?.version,
    archiveBytes: release?.archiveBytes,
    downloadUrl: release?.url,
    tokenConfigured: hasCpolarToken(),
    configPath: cpolarConfigPath(),
    tokenUrl: CPOLAR_TOKEN_URL,
  };
}

/**
 * 配置文件里有没有填 authtoken。
 * @returns {boolean}
 */
export function hasCpolarToken() {
  if (!existsSync(cpolarConfigPath())) return false;
  try {
    const text = readFileSyncSafe(cpolarConfigPath());
    const matched = /^\s*authtoken\s*:\s*"?([^"\r\n]+)"?\s*$/mu.exec(text);
    return matched !== null && matched[1].trim().length > 0;
  } catch {
    return false;
  }
}

/** 同步读文本，失败返回空串。 */
function readFileSyncSafe(path) {
  try {
    return readFileSync(path);
  } catch {
    return '';
  }
}

/**
 * 写入 cpolar 配置文件。只保留 cpolar 需要的几项，把它的控制台界面与自动更新
 * 都关掉：这个二进制是插件拉起的子进程，不该自己弹网页或自我升级。
 * @param {{ authtoken: string, region?: string }} input
 * @returns {Promise<string>} 写入的配置文件路径
 */
export async function writeCpolarConfig(input) {
  const authtoken = typeof input.authtoken === 'string' ? input.authtoken.trim() : '';
  if (authtoken.length === 0) throw new Error('请填写 cpolar authtoken');
  if (!/^[A-Za-z0-9._-]+$/u.test(authtoken)) throw new Error('authtoken 格式不正确');
  const lines = [
    `authtoken: "${authtoken}"`,
    'console_ui: false',
    'update: false',
    'inspect_db_size: -1',
  ];
  const region = typeof input.region === 'string' ? input.region.trim() : '';
  if (region.length > 0) {
    if (!/^[A-Za-z0-9-]+$/u.test(region)) throw new Error('region 格式不正确');
    lines.push(`region: ${region}`);
  }
  await mkdir(dirname(cpolarConfigPath()), { recursive: true });
  await writeFile(cpolarConfigPath(), `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  return cpolarConfigPath();
}

/**
 * 读 zip 里的一个成员。只支持 stored 与 deflate 两种压缩方式——官方包就是这两种，
 * 且包很小不需要 zip64。自己解而不是调 PowerShell，是为了不受本机执行策略影响。
 * @param {Buffer} buffer
 * @param {string} memberName
 * @returns {Buffer}
 */
function readZipMember(buffer, memberName) {
  const EOCD = 0x0605_4b50;
  const CENTRAL = 0x0201_4b50;
  const LOCAL = 0x0403_4b50;
  let eocdOffset = -1;
  const lowerBound = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= lowerBound; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('下载包不是有效的 zip');
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const wanted = memberName.toLowerCase();
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) throw new Error('zip 中央目录损坏');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name.toLowerCase() === wanted) {
      if (buffer.readUInt32LE(localOffset) !== LOCAL) throw new Error('zip 局部文件头损坏');
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const payload = buffer.subarray(start, start + compressedSize);
      if (method === 0) return payload;
      if (method === 8) return inflateRawSync(payload);
      throw new Error(`zip 使用了不支持的压缩方式 ${method}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`下载包里找不到 ${memberName}`);
}

/**
 * 计算文件 sha256。
 * @param {string} path
 * @returns {Promise<string>}
 */
async function fileSha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * 轮询等待文件出现，超时返回 undefined。
 * @param {string} path
 * @param {number} timeoutMs
 * @returns {Promise<string | undefined>}
 */
async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return path;
    await new Promise((resolveWait) => {
      setTimeout(resolveWait, 250);
    });
  }
  return undefined;
}

/**
 * 把下载包取到本地并校验。
 * @param {string} url
 * @param {string} target
 * @param {number} expectedBytes
 * @param {string} expectedSha256
 * @param {(message: string) => void} [log]
 * @returns {Promise<void>}
 */
async function downloadArchive(url, target, expectedBytes, expectedSha256, log) {
  log?.(`cpolar: 正在从 ${url} 下载安装包`);
  const response = await fetch(url, {
    redirect: 'follow',
    // 没有超时的话，网络半通不通时这里会一直挂着，面板就一直转圈。
    signal: AbortSignal.timeout(120_000),
    headers: { 'User-Agent': 'dsh-pocket-pro cpolar-installer' },
  });
  if (!response.ok || response.body === null) {
    throw new Error(`下载 cpolar 安装包失败：HTTP ${response.status}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  const size = (await stat(target)).size;
  if (size !== expectedBytes) {
    throw new Error(`cpolar 安装包大小不符：${size} 字节，期望 ${expectedBytes}`);
  }
  const digest = await fileSha256(target);
  if (digest !== expectedSha256) {
    throw new Error('cpolar 安装包 sha256 不符，已丢弃');
  }
  log?.('cpolar: 安装包校验通过');
}

/**
 * 用 msiexec 的管理安装模式解包：只解文件、不注册、不需要管理员权限。
 * @param {string} msiPath
 * @param {string} outputDir
 * @param {string} executableName
 * @returns {Promise<string>}
 */
async function extractMsi(msiPath, outputDir, executableName) {
  await mkdir(outputDir, { recursive: true });
  await new Promise((resolveStep, rejectStep) => {
    // 参数里不要自己加引号：Node 在 Windows 上会把内嵌引号转义成 \"，
    // msiexec 收到的属性值就带上了字面引号，TARGETDIR 变成非法路径后它会静默挂住。
    // 需要引号时交给 spawn 自己加。
    const child = spawn(
      'msiexec.exe',
      ['/a', msiPath, '/qn', `TARGETDIR=${outputDir}`],
      { stdio: 'ignore', windowsHide: true },
    );
    const timer = setTimeout(() => {
      child.kill();
      rejectStep(new Error('msiexec 解包超时'));
    }, 300_000);
    const settle = (run) => {
      clearTimeout(timer);
      run();
    };
    child.on('error', (error) => settle(() => rejectStep(error)));
    child.on('exit', (code) => settle(() => {
      // 3010 是「成功但需要重启」，解包场景可以忽略。
      if (code === 0 || code === 3010) resolveStep();
      else rejectStep(new Error(`msiexec 解包失败，退出码 ${code}`));
    }));
  });
  const expected = join(outputDir, 'cpolar', executableName);
  const found = await waitForFile(expected, 60_000);
  if (found === undefined) throw new Error('MSI 解包后找不到 cpolar 可执行文件');
  return found;
}

/**
 * 解 tar.gz：交给系统 tar（Windows 10+ 与所有 Linux 发行版都自带）。
 * @param {string} archivePath
 * @param {string} outputDir
 * @param {string} executableName
 * @returns {Promise<string>}
 */
async function extractTarGz(archivePath, outputDir, executableName) {
  await mkdir(outputDir, { recursive: true });
  await new Promise((resolveStep, rejectStep) => {
    const child = spawn('tar', ['-xzf', archivePath, '-C', outputDir], { stdio: 'ignore' });
    child.on('error', rejectStep);
    child.on('exit', (code) => {
      if (code === 0) resolveStep();
      else rejectStep(new Error(`tar 解包失败，退出码 ${code}`));
    });
  });
  const found = await findFile(outputDir, executableName);
  if (found === undefined) throw new Error('tar 解包后找不到 cpolar 可执行文件');
  return found;
}

/**
 * 递归找文件。
 * @param {string} directory
 * @param {string} fileName
 * @returns {Promise<string | undefined>}
 */
async function findFile(directory, fileName) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(full, fileName);
      if (nested !== undefined) return nested;
    } else if (entry.name.toLowerCase() === fileName.toLowerCase()) {
      return full;
    }
  }
  return undefined;
}

/**
 * 安装 cpolar 组件（幂等）。已经装好同版本时直接返回。
 *
 * 流程：下载 → 校验安装包 → 解包 → 校验可执行文件 → 原子改名落到组件目录。
 * 任何一步失败都不留下半成品：解包与校验都在临时目录里做。
 *
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {Promise<{ version: string, path: string, installedNow: boolean }>}
 */
export async function installCpolar(options = {}) {
  const log = options.log;
  const release = cpolarRelease();
  if (release === undefined) {
    throw new Error(`cpolar 没有为 ${platform()}-${arch()} 提供预编译包`);
  }
  const existing = installedCpolar();
  if (existing !== undefined && existing.version === release.version) {
    return { ...existing, installedNow: false };
  }

  const components = cpolarComponentsDir();
  await mkdir(components, { recursive: true });
  const workDir = join(tmpdir(), `dsh-pocket-cpolar-${process.pid}-${Date.now()}`);
  const staging = join(components, `.staging-${process.pid}-${Date.now()}`);
  try {
    const archivePath = join(workDir, 'package');
    await downloadArchive(release.url, archivePath, release.archiveBytes, release.archiveSha256, log);

    let produced;
    if (release.archiveKind === 'zip-msi') {
      log?.('cpolar: 正在解出安装包内的 MSI');
      const buffer = await readFile(archivePath);
      const msi = readZipMember(buffer, release.msiMember);
      const msiPath = join(workDir, release.msiMember);
      await writeFile(msiPath, msi);
      const msiOut = join(workDir, 'msi');
      log?.('cpolar: 正在用 msiexec 解包（不需要管理员权限）');
      produced = await extractMsi(msiPath, msiOut, release.executableName);
    } else {
      log?.('cpolar: 正在解包 tar.gz');
      produced = await extractTarGz(archivePath, join(workDir, 'tar'), release.executableName);
    }

    const size = (await stat(produced)).size;
    if (size !== release.executableBytes) {
      throw new Error(`cpolar 可执行文件大小不符：${size} 字节，期望 ${release.executableBytes}`);
    }
    const digest = await fileSha256(produced);
    if (digest !== release.executableSha256) {
      throw new Error('cpolar 可执行文件 sha256 不符，已丢弃');
    }

    await mkdir(staging, { recursive: true });
    const targetPath = join(staging, release.executableName);
    await writeFile(targetPath, await readFile(produced));
    if (platform() !== 'win32') await chmod(targetPath, 0o755);
    const finalDir = join(components, release.version);
    await rm(finalDir, { recursive: true, force: true });
    await rename(staging, finalDir);
    const installedPath = join(finalDir, release.executableName);
    log?.(`cpolar: 已安装到 ${installedPath}`);
    return { version: release.version, path: installedPath, installedNow: true };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
