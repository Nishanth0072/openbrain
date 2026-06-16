#!/usr/bin/env node

import WebSocket from 'ws';
import readline from 'readline';
import chalk from 'chalk';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const WS_URL = 'ws://localhost:3000?type=cli';
const REPORT_WIDTH = 76;
const SHELL_TIMEOUT_MS = 20000;

// ─── App data dir ───
const APP_DIR = path.join(os.homedir(), '.openbrain');
const HISTORY_FILE = path.join(APP_DIR, 'history');
const SESSIONS_DIR = path.join(APP_DIR, 'sessions');
[APP_DIR, SESSIONS_DIR].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch { } });

// ─── Theme system ───
const CONFIG_FILE = path.join(APP_DIR, 'config.json');

const THEMES = {
  matrix: { primary: '#00ff41', secondary: '#008f11', accent: '#00cc33', text: '#aaffaa', warn: '#ffff00', err: '#ff4444', info: '#00ffff', badge: ['#008f11', '#00ff41'] },
  cyberpunk: { primary: '#ff00ff', secondary: '#bf00ff', accent: '#00e5ff', text: '#e0aaff', warn: '#ffea00', err: '#ff1744', info: '#00e5ff', badge: ['#bf00ff', '#ff00ff'] },
  ocean: { primary: '#0ea5e9', secondary: '#0284c7', accent: '#38bdf8', text: '#bae6fd', warn: '#fbbf24', err: '#f87171', info: '#67e8f9', badge: ['#0284c7', '#38bdf8'] },
  dracula: { primary: '#bd93f9', secondary: '#6272a4', accent: '#ff79c6', text: '#f8f8f2', warn: '#f1fa8c', err: '#ff5555', info: '#8be9fd', badge: ['#6272a4', '#bd93f9'] },
  sunset: { primary: '#f97316', secondary: '#dc2626', accent: '#fbbf24', text: '#fed7aa', warn: '#facc15', err: '#ef4444', info: '#fb923c', badge: ['#dc2626', '#f97316'] },
  synthwave: { primary: '#ff71ce', secondary: '#b967ff', accent: '#01cdfe', text: '#fffb96', warn: '#05ffa1', err: '#ff3366', info: '#01cdfe', badge: ['#b967ff', '#ff71ce'] },
  nord: { primary: '#88c0d0', secondary: '#5e81ac', accent: '#81a1c1', text: '#eceff4', warn: '#ebcb8b', err: '#bf616a', info: '#b48ead', badge: ['#5e81ac', '#88c0d0'] },
  aurora: { primary: '#a3be8c', secondary: '#8fbcbb', accent: '#d08770', text: '#eceff4', warn: '#ebcb8b', err: '#bf616a', info: '#b48ead', badge: ['#8fbcbb', '#a3be8c'] },
  toxic: { primary: '#39ff14', secondary: '#00cc00', accent: '#ccff00', text: '#e0ffcc', warn: '#ffff00', err: '#ff0033', info: '#00ffff', badge: ['#00cc00', '#39ff14'] },
  coral: { primary: '#ff7f50', secondary: '#cd5b45', accent: '#ff4500', text: '#ffe4e1', warn: '#ffd700', err: '#dc143c', info: '#20b2aa', badge: ['#cd5b45', '#ff7f50'] },
  vampire: { primary: '#ff0000', secondary: '#8a0303', accent: '#ff3333', text: '#ffb3b3', warn: '#ffaa00', err: '#ff0000', info: '#ff6666', badge: ['#8a0303', '#ff0000'] },
};

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch { }
}

const _cfg = loadConfig();
let currentThemeName = (_cfg.theme && THEMES[_cfg.theme]) ? _cfg.theme : 'matrix';

function T() { return THEMES[currentThemeName]; }

// Themed chalk helpers
const tc = {
  primary: (s) => chalk.hex(T().primary)(s),
  secondary: (s) => chalk.hex(T().secondary)(s),
  accent: (s) => chalk.hex(T().accent)(s),
  text: (s) => chalk.hex(T().text)(s),
  warn: (s) => chalk.hex(T().warn)(s),
  err: (s) => chalk.hex(T().err)(s),
  info: (s) => chalk.hex(T().info)(s),
  bold: (s) => chalk.bold.hex(T().primary)(s),
  muted: (s) => chalk.gray(s),
  badge: (s) => chalk.bgHex(T().badge[0]).hex(T().badge[1])(s),
};

// ─── Skills loader ───
const __filename_cli = fileURLToPath(import.meta.url);
const __dirname_cli = path.dirname(__filename_cli);
const SKILLS_DIR = path.join(__dirname_cli, '.agents', 'skills');

function loadSkills() {
  const skills = [];
  try {
    if (!fs.existsSync(SKILLS_DIR)) return skills;
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, 'utf-8');
      // Parse description from front-matter
      const descMatch = content.match(/^description:\s*(.+)$/m);
      skills.push({
        name: entry.name,
        path: skillMd,
        description: descMatch ? descMatch[1].trim() : 'No description',
        content,
      });
    }
  } catch { }
  return skills;
}

const loadedSkills = loadSkills();

function buildSkillsContext() {
  if (loadedSkills.length === 0) return '';
  const parts = loadedSkills.map(s => {
    // Only send name, description, and first 30 non-empty lines of the skill
    const lines = s.content.split('\n').filter(l => l.trim()).slice(0, 30).join('\n');
    return `[SKILL: ${s.name}]\nDescription: ${s.description}\n${lines}\n[END SKILL: ${s.name}]`;
  });
  return `\n\n[BACKGROUND SKILLS — use these when relevant, do NOT mention or re-acknowledge them]\n${parts.join('\n\n')}`;
}

// ─── Detect project context ───
const CWD = process.cwd();
const PROJECT_NAME = path.basename(CWD);
let USER = 'user';
try { USER = os.userInfo().username || 'user'; } catch (e) { }
let shellCwd = CWD;
let lastShellCommand = '';
let lastShellOutput = '';

// ─── State ───
let isWaiting = false;
let toolCallCount = 0;
let reportBuffer = '';
let isStreamingReport = false;
let autoMode = false;
let sessionLog = [];   // { role, text, ts }
let sessionStart = new Date().toISOString();
let pendingImage = null; // { path, b64, type } — attached to next AI prompt
let lastShellCommandTs = 0; // timestamp of last shell command
let extensionConnected = false; // tracks whether the browser extension is connected

// Commands whose output should NOT pollute the AI context
const NOISY_CMD_PATTERNS = [
  /^browser-use\s+tunnel/,
  /^(curl|wget|ssh|ping|nmap|nc|netcat|telnet)/,
  /^(ngrok|cloudflared|lt|localtunnel)/,
  /^(brew|apt|pacman|yum|dnf|snap)\s+(install|upgrade|update)/,
];

function isNoisyCommand(cmd) {
  return NOISY_CMD_PATTERNS.some(p => p.test(cmd.trim()));
}

const SHELL_CTX_TTL_MS = 60_000; // shell context expires after 60s

function shortCwd(dir) {
  return dir.replace(os.homedir(), '~');
}

// ─── Persistent history ───
let cmdHistory = [];
try {
  const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
  cmdHistory = raw.split('\n').filter(Boolean).slice(-500);
} catch { }

function saveHistory(line) {
  if (!line.trim() || line.startsWith('/')) return;
  cmdHistory.push(line);
  try { fs.appendFileSync(HISTORY_FILE, line + '\n'); } catch { }
}

// ─── Session saving ───
function saveSession() {
  if (sessionLog.length === 0) return;
  const ts = sessionStart.replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(SESSIONS_DIR, `${ts}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ project: PROJECT_NAME, cwd: CWD, start: sessionStart, log: sessionLog }, null, 2));
    return file;
  } catch { return null; }
}

function listSessions() {
  try {
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort().reverse().slice(0, 10)
      .map(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f)));
          const msgs = d.log?.filter(l => l.role === 'user').length || 0;
          return `  ${tc.accent(f.replace('.json', ''))}  ${tc.muted(`[${d.project}]`)}  ${tc.text(`${msgs} messages`)}`;
        } catch { return `  ${tc.muted(f)}`; }
      });
  } catch { return []; }
}

// ─── Project context injection ───
async function buildProjectContext() {
  const parts = [];

  // git status
  const gitStatus = await runLocalShell('git status --short 2>/dev/null | head -20');
  if (gitStatus.ok && gitStatus.output !== '(no output)') {
    parts.push(`[Git status]\n${gitStatus.output}`);
  }

  // git branch
  const branch = await runLocalShell('git branch --show-current 2>/dev/null');
  if (branch.ok && branch.output !== '(no output)') {
    parts.push(`[Git branch: ${branch.output.trim()}]`);
  }

  // package.json summary
  try {
    const pkgPath = path.join(shellCwd, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const info = [
      pkg.name ? `name: ${pkg.name}` : null,
      pkg.version ? `version: ${pkg.version}` : null,
      pkg.scripts ? `scripts: ${Object.keys(pkg.scripts).join(', ')}` : null,
    ].filter(Boolean).join(' | ');
    parts.push(`[package.json: ${info}]`);
  } catch { }

  // Directory listing (top-level structure)
  const lsDir = await runLocalShell('find . -maxdepth 2 -not -path "*/\\.*" -not -path "*/node_modules*" | sort | head -30');
  if (lsDir.ok && lsDir.output !== '(no output)') {
    parts.push(`[Directory structure (max depth 2)]\n${lsDir.output}`);
  }

  // README first 20 lines
  try {
    const readme = fs.readFileSync(path.join(shellCwd, 'README.md'), 'utf-8')
      .split('\n').slice(0, 20).join('\n').trim();
    if (readme) parts.push(`[README.md (first 20 lines)]\n${readme}`);
  } catch { }

  // file tree (2 levels)
  const tree = await runLocalShell('find . -maxdepth 2 -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/__pycache__/*" 2>/dev/null | head -40');
  if (tree.ok && tree.output !== '(no output)') {
    parts.push(`[Project tree]\n${tree.output}`);
  }

  return parts.length ? `\n\n--- AUTOMATIC PROJECT CONTEXT ---\n${parts.join('\n')}\n--- END CONTEXT ---` : '';
}

// ─── Spinner ───
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerTimer = null;
let spinnerIdx = 0;
let spinnerActive = false;

function startSpinner(msg) {
  stopSpinner();
  spinnerActive = true;
  spinnerIdx = 0;
  spinnerTimer = setInterval(() => {
    if (!spinnerActive) return;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`  ${tc.accent(FRAMES[spinnerIdx++ % FRAMES.length])} ${tc.muted(msg)}`);
  }, 100);
}

function stopSpinner() {
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  if (spinnerActive) {
    spinnerActive = false;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

// ─── Formatting ───
function printBanner() {
  console.clear();
  const autoTag = autoMode
    ? chalk.bgHex('#00e676').hex('#000')(' ⚡ AUTO ')
    : chalk.bgHex('#424242').hex('#bdbdbd')(' ○ MANUAL ');

  // ── Theme-aware gradient helpers ──
  const t = T();
  const G1 = chalk.hex(t.primary);       // bright primary
  const G2 = chalk.hex(t.secondary);     // darker shade
  const G3 = chalk.hex(t.accent);        // accent highlights
  const EY = chalk.bold.hex(t.accent);   // glowing eyes
  const WB = chalk.hex('#555555');        // web thread (subtle)
  const DM = chalk.dim.hex(t.primary);   // dim glow aura
  const BG = chalk.hex(t.text);          // body glow
  const SP = chalk.hex(t.info);          // sparkle
  const W = chalk.bold.white;

  // ── Spider ASCII art — compact 12-line Braille spiderman with multi-color gradient ──
  const spiderArt = [
    /*  0 */  DM('  ⢀⡟⢀⡏') + '         ' + DM('⠈⣧⠈⣧  '),
    /*  1 */  G1('  ⣼ ⣼⡇') + '          ' + G1('⢻⡆⢸⡆ '),
    /*  2 */  G1(' ⢰⣿ ') + G3('⠻⠧⣤⡴⣦⣤⣤⣤⣠⡶⣤⣤⠾⠗') + G1('⠈⣿ '),
    /*  3 */  G1(' ⠺⣷⡶') + EY('⠖⠛⣩⣭⣿⣿⣿⣿⣿⣯⣭⡙⠛') + G1('⠶⣶⡿⠃'),
    /*  4 */  G2('   ⢀⣤⠾') + EY('⢋⣴⠟⣿⣿⣿⡟⢷⣬⠙') + G2('⢷⣄   '),
    /*  5 */  G1('⢀⣠⡴⠟⠁ ') + G3('⣾⡇ ') + EY('⣿⣿⣿⡇') + G3(' ⣿⡇') + G1(' ⠙⠳⣦⣀'),
    /*  6 */  G2('⢸⡏    ') + G3('⢿⡇ ') + EY('⢸⣿⣿⠁') + G3(' ⣿⡇') + G2('   ⠈⣿'),
    /*  7 */  G2(' ⣷    ') + G1('⢸⡇  ') + EY('⢻⠇') + G1('  ⣿⠇') + G2('    ⣿'),
    /*  8 */  G2(' ⢿    ') + G1('⢸⡇') + '      ' + G1('⣿') + G2('    ⢸⡏'),
    /*  9 */  DM(' ⠘⡇   ') + G1('⠈⣷') + '     ' + G1('⢀⡟') + DM('    ⡾ '),
    /* 10 */  DM('  ⠹    ') + G1('⢻') + '     ' + G1('⢸⠇') + DM('   ⢰⠁ '),
    /* 11 */  DM('   ⠁   ') + DM('⠈⢇') + '    ' + DM('⡞') + DM('    ⠁  '),
  ];

  // ── Premium double-border title card ──
  const titleLines = [
    '',
    tc.bold('  ╔═══════════════════════════════════════╗'),
    tc.bold('  ║') + '  ' + SP('✦') + ' ' + W('OPEN') + tc.bold('BRAIN') + W('  ') + tc.muted('·') + W('  AI Agent ') + chalk.bgHex(t.badge[0]).hex(t.badge[1])(' v2.1 ') + '  ' + tc.bold('║'),
    tc.bold('  ╠═══════════════════════════════════════╣'),
    tc.bold('  ║') + tc.muted('  🌐 Browser AI + Local MCP Toolchain   ') + tc.bold('║'),
    tc.bold('  ║') + tc.muted('  🤖 Autonomous Agent                   ') + tc.bold('║'),
    tc.bold('  ╚═══════════════════════════════════════╝'),
    '',
    '  ' + tc.accent('●') + tc.muted(' Project  ') + chalk.gray('→') + '  ' + W(PROJECT_NAME),
    '  ' + tc.info('●') + tc.muted(' Workdir  ') + chalk.gray('→') + '  ' + tc.text(shortCwd(shellCwd)),
    '  ' + tc.primary('●') + tc.muted(' User     ') + chalk.gray('→') + '  ' + tc.text(USER),
    '  ' + tc.accent('●') + tc.muted(' Backend  ') + chalk.gray('→') + '  ' + tc.info('ws://localhost:3000'),
    '  ' + (extensionConnected
      ? tc.accent('●') + tc.muted(' Browser  ') + chalk.gray('→') + '  ' + tc.accent('Extension connected ✓')
      : tc.err('●') + tc.muted(' Browser  ') + chalk.gray('→') + '  ' + tc.err('Extension NOT connected ✗')),
  ];

  console.log();

  // Print spider + title side by side
  const totalRows = Math.max(spiderArt.length, titleLines.length);
  for (let i = 0; i < totalRows; i++) {
    const spiderRow = spiderArt[i] !== undefined ? '  ' + spiderArt[i] : '                       '; // 23 chars space fallback (2 space + 21 pad)
    const titleRow = titleLines[i] !== undefined ? '   ' + titleLines[i] : '';
    process.stdout.write(spiderRow + titleRow + '\n');
  }

  console.log();

  // ── Mode + Theme bar ──
  const modeStr = '  ' + autoTag + tc.muted('  toggle: ') + tc.warn('/auto') + tc.muted('  │  theme: ') + tc.primary(currentThemeName) + tc.muted('  switch: ') + tc.warn('/theme');
  console.log(modeStr);
  console.log();

  // ── Skills ──
  if (loadedSkills.length > 0) {
    const skillNames = loadedSkills.map(s => tc.primary(s.name)).join(tc.muted(' · '));
    console.log(tc.muted('  🔌 Skills   ') + chalk.gray('→') + '  ' + skillNames);
  }
  console.log(tc.muted('  📂 Sessions ') + chalk.gray('→') + '  ' + tc.text(SESSIONS_DIR));
  console.log();

  // ── Hint bar ──
  console.log(tc.muted('  Type any natural-language request. Shell commands work directly.'));
  console.log(tc.muted('  Prefix with ') + tc.warn('!') + tc.muted(' to force local execution.'));
  console.log();

  // ── Commands row ──
  const cmdGroups = [
    ['/auto', '/clear', '/exit'],
    ['/context', '/history', '/sessions', '/save'],
    ['/img', '/screenshot', '/skills', '/theme', '/help'],
  ];
  for (const group of cmdGroups) {
    console.log('  ' + group.map(c => tc.warn(c)).join(tc.muted('  ')));
  }

  // ── Separator ──
  const gradientBar = tc.secondary('  ┄') + tc.primary('━'.repeat(12)) + tc.accent('━'.repeat(12)) + tc.info('━'.repeat(12)) + tc.primary('━'.repeat(12)) + tc.secondary('━'.repeat(12)) + tc.secondary('┄');
  console.log(gradientBar);
  console.log();
}


function getPrompt() {
  const modeTag = autoMode ? tc.accent('⚡') : tc.secondary('○');
  return modeTag + ' ' + tc.bold(`${USER}`) + tc.secondary(':') + tc.info(shortCwd(shellCwd)) + tc.primary(' λ ');
}

function printToolCall(tool, args, toolNum) {
  const argStr = JSON.stringify(args || {});
  const short = argStr.length > 80 ? argStr.slice(0, 77) + '...' : argStr;
  const badge = tc.badge(` TOOL #${toolNum} `);
  const autoTag = autoMode ? tc.accent(' ⚡auto') : '';
  console.log(`\n  ${badge} ${tc.warn(tool)}${autoTag}`);
  console.log(tc.muted(`         args: ${short}`));
}

function printToolDone(preview, isError) {
  const clean = (preview || '').replace(/\n/g, ' ').trim();
  const short = clean.length > 70 ? clean.slice(0, 67) + '...' : clean;
  console.log(isError
    ? tc.err(`    ✗ `) + tc.err(short)
    : tc.accent(`    ✓ `) + tc.muted(short));
}

function cleanAndPrintReasoning(text) {
  if (!text) return;
  const cleaned = text
    .replace(/MCP_ACTION:\s*\{[\s\S]*?\}/g, '')
    .replace(/```json\s*\n?MCP_ACTION[\s\S]*?```/g, '')
    .replace(/\[TOOL RESULT:[\s\S]*?\[END TOOL RESULT\]/g, '')
    .replace(/Continue your analysis\..*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned) {
    console.log();
    for (const rawLine of cleaned.split('\n')) {
      if (!rawLine.trim()) { console.log(); continue; }
      const words = rawLine.split(' ');
      let cur = '  ';
      for (const word of words) {
        if ((cur + word).length > REPORT_WIDTH - 2) { console.log(tc.secondary(cur)); cur = '  ' + word + ' '; }
        else cur += word + ' ';
      }
      if (cur.trim()) console.log(tc.secondary(cur));
    }
  }
}

function printFinalReport(text, toolCnt) {
  const thinBar = '─'.repeat(REPORT_WIDTH);
  const toolLabel = `${toolCnt} tool call${toolCnt !== 1 ? 's' : ''}`;
  console.log();
  console.log(tc.bold('  ┌' + thinBar + '┐'));
  const titleStr = '  ✨ Final Report';
  const padding = Math.max(0, REPORT_WIDTH - titleStr.length - toolLabel.length - 2);
  console.log(tc.bold('  │') + chalk.bold.white(titleStr) + ' '.repeat(padding) + tc.muted(toolLabel) + '  ' + tc.bold('│'));
  console.log(tc.bold('  ├' + thinBar + '┤'));
  console.log();
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) { console.log(); continue; }
    const words = rawLine.split(' ');
    let cur = '  ';
    for (const word of words) {
      if ((cur + word).length > REPORT_WIDTH - 2) { console.log(tc.text(cur)); cur = '  ' + word + ' '; }
      else cur += word + ' ';
    }
    if (cur.trim()) console.log(tc.text(cur));
  }
  console.log();
  console.log(tc.bold('  └' + thinBar + '┘'));
  console.log();
}

function printHelp() {
  console.log();
  console.log(chalk.bold.white('  ── Commands ──────────────────────────────────'));
  const cmds = [
    ['/auto', 'Toggle auto-mode (skip all tool approval prompts)'],
    ['/context', 'Show current project context that gets sent to AI'],
    ['/history', 'Show last 20 commands from history'],
    ['/sessions', 'List recent saved sessions'],
    ['/save', 'Save current session to disk'],
    ['/clear', 'Clear terminal and show banner'],
    ['/skills', 'List loaded skills and their descriptions'],
    ['/theme [name]', 'Switch color theme (matrix|cyberpunk|ocean|dracula|sunset)'],
    ['/help', 'Show this help'],
    ['/exit', 'Quit'],
  ];
  for (const [cmd, desc] of cmds) {
    console.log('  ' + tc.warn(cmd.padEnd(18)) + tc.muted(desc));
  }
  console.log();
  console.log(chalk.bold.white('  ── 📸 Image Upload ─────────────────────────────'));
  console.log(tc.muted('  Attach a screenshot or image to the NEXT message you send.'));
  const imgCmds = [
    ['/img <path>', 'Attach a local image file (png/jpg/webp)'],
    ['/screenshot', 'Capture screen and attach automatically'],
    ['/clearimg', 'Remove the pending image attachment'],
  ];
  for (const [cmd, desc] of imgCmds) {
    console.log('  ' + tc.info(cmd.padEnd(18)) + tc.muted(desc));
  }
  console.log();
  console.log(chalk.bold.white('  ── Shell mode ─────────────────────────────────'));
  console.log(tc.muted('  cd <dir>    — change local working directory'));
  console.log(tc.muted('  !<cmd>      — force local shell execution'));
  console.log(tc.muted('  pwd, ls, git status, cat, grep, find, ...'));
  console.log();
  console.log(chalk.bold.white('  ── Auto-mode ────────────────────────────────────'));
  console.log(tc.muted('  When ON (⚡), AI tools run without confirmation.'));
  console.log(tc.muted('  When OFF (○), you approve each tool call.'));
  console.log(tc.muted('  Start with --auto flag: openbrain --auto'));
  console.log();
  // ── Themes ──
  console.log(chalk.bold.white('  ── 🎨 Themes ────────────────────────────────────'));
  for (const [name, t] of Object.entries(THEMES)) {
    const active = name === currentThemeName ? chalk.bold.white(' ◀ active') : '';
    console.log('  ' + chalk.hex(t.primary)(name.padEnd(12)) + chalk.gray(Object.values(t).slice(0, 3).join('  ')) + active);
  }
  console.log();
  if (loadedSkills.length > 0) {
    console.log(chalk.bold.white('  ── 🔌 Skills ────────────────────────────────────'));
    for (const s of loadedSkills) {
      const desc = s.description.length > 58 ? s.description.slice(0, 55) + '...' : s.description;
      console.log('  ' + tc.primary(s.name.padEnd(16)) + tc.muted(desc));
    }
    console.log();
  }
}

function handleThemeCommand(arg) {
  if (!arg) {
    console.log();
    console.log(chalk.bold.white('  Available themes:'));
    for (const [name, t] of Object.entries(THEMES)) {
      const active = name === currentThemeName ? tc.accent(' ◀ current') : '';
      const swatch = ['primary', 'accent', 'info', 'warn'].map(k => chalk.hex(t[k])('█')).join('');
      console.log(`  ${swatch}  ${chalk.hex(t.primary)(name.padEnd(12))}${active}`);
    }
    console.log();
    console.log(tc.muted('  Usage: /theme <name>'));
    console.log();
    return;
  }
  if (!THEMES[arg]) {
    console.log(tc.err(`\n  ❌ Unknown theme: ${arg}. Options: ${Object.keys(THEMES).join(', ')}\n`));
    return;
  }
  currentThemeName = arg;
  const cfg = loadConfig();
  cfg.theme = arg;
  saveConfig(cfg);
  printBanner();
  console.log(tc.accent(`  ✅ Theme set to: ${arg}\n`));
}

// ─── Shell helpers ───
function isBuiltinShellCommand(line) {
  return /^(cd|pwd|ls|tree|cat|head|tail|grep|find|wc|mkdir|rm|git|du|node|npm|which)\b/.test(line);
}

function runLocalShell(command) {
  return new Promise((resolve) => {
    exec(command, { cwd: shellCwd, shell: '/bin/bash', timeout: SHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
        resolve({ ok: !error, code: error?.code ?? 0, output: out || '(no output)', error: error?.message || null });
      });
  });
}

async function handleLocalShellInput(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  const shellLine = trimmed.startsWith('!') ? trimmed.slice(1).trim() : trimmed;
  const base = shellLine.split(/\s+/)[0];

  if (base === 'cd') {
    const target = shellLine.slice(2).trim() || os.homedir();
    const next = path.resolve(shellCwd, target);
    try {
      const stat = fs.statSync(next);
      if (!stat.isDirectory()) throw new Error('Not a directory');
      shellCwd = next;
      lastShellCommand = `cd ${target}`;
      lastShellOutput = '';
      lastShellCommandTs = Date.now();
      console.log(tc.accent(`  ➜ ${shortCwd(shellCwd)}`));
    } catch (err) { console.log(tc.err(`  cd: ${err.message}`)); }
    return true;
  }
  if (base === 'pwd') {
    lastShellCommand = 'pwd'; lastShellOutput = shellCwd;
    console.log(tc.text(`  ${shellCwd}`));
    return true;
  }
  if (trimmed.startsWith('!') || isBuiltinShellCommand(trimmed)) {
    const result = await runLocalShell(shellLine);
    lastShellCommand = shellLine;
    lastShellOutput = isNoisyCommand(shellLine) ? '' : result.output;
    lastShellCommandTs = Date.now();
    console.log(tc.secondary(result.output.split('\n').map(l => `  ${l}`).join('\n')));
    if (!result.ok) console.log(tc.err(`  [exit ${result.code}] ${result.error || ''}`));
    return true;
  }
  return false;
}

// ─── WebSocket ───
let ws = null;

const args_cli = process.argv.slice(2);
if (args_cli.includes('--auto')) autoMode = true;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: getPrompt(),
  historySize: 500,
});

// Inject saved history into readline
// (readline doesn't expose a direct API, so we pre-feed via line events)
rl.history = [...cmdHistory].reverse();

function initWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    // Sync auto-mode with backend
    ws.send(JSON.stringify({ type: 'SET_AUTO_MODE', enabled: autoMode }));
    printBanner();
    rl.prompt();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleWsMessage(msg);
    } catch (err) {
      console.error(tc.err('\n  ❌ JSON Parse error:'), err.message);
    }
  });

  ws.on('error', (err) => {
    stopSpinner();
    if (err.code === 'ECONNREFUSED') {
      console.log(tc.warn('\n  ℹ️  Backend is not running.'));
      rl.question(tc.bold('  Start it automatically? [Y/n] '), (answer) => {
        const r = answer.trim().toLowerCase();
        if (r === '' || r === 'y' || r === 'yes') startBackendAndReconnect();
        else { console.error(tc.err('\n  ❌ Start it: cd backend && node server.js\n')); process.exit(1); }
      });
    } else {
      console.error(tc.err('\n  ❌ WebSocket error:'), err.message);
      process.exit(1);
    }
  });

  ws.on('close', () => {
    stopSpinner();
    isWaiting = false;
    isStreamingReport = false;
    reportBuffer = '';
    console.log(tc.err('\n  Disconnected. Reconnecting...'));
    setTimeout(initWebSocket, 1500);
  });
}

function startBackendAndReconnect() {
  console.log(tc.muted('  Starting backend server...'));
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const backendPath = path.join(__dirname, 'backend', 'server.js');
  const child = spawn('node', [backendPath], { detached: false, stdio: 'ignore' });
  child.on('error', (err) => { console.error(tc.err(`  ❌ Failed: ${err.message}`)); process.exit(1); });
  setTimeout(() => { console.log(tc.accent('  ✅ Backend started. Connecting...')); initWebSocket(); }, 1500);
}

// ─── Message Handling ───
function handleWsMessage(msg) {
  switch (msg.type) {
    case 'AI_THINKING':
      startSpinner(msg.text || 'AI is thinking...');
      break;

    case 'TOOL_CALL_START':
      stopSpinner();
      if (reportBuffer) { cleanAndPrintReasoning(reportBuffer); reportBuffer = ''; }
      toolCallCount++;
      printToolCall(msg.tool, msg.args, toolCallCount);
      startSpinner(`Running ${msg.tool}...`);
      break;

    case 'TOOL_CALL_REQUEST': {
      stopSpinner();
      if (reportBuffer) { cleanAndPrintReasoning(reportBuffer); reportBuffer = ''; }
      console.log(tc.warn(`\n  ⚡ AI WANTS TO RUN A TOOL:`));
      console.log(tc.bold(`       ${msg.tool}`));
      console.log(tc.text(`       args: ${JSON.stringify(msg.args || {}).slice(0, 200)}`));
      rl.question(tc.accent(`  Allow? [Y/n/a (always)] `), (ans) => {
        const reply = ans.trim().toLowerCase();
        if (reply === 'n') {
          console.log(tc.err(`  Rejected.`));
          ws.send(JSON.stringify({ type: 'TOOL_APPROVAL', approve: false, remember: false }));
        } else {
          const remember = reply === 'a' || reply === 'always';
          console.log(tc.info(`  Executing${remember ? ' (always)' : ''}...`));
          ws.send(JSON.stringify({ type: 'TOOL_APPROVAL', approve: true, remember }));
        }
      });
      break;
    }

    case 'TOOL_CALL_DONE':
      stopSpinner();
      printToolDone(msg.preview, msg.isError);
      startSpinner('AI analyzing results...');
      break;

    case 'AI_STREAM':
      if (!isStreamingReport) { stopSpinner(); isStreamingReport = true; startSpinner('AI writing response...'); }
      reportBuffer += msg.text;
      break;

    case 'TOOL_ERROR_RECOVERY':
      stopSpinner();
      console.log(tc.err(`    ✗ `) + tc.err((msg.preview || 'Error').replace(/\n/g, ' ').slice(0, 70)));
      console.log(tc.warn(`  🔧 Collecting diagnostics & retrying...`));
      startSpinner('AI analyzing error...');
      break;

    case 'TOOL_INTERACTIVE_REQUEST':
      stopSpinner();
      console.log(tc.warn(`\n  ⚡ INTERACTIVE COMMAND:`));
      console.log(tc.text(`       ${msg.args.command}`));
      rl.question(tc.accent(`  Run now? [Y/n] `), (ans) => {
        if (ans.trim().toLowerCase() === 'n') {
          ws.send(JSON.stringify({ type: 'TOOL_INTERACTIVE_RESPONSE', success: false, output: 'Rejected by user.' }));
          rl.prompt();
        } else {
          rl.pause();
          const child = spawn(msg.args.command, [], { shell: true, stdio: 'inherit', cwd: shellCwd });
          child.on('close', (code) => {
            ws.send(JSON.stringify({ type: 'TOOL_INTERACTIVE_RESPONSE', success: code === 0, output: `Exit code: ${code}` }));
            rl.resume(); startSpinner('AI analyzing results...');
          });
        }
      });
      break;

    case 'FINAL_REPORT': {
      stopSpinner();
      isStreamingReport = false;
      const finalText = (msg.text || reportBuffer)
        .replace(/MCP_ACTION:\s*\{[\s\S]*?\}/g, '')
        .replace(/```json\s*\n?MCP_ACTION[\s\S]*?```/g, '')
        .replace(/\[TOOL RESULT:[\s\S]*?\[END TOOL RESULT\]/g, '')
        .replace(/Continue your analysis\..*$/gm, '')
        .replace(/\n{3,}/g, '\n\n').trim();
      reportBuffer = '';
      printFinalReport(finalText, toolCallCount);
      // Save to session log
      sessionLog.push({ role: 'assistant', text: finalText, ts: new Date().toISOString() });
      toolCallCount = 0; isWaiting = false;
      rl.prompt();
      break;
    }

    case 'AI_COMPLETE':
      if (reportBuffer) {
        stopSpinner(); isStreamingReport = false;
        const cleaned = reportBuffer.replace(/MCP_ACTION:\s*\{[\s\S]*?\}/g, '').replace(/\n{3,}/g, '\n\n').trim();
        printFinalReport(cleaned, toolCallCount);
        reportBuffer = '';
      } else { stopSpinner(); }
      toolCallCount = 0; isWaiting = false;
      rl.prompt();
      break;

    case 'STATUS':
      stopSpinner();
      // Track extension connection state from backend notifications
      if (msg.text && msg.text.includes('extension')) {
        extensionConnected = msg.text.includes('connected') && !msg.text.includes('NOT connected') && !msg.text.includes('disconnected');
      }
      console.log(tc.info(`\n  ℹ️  ${msg.text}`));
      rl.prompt();
      break;

    case 'ERROR':
      stopSpinner(); isStreamingReport = false; reportBuffer = '';
      console.log();
      console.log(tc.err(`  ❌ ${msg.text}`));
      console.log();
      isWaiting = false; rl.prompt();
      break;
  }
}

initWebSocket();

// ─── Input Handling ───
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) { rl.prompt(); return; }

  // ── Built-in commands ──
  if (text === '/exit' || text === 'exit') { saveSession(); rl.close(); return; }
  if (text === '/clear') { printBanner(); rl.prompt(); return; }
  if (text === '/help') { printHelp(); rl.prompt(); return; }

  if (text.startsWith('/theme')) {
    handleThemeCommand(text.split(/\s+/)[1]);
    rl.setPrompt(getPrompt());
    rl.prompt();
    return;
  }

  if (text === '/resetctx') {
    lastShellCommand = '';
    lastShellOutput = '';
    lastShellCommandTs = 0;
    console.log(tc.accent('\n  ✅ Shell context cleared. AI will not see previous command output.\n'));
    rl.prompt();
    return;
  }

  if (text === '/auto') {
    autoMode = !autoMode;
    ws.send(JSON.stringify({ type: 'SET_AUTO_MODE', enabled: autoMode }));
    console.log(autoMode
      ? tc.accent('\n  ⚡ Auto-mode ON — tools run without approval\n')
      : tc.warn('\n  ○ Auto-mode OFF — you approve each tool\n'));
    rl.setPrompt(getPrompt());
    rl.prompt();
    return;
  }

  if (text === '/history') {
    console.log();
    const recent = cmdHistory.slice(-20);
    recent.forEach((l, i) => console.log(tc.secondary(`  ${String(i + 1).padStart(3)}.`) + ' ' + tc.text(l)));
    console.log();
    rl.prompt();
    return;
  }

  if (text === '/sessions') {
    console.log();
    const list = listSessions();
    if (list.length === 0) console.log(tc.muted('  No sessions saved yet.'));
    else list.forEach(l => console.log(l));
    console.log();
    rl.prompt();
    return;
  }

  if (text === '/save') {
    const file = saveSession();
    console.log(file ? tc.accent(`\n  ✅ Session saved: ${file}\n`) : tc.err('\n  Nothing to save.\n'));
    rl.prompt();
    return;
  }

  if (text === '/context') {
    console.log(tc.muted('\n  Building project context...'));
    const ctx = await buildProjectContext();
    console.log(ctx ? tc.secondary(ctx) : tc.muted('  (no context available)'));
    console.log();
    rl.prompt();
    return;
  }

  if (text === '/skills') {
    console.log();
    if (loadedSkills.length === 0) {
      console.log(tc.muted('  No skills loaded.'));
      console.log(tc.muted('  Add skills with: npx skills add <repo-url> --skill <name>'));
    } else {
      console.log(chalk.bold.white('  ── 🔌 Loaded Skills ─────────────────────────────'));
      for (const s of loadedSkills) {
        console.log('  ' + tc.bold(s.name));
        console.log(tc.secondary('    ' + s.description));
        console.log(tc.muted('    📄 ' + s.path));
      }
    }
    console.log();
    rl.prompt();
    return;
  }

  // ── Image commands ──
  if (text.startsWith('/img ') || text.startsWith('/image ')) {
    const imgPath = text.replace(/^\/img(age)?\s+/, '').trim();
    const resolved = imgPath.startsWith('~')
      ? imgPath.replace('~', os.homedir())
      : path.resolve(shellCwd, imgPath);
    try {
      const buf = fs.readFileSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
      pendingImage = { path: resolved, b64: buf.toString('base64'), type: mimeMap[ext] || 'image/png' };
      console.log(tc.accent(`\n  📸 Image attached: ${resolved}`));
      console.log(tc.muted(`     ${Math.round(buf.length / 1024)} KB — will be sent with your next message.\n`));
    } catch (err) {
      console.log(tc.err(`\n  ❌ Could not read image: ${err.message}\n`));
    }
    rl.prompt(); return;
  }

  if (text === '/screenshot') {
    const shotPath = `/tmp/openbrain-shot-${Date.now()}.png`;
    console.log(tc.muted('\n  📸 Taking screenshot...'));
    await runLocalShell(
      `scrot '${shotPath}' 2>/dev/null || ` +
      `import -window root '${shotPath}' 2>/dev/null || ` +
      `gnome-screenshot -f '${shotPath}' 2>/dev/null`
    );
    if (fs.existsSync(shotPath)) {
      const buf = fs.readFileSync(shotPath);
      pendingImage = { path: shotPath, b64: buf.toString('base64'), type: 'image/png' };
      console.log(tc.accent(`  ✅ Screenshot ready (${Math.round(buf.length / 1024)} KB) — send your next message to include it.\n`));
    } else {
      console.log(tc.err('  ❌ Screenshot failed. Try: sudo apt install scrot\n'));
    }
    rl.prompt(); return;
  }

  if (text === '/img' || text === '/image') {
    if (pendingImage) {
      console.log(tc.accent(`\n  📸 Pending: ${pendingImage.path} (${Math.round(pendingImage.b64.length * 0.75 / 1024)} KB)\n`));
    } else {
      console.log(tc.muted('\n  No image pending. Use /img <path> or /screenshot\n'));
    }
    rl.prompt(); return;
  }

  if (text === '/clearimg') {
    pendingImage = null;
    console.log(tc.warn('\n  🗑️  Image cleared.\n'));
    rl.prompt(); return;
  }

  // ── Shell commands ──
  if (await handleLocalShellInput(text)) {
    rl.setPrompt(getPrompt());
    rl.prompt();
    return;
  }

  if (isWaiting) {
    console.log(tc.secondary('  ⏳ Waiting for AI...'));
    rl.prompt();
    return;
  }

  // ── Send to AI ──
  saveHistory(text);
  sessionLog.push({ role: 'user', text, ts: new Date().toISOString() });

  console.log();
  isWaiting = true;
  toolCallCount = 0;
  reportBuffer = '';
  isStreamingReport = false;

  // Build context-enriched prompt
  startSpinner('Building project context...');
  const ctx = await buildProjectContext();
  stopSpinner();

  const skillsCtx = buildSkillsContext();

  const shellCtxFresh = (Date.now() - lastShellCommandTs) < SHELL_CTX_TTL_MS;
  const metaCtx = [
    `[Working directory: ${CWD}]`,
    `[Shell cwd: ${shellCwd}]`,
    `[Project: ${PROJECT_NAME}]`,
    (shellCtxFresh && lastShellCommand && !isNoisyCommand(lastShellCommand)) ? `[Last shell command: ${lastShellCommand}]` : null,
    (shellCtxFresh && lastShellOutput) ? `[Last shell output: ${lastShellOutput.slice(0, 500)}]` : null,
    pendingImage ? `[📸 Screenshot attached — analyze it carefully to help debug]` : null,
  ].filter(Boolean).join('\n');

  // User request goes FIRST so the AI acts on it, context follows as background
  const contextualPrompt =
    `USER REQUEST: ${text}\n\n` +
    `[Background context — do NOT re-acknowledge, just use when helpful]\n` +
    metaCtx + ctx + skillsCtx;

  const promptMsg = {
    type: 'PROMPT',
    text: contextualPrompt,
    cwd: CWD,
    project: PROJECT_NAME,
    shellCwd,
    shellMetadata: (shellCtxFresh && !isNoisyCommand(lastShellCommand))
      ? { lastShellCommand, lastShellOutput: lastShellOutput.slice(0, 2000) }
      : {},
  };
  if (pendingImage) {
    promptMsg.image_b64 = pendingImage.b64;
    promptMsg.image_type = pendingImage.type;
    promptMsg.image_path = pendingImage.path;
    console.log(tc.info(`  📸 Sending image (${Math.round(pendingImage.b64.length * 0.75 / 1024)} KB) with prompt...`));
    pendingImage = null;
  }
  ws.send(JSON.stringify(promptMsg));
  startSpinner('Waiting for AI...');
});

rl.on('close', () => { saveSession(); ws.close(); process.exit(0); });

process.on('SIGINT', () => { stopSpinner(); saveSession(); console.log(chalk.gray('\n  Saving session & exiting...')); process.exit(0); });
