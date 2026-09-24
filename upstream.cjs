#!/usr/bin/env node
// EDOPro upstream, pinned by commit in upstream.lock.json: the card databases, the card scripts, the engine source and
// the two single files a headless run needs, plus an EDOPro-shaped data root assembled from them and an x64 build of
// the engine. A consuming project mounts this repository (e.g. as a git submodule) and follows its lock file.
//
//   node upstream.cjs show                    print the pins
//   node upstream.cjs bump [--dry-run]        move every pin to the current HEAD of its branch and rewrite the lock file
//   node upstream.cjs fetch [--dest D] [--patches DIR]... [--force]
//                                             check the pinned commits out under D (default ./upstream, relative to the
//                                             working directory) and assemble D/edopro; every *.patch in each --patches
//                                             directory is applied to D/ygopro-core in file-name order
//   node upstream.cjs build [--dest D]        compile D/ygopro-core with MSVC: premake5 vs2022 + msbuild, x64 Release
//   node upstream.cjs env [--dest D]          print EDOPRO_PATH=... and OCGCORE_PATH=... (for a shell, or for $GITHUB_ENV)
//
// The data root, and why it is shaped like this:
//   D/edopro/expansions/*.cdb                     ProjectIgnis/BabelCDB at its pin: the full card databases. This is the
//                                                 BASE layer. A real client's base is whatever its installer shipped; here
//                                                 it is upstream HEAD, so there is nothing stale for an update to correct.
//   D/edopro/script/                              empty: the base scripts. Every script comes from the update layer.
//   D/edopro/repositories/cardscripts/            ProjectIgnis/CardScripts at its pin, declared in config/configs.json as
//                                                 the update repository "Project Ignis updates" with script_path "" -
//                                                 card scripts and shared libraries alike.
//   D/edopro/config/configs.json                  that declaration
//   D/edopro/config/strings.conf                  ProjectIgnis/Distribution at its pin: the English system strings
//   D/edopro/config/languages/简体中文/cards.cdb   mycard/ygopro-database at its pin: community Chinese card names
//   D/ygopro-core/                                edo9300/ygopro-core at its pin, lua submodule included, with the
//                                                 consumer's patches (--patches) applied.
// Nothing comes from DeltaBagooska: its .delta.cdb files correct an installer's base, and this base is already upstream
// HEAD. A project's own cards go into D/edopro/expansions after fetch; that step belongs to the project, not here.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const LOCK = path.join(__dirname, 'upstream.lock.json');
const UPDATE_LAYER = 'Project Ignis updates';
const UA = { 'User-Agent': 'edopro-upstream-kit' };
const PREMAKE_URL = 'https://github.com/premake/premake-core/releases/download/v5.0.0-beta2/premake-5.0.0-beta2-windows.zip';

function readLock() { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); }
function writeLock(lock) { fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n'); }

function git(args, opts) {
  const r = cp.spawnSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed (' + r.status + '):\n' + (r.stderr || r.stdout));
  return r.stdout.trim();
}

function run(exe, args, cwd) {
  const r = cp.spawnSync(exe, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(exe + ' ' + args.join(' ') + ' failed (' + r.status + ')' + (r.error ? ': ' + r.error.message : ''));
}

function ownerRepo(url) {
  const m = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new Error('not a GitHub url: ' + url);
  return m[1] + '/' + m[2];
}

async function fetchWithRetry(url, init, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.ok) return r;
      last = new Error(url + ' -> HTTP ' + r.status);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) break;
    } catch (e) { last = e; }
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  throw last;
}

async function download(url, file) {
  const r = await fetchWithRetry(url, { headers: UA });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return fs.statSync(file).size;
}

/// The committer date of a commit, from the GitHub API; null when the API cannot be reached (the pin is still valid).
async function commitDate(url, sha) {
  const headers = { ...UA, Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = 'Bearer ' + token;
  try {
    const r = await fetchWithRetry('https://api.github.com/repos/' + ownerRepo(url) + '/commits/' + sha, { headers }, 2);
    return (await r.json()).commit.committer.date;
  } catch (e) {
    console.error('  (no commit date for ' + sha.slice(0, 12) + ': ' + e.message + ')');
    return null;
  }
}

/// A checkout of exactly one commit, working files with LF endings whatever the machine's core.autocrlf says
/// (patches are applied against LF sources, and the repositories store LF).
function cloneAt(url, sha, dir, opts = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], { cwd: dir });
  git(['config', 'core.autocrlf', 'false'], { cwd: dir });
  git(['remote', 'add', 'origin', url], { cwd: dir });
  git(['-c', 'protocol.version=2', 'fetch', '-q', '--depth', '1', 'origin', sha], { cwd: dir });
  git(['checkout', '-q', 'FETCH_HEAD'], { cwd: dir });
  if (opts.submodules) git(['-c', 'core.autocrlf=false', 'submodule', 'update', '--init', '--recursive', '--depth', '1'], { cwd: dir });
}

function argValue(args, name, def) { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; }
function argValues(args, name) { const out = []; args.forEach((a, i) => { if (a === name && args[i + 1]) out.push(args[i + 1]); }); return out; }
const destOf = (args) => path.resolve(argValue(args, '--dest', 'upstream'));

/// Every *.patch in the given directories, directory by directory, in file-name order, normalised to LF.
function patchList(dirs) {
  const out = [];
  for (const d of dirs) {
    const dir = path.resolve(d);
    if (!fs.existsSync(dir)) throw new Error('no patch directory ' + dir);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.patch')).sort()) {
      out.push({ name: f, body: fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n') });
    }
  }
  return out;
}

/// --check first, so a patch that no longer fits the pinned engine fails here with the patch's name rather than at
/// compile time.
function applyPatches(coreDir, patches) {
  for (const p of patches) {
    for (const args of [['apply', '--check', '-'], ['apply', '-']]) {
      const r = cp.spawnSync('git', args, { cwd: coreDir, input: p.body, encoding: 'utf8' });
      if (r.status !== 0) throw new Error('patch ' + p.name + ' does not apply to the pinned ygopro-core:\n' + (r.stderr || r.stdout));
    }
    console.log('  applied ' + p.name);
  }
  fs.writeFileSync(path.join(coreDir, '.kit-patches.json'), JSON.stringify(patches.map((p) => p.name), null, 2) + '\n');
}

function copyCdbs(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(from).filter((x) => x.toLowerCase().endsWith('.cdb')).sort()) { fs.copyFileSync(path.join(from, f), path.join(to, f)); n++; }
  return n;
}

function coreLibrary(dest) {
  const core = path.join(dest, 'ygopro-core');
  // premake5.lua: Windows puts the x64 build in bin/x64/release, other systems in bin/release.
  if (process.platform === 'win32') return path.join(core, 'bin', 'x64', 'release', 'ocgcore.dll');
  return path.join(core, 'bin', 'release', process.platform === 'darwin' ? 'libocgcore.dylib' : 'libocgcore.so');
}

// ── commands ──────────────────────────────────────────────────────────────────────────────────
function show() {
  const lock = readLock();
  for (const [name, u] of Object.entries(lock.upstream)) {
    console.log(`${name.padEnd(16)} ${u.commit.slice(0, 12)}  ${(u.date || '').slice(0, 10).padEnd(10)}  ${u.url}  (${u.branch}${u.file ? ', ' + u.file : ''})`);
  }
}

async function bump(args) {
  const dry = args.includes('--dry-run');
  const lock = readLock();
  let moved = 0;
  for (const [name, u] of Object.entries(lock.upstream)) {
    const out = git(['ls-remote', u.url, 'refs/heads/' + u.branch]);
    const sha = out.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('could not read HEAD of ' + u.url + ' ' + u.branch + ': ' + out);
    if (sha === u.commit) { console.log(`${name.padEnd(16)} unchanged ${sha.slice(0, 12)}`); continue; }
    const date = await commitDate(u.url, sha);
    console.log(`${name.padEnd(16)} ${u.commit.slice(0, 12)} -> ${sha.slice(0, 12)}  ${(date || '').slice(0, 10)}`);
    u.commit = sha;
    u.date = date;
    moved++;
  }
  if (moved && !dry) writeLock(lock);
  console.log(moved ? `${moved} pin(s) moved${dry ? ' (dry run, lock file untouched)' : ''}` : 'every pin is already at upstream HEAD');
}

async function fetchAll(args) {
  const dest = destOf(args);
  const force = args.includes('--force');
  const U = readLock().upstream;
  const patches = patchList(argValues(args, '--patches'));
  const want = JSON.stringify({ upstream: U, patches: patches.map((p) => p.name + ':' + crypto.createHash('sha1').update(p.body).digest('hex')) });
  const marker = path.join(dest, '.kit-upstream.json');
  const edopro = path.join(dest, 'edopro');
  const core = path.join(dest, 'ygopro-core');
  if (!force && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === want && fs.existsSync(edopro) && fs.existsSync(core)) {
    console.log('upstream already checked out at the pinned commits under ' + dest + ' (--force to redo)');
    return;
  }
  fs.rmSync(marker, { force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tmp = path.join(dest, '.tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(edopro, { recursive: true, force: true });

  console.log('ygopro-core ' + U['ygopro-core'].commit.slice(0, 12));
  cloneAt(U['ygopro-core'].url, U['ygopro-core'].commit, core, { submodules: true });
  applyPatches(core, patches);

  console.log('BabelCDB ' + U.BabelCDB.commit.slice(0, 12));
  const babel = path.join(tmp, 'BabelCDB');
  cloneAt(U.BabelCDB.url, U.BabelCDB.commit, babel);
  console.log('  ' + copyCdbs(babel, path.join(edopro, 'expansions')) + ' database(s) into expansions/');
  fs.writeFileSync(path.join(edopro, 'expansions', 'VERSION'), U.BabelCDB.commit + '\n');
  fs.rmSync(babel, { recursive: true, force: true });

  console.log('CardScripts ' + U.CardScripts.commit.slice(0, 12));
  cloneAt(U.CardScripts.url, U.CardScripts.commit, path.join(edopro, 'repositories', 'cardscripts'));
  fs.mkdirSync(path.join(edopro, 'script'), { recursive: true });   // the (empty) base scripts: every script is in the update layer
  fs.mkdirSync(path.join(edopro, 'replay'), { recursive: true });

  console.log('Distribution ' + U.Distribution.commit.slice(0, 12) + ' -> config/strings.conf');
  await download(`https://raw.githubusercontent.com/${ownerRepo(U.Distribution.url)}/${U.Distribution.commit}/${U.Distribution.file}`, path.join(edopro, 'config', 'strings.conf'));
  console.log('ygopro-database ' + U['ygopro-database'].commit.slice(0, 12) + ' -> config/languages/简体中文/cards.cdb');
  const zh = await download(`https://raw.githubusercontent.com/${ownerRepo(U['ygopro-database'].url)}/${U['ygopro-database'].commit}/${U['ygopro-database'].file}`, path.join(edopro, 'config', 'languages', '简体中文', 'cards.cdb'));
  console.log('  ' + zh.toLocaleString() + ' bytes');

  fs.writeFileSync(path.join(edopro, 'config', 'configs.json'), JSON.stringify({
    _note: 'Assembled by edopro-upstream-kit from upstream.lock.json. expansions/ is BabelCDB (the base layer), the one update repository is CardScripts.',
    repos: [{
      url: U.CardScripts.url,
      repo_name: UPDATE_LAYER,
      repo_path: './repositories/cardscripts',
      script_path: '',
      should_update: false,
      should_read: true,
    }],
  }, null, 2) + '\n');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(marker, want);
  console.log('data root assembled at ' + edopro);
}

/// premake5.exe: D/.tools, downloaded once (4 MB).
async function ensurePremake(dest) {
  const tools = path.join(dest, '.tools');
  const exe = path.join(tools, 'premake5.exe');
  if (fs.existsSync(exe)) return exe;
  console.log('downloading premake5 (once): ' + PREMAKE_URL);
  const zip = path.join(tools, 'premake.zip');
  await download(PREMAKE_URL, zip);
  // Windows 10+ ships bsdtar as tar.exe, which reads zip; it does not depend on PowerShell's module path.
  run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tools], tools);
  fs.rmSync(zip, { force: true });
  if (!fs.existsSync(exe)) throw new Error('premake5.exe not found after extracting ' + zip);
  return exe;
}

function findMsbuild() {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (fs.existsSync(vswhere)) {
    const r = cp.spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], { encoding: 'utf8' });
    const found = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (found && fs.existsSync(found)) return found;
  }
  if (cp.spawnSync('msbuild', ['-version'], { stdio: 'ignore' }).status === 0) return 'msbuild';
  throw new Error('MSBuild not found: install Visual Studio 2022 Build Tools with the "Desktop development with C++" workload (x64 tools)');
}

async function build(args) {
  const dest = destOf(args);
  const core = path.join(dest, 'ygopro-core');
  if (!fs.existsSync(path.join(core, 'premake5.lua'))) throw new Error('no ygopro-core under ' + dest + ' - run `node upstream.cjs fetch` first');
  if (process.platform !== 'win32') throw new Error('build is implemented for Windows (MSVC) only; elsewhere run premake5 + your build tool in ' + core);
  const premake = await ensurePremake(dest);
  const msbuild = findMsbuild();
  run(premake, ['vs2022'], core);
  run(msbuild, ['build\\ocgcore.sln', '/t:ocgcoreshared', '/p:Configuration=Release', '/p:Platform=x64', '/m', '/v:minimal'], core);
  const dll = coreLibrary(dest);
  const st = fs.statSync(dll);
  console.log(`${dll}  ${st.size.toLocaleString()} bytes  ${st.mtime.toISOString()}`);
}

function env(args) {
  const dest = destOf(args);
  console.log('EDOPRO_PATH=' + path.join(dest, 'edopro'));
  console.log('OCGCORE_PATH=' + coreLibrary(dest));
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'show': show(); break;
    case 'bump': await bump(rest); break;
    case 'fetch': await fetchAll(rest); break;
    case 'build': await build(rest); break;
    case 'env': env(rest); break;
    default:
      console.error('usage: node upstream.cjs show | bump [--dry-run] | fetch [--dest D] [--patches DIR]... [--force] | build [--dest D] | env [--dest D]');
      process.exit(2);
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
