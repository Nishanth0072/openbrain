import express from "express";
import bodyParser from "body-parser";
import chalk from "chalk";
import { WebSocketServer } from "ws";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import path from 'path';
import { exec } from 'child_process';
import { MyMcpClient } from "./mcp-client.js";
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_FILE = join(__dirname, 'bridge.log');
const MAX_TOOL_CALLS = 50;
let globalAutoMode = false; // set true by CLI to skip all approval prompts

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

// ─── File Logger ───
function log(msg) {
  const clean = msg.replace(/\x1b\[[0-9;]*m/g, '');
  const timestamped = `[${new Date().toISOString()}] ${clean}\n`;

  try {
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > MAX_LOG_SIZE) {
        // Truncate file if too big
        fs.writeFileSync(LOG_FILE, `[Log truncated at ${new Date().toISOString()}]\n`);
      }
    }
    fs.appendFileSync(LOG_FILE, timestamped);
  } catch (e) {
    process.stderr.write(chalk.red(`[bridge] Failed to write log: ${e.message}\n`));
  }

  process.stderr.write(chalk.gray(`[bridge] `) + msg + '\n');
}

// ─── Express App ───
const app = express();
const PORT = 3000;

// CORS + Private Network Access headers
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,Content-Type,Access-Control-Allow-Private-Network,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// ─── MCP Client ───
const mcpClient = new MyMcpClient();

// ─── WebSocket Server ───
const wss = new WebSocketServer({ noServer: true });

let cliSocket = null;
const extensionSockets = new Set();
let activeExtensionSocket = null; // The most recently active/connected extension

// ─── Agentic Session State ───
// States: IDLE | WAITING_FOR_AI | TOOL_RUNNING
let session = {
  state: 'IDLE',
  toolCallCount: 0,
  fullReport: '',   // accumulates ALL reasoning across turns
  cwd: process.cwd(),
  project: '',
  shellCwd: process.cwd(),
  shellMetadata: {},
  pendingTool: null,
  approvedTools: new Set(),
  approvalTimer: null,
};

function sendToCli(msg) {
  if (cliSocket?.readyState === 1) {
    cliSocket.send(JSON.stringify(msg));
  }
}

function sendToExtension(msg) {
  if (activeExtensionSocket?.readyState === 1) {
    activeExtensionSocket.send(JSON.stringify(msg));
    log(chalk.cyan(`[Relay] Message sent to extension: ${msg.type}`));
  } else {
    // Try other available sockets if the active one failed
    for (const ws of extensionSockets) {
      if (ws.readyState === 1) {
        activeExtensionSocket = ws;
        ws.send(JSON.stringify(msg));
        log(chalk.cyan(`[Relay] Message sent to alternate extension: ${msg.type}`));
        return;
      }
    }
    log(chalk.red(`[Relay] Failed to send ${msg.type}: No active extension connection`));
  }
}

function resetSession() {
  if (session.approvalTimer) {
    clearTimeout(session.approvalTimer);
  }
  session = {
    state: 'IDLE',
    toolCallCount: 0,
    fullReport: '',
    cwd: session.cwd,
    project: session.project,
    shellCwd: session.shellCwd,
    shellMetadata: session.shellMetadata,
    pendingTool: null,
    approvedTools: session.approvedTools || new Set(),
    approvalTimer: null,
  };
}

// ─── Server-side code block extractor ───
// Parses markdown code fences from the AI full response and writes files via MCP.
// Completely bypasses DOM scraping and Chrome extension reload requirements.
async function extractAndWriteCodeBlocks(text, cwd) {
  if (!text || !cwd) return [];
  const written = [];
  const seen    = new Set();
  const DANGER  = /\brm\s+-rf\s*\/|mkfs|dd\s+if=|shutdown|reboot|:\(\)/;

  // Match ```lang [optional_filename]\ncontent\n```
  const fenceRe = /```([\w-]*)(?:[ \t]+([^\n]+))?\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    const lang    = (m[1] || '').toLowerCase().trim();
    const extra   = (m[2] || '').trim();
    const content = m[3];
    if (!content.trim()) continue;

    // Bash blocks: run safe shell commands
    if (['bash','sh','shell','zsh','console','terminal'].includes(lang)) {
      const cmdLines = content.split('\n').filter(l => { const t=l.trim(); return t && !t.startsWith('#'); });
      if (!cmdLines.length) continue;
      const command = cmdLines.join('\n');
      if (DANGER.test(command)) { log(chalk.red(`[CodeExtract] Blocked: ${command}`)); continue; }
      const key = `RUN:${command.slice(0,120)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      log(chalk.cyan(`[CodeExtract] Auto-run: ${command}`));
      try { await mcpClient.callTool('run_terminal', { command }); } catch (_) {}
      continue;
    }

    // Code files: detect filename then write
    const lines     = content.split('\n');
    const firstLine = lines[0].trim();
    const fnMatch   = firstLine.match(/^(?:\/\/|#|<!--|\/\*)\s*filename:\s*([\w.\/-]+)(?:\s*-->|\s*\*\/)?/i);
    const saveMatch = firstLine.match(/^(?:\/\*\s*SAVE:\s*(.+?)\s*\*\/|<!--\s*SAVE:\s*(.+?)\s*-->|\/\/\s*SAVE:\s*(\S+)|#\s*SAVE:\s*(\S+))$/i);

    let filePath = null, fileContent = content;
    const extraPathMatch = extra.match(/([a-zA-Z0-9_.\/-]+\.[a-zA-Z0-9]+)/);

    if (saveMatch) {
      const fp = (saveMatch[1]||saveMatch[2]||saveMatch[3]||saveMatch[4]||'').trim();
      filePath = fp.startsWith('/') ? fp : `${cwd}/${fp}`;
      fileContent = lines.slice(1).join('\n');
    } else if (extraPathMatch) {
      const hint = extraPathMatch[1];
      filePath = hint.startsWith('/') ? hint : `${cwd}/${hint}`;
      fileContent = content;
    } else if (fnMatch) {
      const hint = fnMatch[1].trim();
      filePath = hint.startsWith('/') ? hint : `${cwd}/${hint}`;
      fileContent = lines.slice(1).join('\n');
    } else {
      // Auto-infer from language + content patterns
      const isHtml = lang==='html' || content.includes('<!DOCTYPE') || (content.includes('<html') && content.includes('</html>'));
      const isCss  = lang==='css'  || (!['javascript','js','typescript','ts'].includes(lang) && content.includes('{') && /[a-z-]+\s*:\s*[^{]+;/.test(content) && !content.trim().startsWith('{'));
      const isJs   = ['javascript','js','typescript','ts'].includes(lang);
      const isPy   = ['python','py'].includes(lang);
      const isJson = lang==='json' || (content.trim().startsWith('{') && content.trim().endsWith('}') && !isCss && !isJs);
      let fname = isHtml ? 'index.html' : isCss ? 'style.css' : isJs ? 'app.js' : isPy ? 'main.py' : isJson ? 'data.json' : null;
      if (!fname) continue;
      filePath = `${cwd}/${fname}`;
    }

    if (!filePath || !fileContent.trim()) continue;
    const fileKey = `FILE:${filePath}`;
    if (seen.has(fileKey)) continue;
    seen.add(fileKey);

    const dir = path.dirname(filePath);
    try {
      await mcpClient.callTool('run_terminal', { command: `mkdir -p "${dir}"` });
      await mcpClient.callTool('write_file',   { path: filePath, content: fileContent });
      written.push(filePath);
      log(chalk.green(`[CodeExtract] ✅ ${filePath} (${fileContent.length}c)`));
    } catch (e) {
      log(chalk.red(`[CodeExtract] ❌ ${filePath}: ${e.message}`));
    }
  }
  return written;
}

// ─── Strip protocol noise from text before storing ───
function cleanText(text) {
  return text
    .replace(/MCP_ACTION:\s*\{[\s\S]*?\}/g, '')
    .replace(/\[TOOL RESULT:[\s\S]*?\[END TOOL RESULT\]/g, '')
    .replace(/Continue your analysis\..*?(?:\n|$)/g, '')
    .replace(/If you (?:need|have).*?MCP_ACTION.*?(?:\n|$)/g, '');
}

// ─── Shared Message Logic (Used by both WS and HTTP) ───
async function handleExtensionMessage(msg, source = 'WS') {
  // ── Handle Logs from browser ──
  if (msg.type === "LOG") {
    const { level, text, msg: legacyMsg, tool } = msg;
    const content = text || legacyMsg || '';
    const tag = tool ? `[Tool:${tool}]` : '';
    const color = level === 'error' ? chalk.red : level === 'warn' ? chalk.yellow : chalk.gray;
    log(color(`[Browser:${level}]${tag} (${source}) ${content}`));
    return;
  }

  // ── AI is streaming text ──
  if (msg.type === "AI_STREAM") {
    if (session.state !== 'IDLE') {
      log(chalk.gray(`[Relay] Stream received (${source}, ${msg.text.length} chars)`));
      const cleaned = cleanText(msg.text);
      if (cleaned.trim()) {
        session.fullReport += cleaned;
      }
      sendToCli({ type: 'AI_STREAM', text: msg.text });
    } else {
      log(chalk.gray(`[Relay] AI_STREAM ignored — session state is '${session.state}'`));
    }
  }

  // ── AI finished a turn ──
  else if (msg.type === "AI_COMPLETE") {
    log(chalk.green(`[Relay] AI_COMPLETE received (${source}, turns: ${session.toolCallCount + 1}, state: ${session.state})`));
    if (session.state === 'TOOL_RUNNING') {
      log(chalk.yellow(`[Session] AI_COMPLETE ignored — tool is still running`));
    } else if (session.state === 'WAITING_FOR_AI') {
      log(chalk.green(`[Session] Final answer after ${session.toolCallCount} tool calls`));
      const finalText = session.fullReport;
      const writeCwd   = session.shellCwd || session.cwd;

      // ─── SERVER-SIDE CODE BLOCK EXTRACTOR ───
      // Use the raw markdown from the extension (preserves code fences) if available,
      // otherwise fall back to the streamed fullReport text.
      const extractSource = msg.rawMarkdown || finalText;
      const written = await extractAndWriteCodeBlocks(extractSource, writeCwd);
      if (written.length > 0) {
        log(chalk.green(`[CodeExtract] Wrote ${written.length} file(s): ${written.join(', ')}}`));
        sendToCli({ type: 'TOOL_RESULT', tool: 'write_file', result: `✅ Files saved:\n${written.join('\n')}` });

        // ─── AUTO-VERIFICATION ───
        // Verify syntax of each written file that has a supported extension
        const VERIFIABLE_EXTS = ['.js', '.mjs', '.ts', '.py', '.json', '.html', '.htm', '.css'];
        const verifyResults = [];
        for (const filePath of written) {
          const ext = path.extname(filePath).toLowerCase();
          if (!VERIFIABLE_EXTS.includes(ext)) continue;
          try {
            const result = await mcpClient.callTool('verify_file', { path: filePath });
            const resultText = result.content ? result.content.map(c => c.text).join('\n') : '';
            const isError = result.isError || false;
            if (isError) {
              verifyResults.push(`⚠️ ${filePath}: ${resultText}`);
              log(chalk.yellow(`[Verify] FAILED: ${filePath} — ${resultText.slice(0, 100)}`));
            } else {
              verifyResults.push(`✅ ${filePath}: OK`);
              log(chalk.green(`[Verify] OK: ${filePath}`));
            }
          } catch (e) {
            log(chalk.yellow(`[Verify] Skipped ${filePath}: ${e.message}`));
          }
        }
        if (verifyResults.length > 0) {
          const hasErrors = verifyResults.some(r => r.startsWith('⚠️'));
          sendToCli({
            type: 'TOOL_RESULT',
            tool: 'verify_file',
            result: `${hasErrors ? '⚠️' : '✅'} Auto-verification:\n${verifyResults.join('\n')}`,
          });
        }
      }

      resetSession();
      sendToCli({ type: 'FINAL_REPORT', text: finalText });
    } else {
      log(chalk.gray(`[Session] AI_COMPLETE ignored — session is IDLE`));
    }
  }

  // ── AI wants to call a tool ──
  else if (msg.type === "MCP_ACTION") {
    if (session.state === 'IDLE') {
      log(chalk.yellow(`[Session] MCP_ACTION received but session is IDLE — ignoring (no active request)`));
      return;
    }

    if (session.state === 'TOOL_RUNNING') {
      log(chalk.yellow(`[Session] MCP_ACTION for '${msg.tool}' received while TOOL_RUNNING — likely duplicate, ignoring`));
      return;
    }

    if (session.toolCallCount >= MAX_TOOL_CALLS) {
      log(chalk.red(`[Session] Hit max tool calls (${MAX_TOOL_CALLS})`));
      const finalText = session.fullReport || 'Maximum tool iterations reached.';
      resetSession();
      sendToCli({ type: 'FINAL_REPORT', text: finalText });
      return;
    }

    session.pendingTool = {
      tool: msg.tool,
      args: msg.args,
      source,
    };
    
    // Check if tool was previously approved OR auto-mode is on
    if (globalAutoMode || (session.approvedTools && session.approvedTools.has(msg.tool))) {
      log(chalk.yellow(`[Tool] Auto-executing${globalAutoMode ? ' (auto-mode)' : ' (remembered)'}: ${msg.tool}`));
      await executePendingTool();
    } else {
      log(chalk.yellow(`[Tool] Requesting approval for: ${msg.tool}`));
      session.state = 'WAITING_FOR_APPROVAL';
      sendToCli({ type: 'TOOL_CALL_REQUEST', tool: msg.tool, args: msg.args, source });
    }
    return;
  }
}

// ─── Diagnostic snapshot gathered on tool errors ───
function collectDiagnostics(cwd) {
  return new Promise((resolve) => {
    const lines = [];
    let done = 0;
    const tryDone = () => { if (++done === cmds.length) resolve(lines.join('\n')); };

    const cmds = [
      { label: 'cwd',        cmd: 'pwd' },
      { label: 'ls',         cmd: 'ls -la 2>&1 | head -30' },
      { label: 'PATH',       cmd: 'echo "PATH=$PATH"' },
      { label: 'python',     cmd: 'which python3 2>/dev/null || which python 2>/dev/null || echo "(python not found)"' },
      { label: 'node',       cmd: 'node --version 2>&1' },
      { label: 'npm',        cmd: 'npm --version 2>&1' },
      { label: 'disk',       cmd: 'df -h . 2>&1 | tail -1' },
      { label: 'processes',  cmd: 'ps aux 2>&1 | grep -v grep | grep -E "node|python|npm|server" | head -10' },
    ];

    for (const { label, cmd } of cmds) {
      exec(cmd, { cwd, timeout: 5000 }, (err, stdout, stderr) => {
        const out = (stdout || stderr || '').trim();
        if (out) lines.push(`[${label}]: ${out}`);
        tryDone();
      });
    }
  });
}

async function executePendingTool() {
  const pending = session.pendingTool;
  if (!pending) return;

  session.pendingTool = null;
  if (session.approvalTimer) {
    clearTimeout(session.approvalTimer);
    session.approvalTimer = null;
  }
  session.state = 'TOOL_RUNNING';
  session.toolCallCount++;

  log(chalk.yellow(`[Tool #${session.toolCallCount}] ${pending.tool} (${pending.source}) args=${JSON.stringify(pending.args)}`));
  sendToCli({ type: 'TOOL_CALL_START', tool: pending.tool, args: pending.args, source: pending.source });

  if (pending.tool === 'ask_permission_and_run') {
    log(chalk.cyan(`[Interactive] Sending interactive command request to CLI...`));
    session.activeInteractiveTool = pending;
    sendToCli({ type: 'TOOL_INTERACTIVE_REQUEST', tool: pending.tool, args: pending.args, source: pending.source });
    return; // Do not call mcpClient
  }

  try {
    log(chalk.cyan(`[MCP] Calling tool: ${pending.tool}...`));
    const result = await mcpClient.callTool(pending.tool, pending.args);
    const resultText = result.content
      ? result.content.map(c => c.text).join('\n')
      : JSON.stringify(result);
    const isError = result.isError || false;

    const preview = resultText.replace(/\n/g, ' ').slice(0, 100) + (resultText.length > 100 ? '...' : '');
    log(isError ? chalk.red(`[Tool] Error result: ${pending.tool}`) : chalk.green(`[Tool] Done: ${pending.tool} → ${resultText.length} chars`));
    sendToCli({ type: 'TOOL_CALL_DONE', preview, isError });

    session.state = 'WAITING_FOR_AI';
    log(chalk.cyan(`[Session] State → WAITING_FOR_AI (tool #${session.toolCallCount} complete)`));

    if (isError) {
      // Gather diagnostic context so AI can self-heal
      log(chalk.yellow(`[Recovery] Tool ${pending.tool} returned error — collecting diagnostics...`));
      sendToCli({ type: 'TOOL_ERROR_RECOVERY', tool: pending.tool, preview });
      let diag = '';
      try { diag = await collectDiagnostics(session.shellCwd || session.cwd || process.cwd()); } catch (de) { diag = `(diagnostics failed: ${de.message})`; }
      const enriched =
        `❌ TOOL ERROR in '${pending.tool}':\n${resultText}\n\n` +
        `--- DIAGNOSTIC CONTEXT (auto-collected) ---\n${diag}\n` +
        `--- END DIAGNOSTICS ---\n\n` +
        `Analyze the error above. Fix and retry with the correct tool call. Do NOT ask the user.`;
      sendToExtension({ type: 'MCP_RESULT', tool: pending.tool, text: enriched, callNum: session.toolCallCount, isError: true });
    } else {
      sendToExtension({ type: 'MCP_RESULT', tool: pending.tool, text: resultText, callNum: session.toolCallCount });
    }

  } catch (err) {
    log(chalk.red(`[Tool] Exception in ${pending.tool}: ${err.message}`));
    session.state = 'WAITING_FOR_AI';
    log(chalk.cyan(`[Session] State → WAITING_FOR_AI (exception recovery)`));

    // Gather diagnostics — wrapped so a crash here can't block the MCP_RESULT
    let diag = '';
    try { diag = await collectDiagnostics(session.shellCwd || session.cwd || process.cwd()); } catch (de) { diag = `(diagnostics failed: ${de.message})`; }
    const enriched =
      `❌ EXCEPTION in '${pending.tool}':\n${err.message}\n\n` +
      `--- DIAGNOSTIC CONTEXT (auto-collected) ---\n${diag}\n` +
      `--- END DIAGNOSTICS ---\n\n` +
      `Analyze the error above. Fix and retry with the correct tool call. Do NOT ask the user.`;

    sendToCli({ type: 'TOOL_CALL_DONE', preview: `Error: ${err.message}`, isError: true });
    sendToExtension({ type: 'MCP_RESULT', tool: pending.tool, text: enriched, callNum: session.toolCallCount, isError: true });
  }
}

// ─── Extension status endpoint (used by CLI on connect) ───
app.get("/extension-status", (req, res) => {
  const hasWs = [...extensionSockets].some(ws => ws.readyState === 1);
  res.json({ connected: hasWs, count: extensionSockets.size });
});

// ─── WebSocket Connection Handler ───
wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url.replace(/^[^?]*/, ''));
  const type = params.get('type') || 'extension';
  log(chalk.magenta(`[WS] ${type} connected`));

  // Only accept known types
  if (type !== 'cli' && type !== 'extension') {
    log(chalk.yellow(`[WS] Rejecting unknown connection type: ${type}`));
    ws.close(4001, 'Unknown connection type');
    return;
  }

  if (type === "cli") {
    cliSocket = ws;
    // Notify CLI of extension status on connect
    const hasExtension = [...extensionSockets].some(s => s.readyState === 1);
    sendToCli({ type: 'STATUS', text: hasExtension
      ? '🔌 Browser extension connected ✓'
      : '⚠️  Browser extension NOT connected — open ChatGPT/Claude/Gemini in Chrome with the extension loaded'
    });

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        log(chalk.red(`[WS] Error parsing message from CLI: ${err.message}`));
        return;
      }

      if (msg.type === "PROMPT") {
        log(chalk.blue(`[CLI→AI] "${(msg.text || '').slice(0, 80)}..."`));
        if (!activeExtensionSocket || activeExtensionSocket.readyState !== 1) {
          // Check if any extension is alive
          const alive = [...extensionSockets].find(ws => ws.readyState === 1);
          if (alive) {
            activeExtensionSocket = alive;
          } else {
            log(chalk.red(`[Session] No browser extension connected — cannot relay prompt`));
            sendToCli({
              type: 'ERROR',
              text: '🔌 Browser extension not connected!\n\n  To fix: Open Chrome → go to ChatGPT/Claude/Gemini → make sure the Open Brain extension is loaded and active.\n  Then try your command again.',
            });
            return;
          }
        }

        // Store context from CLI
        session.cwd = msg.cwd || session.cwd;
        session.project = msg.project || session.project;
        session.shellCwd = msg.shellCwd || session.shellCwd || session.cwd;
        session.shellMetadata = msg.shellMetadata || session.shellMetadata || {};

        const shellContext = [
          `[Working directory: ${session.cwd}]`,
          `[Shell cwd: ${session.shellCwd}]`,
          `[Project: ${session.project}]`,
          session.shellMetadata?.lastShellCommand ? `[Last shell command: ${session.shellMetadata.lastShellCommand}]` : null,
          session.shellMetadata?.lastShellOutput ? `[Last shell output: ${session.shellMetadata.lastShellOutput}]` : null,
        ].filter(Boolean).join('\n');

        const contextualPrompt = `${shellContext}\n\n${msg.text}`;

        log(chalk.blue(`[CLI→AI] "${msg.text.slice(0, 80)}..."`));
        session = {
          state: 'WAITING_FOR_AI',
          toolCallCount: 0,
          fullReport: '',
          cwd: session.cwd,
          project: session.project,
          shellCwd: session.shellCwd,
          shellMetadata: session.shellMetadata,
          pendingTool: null,
          approvedTools: session.approvedTools || new Set(),
          approvalTimer: null,
        };

        sendToCli({ type: 'AI_THINKING', text: 'AI is thinking...' });

        // ── Auto-sync MCP server cwd so write_file uses the user's project dir ──
        const targetCwd = session.shellCwd || session.cwd;
        if (targetCwd) {
          try {
            await mcpClient.callTool('set_cwd', { path: targetCwd });
            log(chalk.cyan(`[MCP] set_cwd → ${targetCwd}`));
          } catch (e) {
            log(chalk.yellow(`[MCP] set_cwd failed (non-fatal): ${e.message}`));
          }
        }

        const extPrompt = {
          type: 'SEND_PROMPT',
          text: contextualPrompt,
          cwd: session.shellCwd || session.cwd,
          project: session.project,
        };
        if (msg.image_b64) {
          extPrompt.image_b64  = msg.image_b64;
          extPrompt.image_type = msg.image_type || 'image/png';
          extPrompt.image_path = msg.image_path || 'image';
          log(chalk.cyan(`[Image] Relaying image to extension — ${Math.round(msg.image_b64.length * 0.75 / 1024)} KB`));
        }
        sendToExtension(extPrompt);
      } else if (msg.type === "TOOL_APPROVAL") {
        if (session.state !== 'WAITING_FOR_APPROVAL' || !session.pendingTool) {
          log(chalk.yellow(`[Approval] Ignored unexpected approval message`));
          return;
        }

        if (msg.approve) {
          if (msg.remember && session.pendingTool?.tool) {
            session.approvedTools.add(session.pendingTool.tool);
            log(chalk.green(`[Approval] Remembering approval for tool: ${session.pendingTool.tool}`));
          }
          log(chalk.green(`[Approval] Tool approved by user`));
          await executePendingTool();
        } else {
          // Reject
          session.state = 'WAITING_FOR_AI';
          sendToExtension({
            type: 'MCP_RESULT',
            tool: session.pendingTool.tool,
            text: `Error: tool call denied by user`,
            callNum: session.toolCallCount,
            isError: true,
          });
          session.pendingTool = null;
        }
      } else if (msg.type === "TOOL_INTERACTIVE_RESPONSE") {
        if (session.state !== 'TOOL_RUNNING' || !session.activeInteractiveTool) return;
        const pending = session.activeInteractiveTool;
        session.activeInteractiveTool = null;
        
        const preview = msg.output.replace(/\n/g, ' ').slice(0, 100);
        log(msg.success ? chalk.green(`[Interactive] Done: ${preview}`) : chalk.red(`[Interactive] Failed: ${preview}`));
        sendToCli({ type: 'TOOL_CALL_DONE', preview, isError: !msg.success });
        
        session.state = 'WAITING_FOR_AI';
        sendToExtension({ type: 'MCP_RESULT', tool: pending.tool, text: msg.output, callNum: session.toolCallCount, isError: !msg.success });
      } else if (msg.type === "SET_AUTO_MODE") {
        globalAutoMode = !!msg.enabled;
        log(chalk.cyan(`[Config] Auto-mode ${globalAutoMode ? 'ENABLED' : 'DISABLED'}`));
        sendToCli({ type: 'STATUS', text: `Auto-mode ${globalAutoMode ? '✅ ON — tools run without approval' : '⏸️ OFF — approval required'}` });
      }
    });

    ws.on("close", () => {
      cliSocket = null;
      log(chalk.magenta("[WS] CLI disconnected"));
    });

  } else {
    // Extension connection
    extensionSockets.add(ws);
    activeExtensionSocket = ws;

    ws.on("message", async (data) => {
      const dataStr = data.toString();
      // Whenever we get a message from an extension, mark it as active
      if (type === "extension") activeExtensionSocket = ws;

      try {
        const msg = JSON.parse(dataStr);
        await handleExtensionMessage(msg, 'WS');
      } catch (e) {
        log(chalk.red(`[WS] Error handling message: ${e.message}`));
      }
    });

    ws.on("close", () => {
      extensionSockets.delete(ws);
      if (activeExtensionSocket === ws) {
        activeExtensionSocket = [...extensionSockets].find(w => w.readyState === 1) || null;
      }
      log(chalk.magenta("[WS] Extension disconnected"));
      // Notify CLI that extension dropped
      const remaining = [...extensionSockets].filter(s => s.readyState === 1).length;
      if (remaining === 0) {
        sendToCli({ type: 'STATUS', text: '⚠️  Browser extension disconnected — commands will not work until it reconnects' });
      }
    });
  }
});

// ─── REST Endpoints ───
app.get("/info", async (req, res) => {
  try {
    const tools = await mcpClient.listTools();
    res.json({ status: "online", tools });
  } catch (e) {
    res.json({ status: "offline", error: e.message });
  }
});

app.post("/register", (req, res) => {
  log(chalk.cyan(`✨ Extension active on: ${req.body.url || 'unknown'}`));
  res.json({ success: true });
});

app.post("/mcp-action", async (req, res) => {
  try {
    await handleExtensionMessage({ type: 'MCP_ACTION', ...req.body }, 'HTTP');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WRITE_FILE endpoint ───────────────────────────────────────────────────
// Receives a base64-encoded file from the extension WRITE_FILE block parser.
// Decodes it in Node (no JSON escaping issues) then routes through the normal
// MCP tool pipeline exactly like an MCP_ACTION write_file call.
app.post("/write-file", async (req, res) => {
  const { path: filePath, content_b64 } = req.body;
  if (!filePath || !content_b64) {
    return res.status(400).json({ error: 'path and content_b64 required' });
  }
  // Acknowledge immediately so the extension fetch doesn't hang
  res.json({ received: true });

  let content;
  try {
    content = Buffer.from(content_b64, 'base64').toString('utf-8');
  } catch (e) {
    log(chalk.red(`[write-file] Base64 decode error: ${e.message}`));
    return;
  }

  log(chalk.cyan(`[write-file] ${filePath} — ${content.length} chars`));

  // Route through the normal agentic pipeline as a synthetic write_file tool call
  await handleExtensionMessage({
    type: 'MCP_ACTION',
    tool: 'write_file',
    args: { path: filePath, content },
  }, 'WRITE_FILE');
});

app.post("/ai-stream", async (req, res) => {
  try {
    await handleExtensionMessage({ type: 'AI_STREAM', ...req.body }, 'HTTP');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/ai-complete", async (req, res) => {
  try {
    await handleExtensionMessage({ type: 'AI_COMPLETE', ...req.body }, 'HTTP');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/log", async (req, res) => {
  try {
    await handleExtensionMessage({ type: 'LOG', ...req.body }, 'HTTP');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start Server ───
const server = app.listen(PORT, () => {
  const startMsg = `Bridge server on http://localhost:${PORT}  (log: ${LOG_FILE})`;
  log(chalk.green(startMsg));

  console.log(chalk.bold.green('\n  ┌' + '─'.repeat(50) + '┐'));
  console.log(chalk.bold.green('  │') + chalk.bold.white('  🚀 MCP Bridge Backend  —  Port ' + PORT + '             ') + chalk.bold.green('│'));
  console.log(chalk.bold.green('  │') + chalk.gray('  Waiting for CLI (node cli.js) + extension...  ') + chalk.bold.green('│'));
  console.log(chalk.bold.green('  └' + '─'.repeat(50) + '┘\n'));
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});
