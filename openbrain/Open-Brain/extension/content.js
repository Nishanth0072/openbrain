// ─── MCP Bridge Content Script — Agentic Loop Mode v2.4 ───
// Communicates with backend via background.js service worker.
// Handles DOM injection on ChatGPT/Claude/Gemini pages.

let currentConfig = null;
const processedActionKeys = new Set();
let agentActive = false;
let completionTimer = null;
let toolCallInProgress = false;

// Track chat state so we only forward truly NEW AI text
let snapshotTurnCount = 0;   // # assistant turns when we sent a prompt
let lastTextSent = '';        // latest AI text we've forwarded this turn
let currentTurnStarted = false;

const VERSION = "v2.4-CONTENT";

// ─── MCP System Prompt — injected directly into every user message ───
// This replaces the unreliable fetch-intercept approach.
function buildSystemPrompt(cwd, project) {
  const cwdLine = cwd || '/home/user/project';
  const projectLine = project || 'project';
  return `[SYSTEM — AUTONOMOUS CODING AGENT]
You are an autonomous coding agent with FULL access to the local filesystem at: ${cwdLine}
Project: ${projectLine}

CRITICAL RULES:
1. NEVER give instructions, explanations, or step-by-step guides. You ARE the developer — WRITE the actual code directly.
2. NEVER say "you should", "you can", "try this", "here's how", "create a file called". Instead, just OUTPUT the complete file in a code block.
3. Every code block you write is AUTOMATICALLY saved to disk. Add the target filename as a comment on the FIRST LINE:
   HTML: <!-- filename: index.html -->
   JS:   // filename: app.js
   CSS:  /* filename: style.css */
   Python: # filename: main.py
4. Shell commands in bash code blocks are AUTOMATICALLY executed. Just write them:
   \`\`\`bash
   npm install express
   \`\`\`
5. When asked to build something NEW, immediately start writing the code. No preamble needed.
6. Use actual filenames from the project. Working directory: ${cwdLine}

MODIFICATION / ENHANCEMENT WORKFLOW (CRITICAL):
When the user asks to MODIFY, ENHANCE, FIX, or UPDATE an existing file:
1. FIRST use read_file to see the EXACT current content of the file
2. THEN use edit_file or multi_edit_file to make SURGICAL changes — do NOT rewrite the entire file
3. FINALLY use verify_file to confirm the code is syntactically valid
- Use edit_file for a single change (pass exact target_text copied from read_file output)
- Use multi_edit_file for multiple changes in one file (array of edits)
- ONLY use write_file for creating NEW files that don't exist yet
- NEVER use write_file to modify existing files — it can truncate or lose content

You have these tools available via MCP_ACTION:
- read_file: Read file contents (ALWAYS do this before editing)
- write_file: Create NEW files only
- edit_file: PREFERRED for modifications — surgically replace specific text (args: path, target_text, replacement_text, replace_all)
- multi_edit_file: Apply MULTIPLE edits to one file in a single call (args: path, edits:[{target_text, replacement_text}])
- verify_file: Validate syntax after writing/editing (.js, .html, .css, .py, .json)
- run_terminal: Execute shell commands
- list_directory: List directory contents
- search_files: Search file contents

To call a tool, output: MCP_ACTION: {"tool": "tool_name", "args": {"key": "value"}}

REMEMBER: You are NOT an assistant giving advice. You are an agent that EXECUTES tasks by writing real code and running real commands. Act, don't instruct.
For modifications: READ → EDIT → VERIFY. Never blindly rewrite.
`;
}

// Default prompt before we receive cwd from backend
let currentCwd = null;
let currentProject = null;


function extractJsonObjects(text) {
  const results = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    let braceCount = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const char = text[j];
      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
      }
      if (braceCount === 0) {
        end = j;
        break;
      }
    }
    if (end !== -1) {
      results.push(text.slice(start, end + 1));
      i = end + 1;
    } else {
      i = start + 1;
    }
  }
  return results;
}

// ─── Detect language from code content patterns ───
function detectLangFromContent(code) {
  if (code.includes('<!DOCTYPE') || (code.includes('<html') && code.includes('</html>'))) return 'html';
  if (code.includes('<body') && code.includes('</body>')) return 'html';
  if (code.includes('@import') || (/[a-z-]+\s*:\s*[^{]+;/.test(code) && code.includes('{') && !code.includes('function') && !code.trim().startsWith('{'))) return 'css';
  if (code.includes('def ') && code.includes(':') && !code.includes('{')) return 'python';
  if (code.includes('function ') || code.includes('=>') || code.includes('const ') || code.includes('let ')) return 'javascript';
  if (code.trim().startsWith('{') && code.trim().endsWith('}')) return 'json';
  return '';
}

// ─── Communication via background.js service worker ───
async function sendToBackend(endpoint, data) {
  // HTTP direct is fastest for streaming data
  try {
    const res = await fetch(`http://localhost:3000/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) return;
  } catch (_) { /* fall through to background relay */ }

  // Fallback: relay through background service worker
  try {
    chrome.runtime.sendMessage({ type: 'FORWARD_TO_BACKEND', endpoint, data });
  } catch (e) {
    console.error('[MCP Bridge] Both HTTP and background relay failed:', e);
  }
}

function sendActionToBackend(data) {
  // MCP actions go through background.js WS for reliability
  try {
    chrome.runtime.sendMessage({ type: 'MCP_ACTION', ...data, source: 'browser' });
  } catch (_) {
    // Fallback to direct HTTP
    sendToBackend('mcp-action', data);
  }
}

// ── Send a WRITE_FILE block to the backend (base64-encoded to avoid JSON issues) ──
async function sendWriteFileBlock(filePath, content) {
  try {
    const b64 = btoa(unescape(encodeURIComponent(content)));
    remoteLog('info', `Uploading WRITE_FILE: ${filePath} (${content.length} chars, b64: ${b64.length})`);
    const res = await fetch('http://localhost:3000/write-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content_b64: b64 }),
    });
    if (!res.ok) {
      const err = await res.text();
      remoteLog('error', `WRITE_FILE upload failed (${res.status}): ${err}`);
      toolCallInProgress = false;
      scheduleCompletion();
    }
  } catch (e) {
    remoteLog('error', `WRITE_FILE network error: ${e.message}`);
    toolCallInProgress = false;
    scheduleCompletion();
  }
}

function remoteLog(level, text, tool = null) {
  const vText = `[${VERSION}] ${text}`;
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[MCP Bridge] ${vText}`);
  sendToBackend('log', { level, text: vText, tool });
}

// ─── Per-provider selectors ───
const SELECTORS = {
  'chatgpt.com': {
    input: '#prompt-textarea',
    send: "[data-testid='send-button']",
    responses: '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"] .prose',
    stopBtn: "[data-testid='stop-button']",
  },
  'claude.ai': {
    input: '.ProseMirror[contenteditable="true"]',
    send: "button[aria-label='Send Message']",
    responses: '.font-claude-message, .claude-message, [data-testid="message-container"]',
    stopBtn: "button[aria-label='Stop Response']",
  },
  'gemini.google.com': {
    input: 'div.ql-editor, div[contenteditable="true"]',
    send: "button.send-button, button[aria-label='Send message'], .send-button-container button",
    responses: 'model-response .markdown, .model-response-text, .response-content',
    stopBtn: "button[aria-label='Stop response'], .stop-button",
  },
};

const hostname = window.location.hostname.replace('www.', '');
for (const key in SELECTORS) {
  if (hostname.includes(key)) {
    currentConfig = SELECTORS[key];
    break;
  }
}

// ─── Smart Element Finders ───
function findInput() {
  if (currentConfig) {
    const input = document.querySelector(currentConfig.input);
    if (input) return input;
  }
  // Fallbacks: Common chat input patterns
  return document.querySelector('.ProseMirror[contenteditable="true"]') ||
         document.querySelector('div[contenteditable="true"][role="textbox"]') ||
         document.querySelector('textarea[placeholder*="Message"]') ||
         document.querySelector('textarea[aria-label*="Message"]') ||
         document.querySelector('#prompt-textarea');
}

function findSendButton() {
  if (currentConfig) {
    for (const sel of currentConfig.send.split(',')) {
      const btn = document.querySelector(sel.trim());
      if (btn && !btn.disabled) return btn;
    }
  }
  // Fallbacks: Common send button patterns
  return document.querySelector('button[aria-label*="Send"]') ||
         document.querySelector('button[data-testid*="send-button"]') ||
         document.querySelector('button.send-button') ||
         document.querySelector('.send-button-container button');
}

function findAssistantResponses() {
  if (currentConfig) {
    for (const sel of currentConfig.responses.split(',')) {
      const elems = document.querySelectorAll(sel.trim());
      if (elems.length > 0) return Array.from(elems);
    }
  }
  // Fallbacks
  return Array.from(document.querySelectorAll('[data-message-author-role="assistant"], model-response, .markdown, .prose'));
}

// ─── Count assistant turns currently in the DOM ───
function countAssistantTurns() {
  return findAssistantResponses().length;
}

// ─── Get only the LAST assistant turn's text ───
function getLatestResponse() {
  const responses = findAssistantResponses();
  if (responses.length > 0) {
    const last = responses[responses.length - 1];
    return (last.innerText || last.textContent || '').trim();
  }
  return '';
}

// Returns raw HTML of the latest response — preserves code block markup
function getLatestResponseHtml() {
  const responses = findAssistantResponses();
  if (responses.length > 0) {
    const last = responses[responses.length - 1];
    // Extract markdown-like text from code blocks by walking the DOM
    let md = '';
    const walk = (node) => {
      if (node.nodeName === 'PRE' || (node.nodeName === 'CODE' && node.parentNode?.nodeName === 'PRE')) {
        const codeEl = node.querySelector('code') || node;
        const lang = (codeEl.className || '').replace(/.*language-/, '').split(/\s/)[0] || '';
        const text = (codeEl.innerText || codeEl.textContent || '');
        md += '\n```' + lang + '\n' + text + '\n```\n';
        return; // Don't descend further
      }
      if (node.nodeType === 3) { // Text node
        md += node.textContent;
      } else {
        for (const child of node.childNodes) walk(child);
      }
    };
    walk(last);
    return md.trim();
  }
  return '';
}

// ─── Message listener from background.js ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SEND_PROMPT') {
    agentActive = true;
    toolCallInProgress = false;
    currentTurnStarted = false;
    processedActionKeys.clear();
    clearTimeout(completionTimer);
    lastTextSent = '';
    snapshotTurnCount = countAssistantTurns();

    // Update cwd/project for system prompt enrichment
    if (msg.cwd) currentCwd = msg.cwd;
    if (msg.project) currentProject = msg.project;

    // Embed MCP instructions directly in the user message text
    const MCP_SYSTEM_PROMPT = buildSystemPrompt(currentCwd, currentProject);
    const fullText = MCP_SYSTEM_PROMPT + '\n' + msg.text;
    remoteLog('info', `New prompt — snapshot turns: ${snapshotTurnCount}, cwd: ${currentCwd}, injecting ${fullText.length} chars`);

    // If an image was attached, inject it into the chat first, then send text
    if (msg.image_b64) {
      remoteLog('info', `📸 Image attached (${msg.image_type}) — injecting into chat`);
      injectImageToChat(msg.image_b64, msg.image_type || 'image/png').then(() => {
        setTimeout(() => injectAndSend(fullText), 900);
      });
    } else {
      injectAndSend(fullText);
    }
  }

  else if (msg.type === 'MCP_RESULT') {
    agentActive = true;
    toolCallInProgress = false;
    currentTurnStarted = false;
    processedActionKeys.clear();
    clearTimeout(completionTimer);

    snapshotTurnCount = countAssistantTurns();
    lastTextSent = '';

    const formatted = formatToolResult(msg.tool, msg.text, msg.callNum);
    remoteLog('info', `Injecting tool result for: ${msg.tool}`, msg.tool);
    setTimeout(() => waitAndInject(formatted), 1200);
  }
});

// Register with backend on load
fetch('http://localhost:3000/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: window.location.href }),
}).catch(() => {});

// ── Inject an image into the chat input via DataTransfer paste API ──
// Supports ChatGPT, Claude, Gemini (contenteditable + file paste).
async function injectImageToChat(b64, mimeType) {
  try {
    // Decode base64 → Blob → File
    const byteChars = atob(b64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    const file = new File([blob], 'screenshot.png', { type: mimeType });

    const input = findInput();
    if (!input) { remoteLog('warn', 'Image inject: input not found, skipping'); return; }
    input.focus();

    // Method 1: DataTransfer paste event (works on most contenteditable UIs)
    const dt = new DataTransfer();
    dt.items.add(file);
    const pasteEvt = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    const handled = input.dispatchEvent(pasteEvt);
    remoteLog('info', `Image paste event dispatched (handled=${handled})`);

    // Method 2: Clipboard API fallback (if paste event wasn't consumed)
    if (!handled || input.querySelectorAll('img').length === 0) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
        // Simulate Ctrl+V
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));
        remoteLog('info', 'Image injected via clipboard Ctrl+V fallback');
      } catch (clipErr) {
        remoteLog('warn', `Clipboard fallback failed: ${clipErr.message}`);
      }
    }

    // Give the UI time to render the attached image
    await new Promise(r => setTimeout(r, 600));
  } catch (e) {
    remoteLog('error', `injectImageToChat failed: ${e.message}`);
  }
}

// ─── Format tool result ───
function formatToolResult(tool, text, callNum) {
  const MAX_LEN = 12000;
  const body = text.length > MAX_LEN
    ? text.slice(0, MAX_LEN) + `\n... [truncated — ${text.length - MAX_LEN} chars omitted]`
    : text;

  const isWrite = (tool === 'write_file');
  const isRun   = (tool === 'run_terminal');

  if (isWrite && !text.includes('\u274c')) {
    return (
      `[FILE SAVED \u2705 #${callNum || '?'}]\n${body}\n[END]\n\n` +
      `File saved successfully. If there are more files to create, write the next one now ` +
      `(add the SAVE comment as the first line of the code block). ` +
      `If all files are done, give a brief summary.`
    );
  }

  if (isRun) {
    return (
      `[COMMAND RESULT #${callNum || '?'}]\n${body}\n[END]\n\n` +
      `Command completed. Continue with the next step or summarize if done.`
    );
  }

  return (
    `[RESULT #${callNum || '?'}: ${tool || 'tool'}]\n` +
    `${body}\n[END]\n\n` +
    `Continue. If you need to create files, use code blocks with SAVE comments. If done, summarize.`
  );
}

// ─── Inject text into chat input and click Send ───
function injectAndSend(text) {
  const input = findInput();
  if (!input) {
    remoteLog('warn', `Input not found — retrying`);
    setTimeout(() => injectAndSend(text), 1000);
    return;
  }

  remoteLog('info', `Injecting ${text.length} chars into ${input.tagName}`);

  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(input, text);
    } else {
      input.value = text;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // contenteditable (Claude, Gemini, ChatGPT Lexical)
    input.focus();

    // Ensure selection range is set inside the input element for execCommand reliability
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (e) {
      remoteLog('warn', `Failed to set selection range: ${e.message}`);
    }

    // Method 1: Paste event (Most reliable for Lexical/ProseMirror)
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const pasteEvt = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(pasteEvt);

    // Method 2: Fallback to execCommand if paste didn't work
    setTimeout(() => {
      if (!input.textContent.includes(text.slice(0, 20))) {
        remoteLog('info', 'Paste event failed, falling back to execCommand');
        document.execCommand('selectAll', false, null);
        const ok = document.execCommand('insertText', false, text);
        if (!ok || !input.textContent.includes(text.slice(0, 20))) {
          input.innerHTML = '';
          input.textContent = text;
        }
      }
      
      // Fire change/input events for framework state
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, 50);
  }

  setTimeout(() => {
    const sendBtn = findSendButton();

    if (sendBtn && !sendBtn.disabled) {
      remoteLog('info', 'Clicking Send button');
      sendBtn.click();
    } else {
      remoteLog('warn', 'Send button not found or disabled — trying Enter key');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    }
  }, 700);
}

// ─── Wait for AI to finish generating before injecting text ───
// Prevents stalls caused by injecting tool results while the AI UI is still busy.
function waitAndInject(text, attempt = 0) {
  if (isStillGenerating()) {
    if (attempt < 60) { // Max ~30 seconds (60 * 500ms)
      remoteLog('debug', `AI is still generating, delaying injection (attempt ${attempt})...`);
      setTimeout(() => waitAndInject(text, attempt + 1), 500);
      return;
    }
    remoteLog('warn', `AI still generating after ${attempt} retries — forcing injection`);
  }
  injectAndSend(text);
}

// ─── Scan for new AI response ───
function scanForResponse() {
  if (!currentConfig || !agentActive || toolCallInProgress) return;

  const currentTurns = countAssistantTurns();

  // Wait until a NEW assistant turn appears
  if (!currentTurnStarted) {
    if (currentTurns > snapshotTurnCount) {
      currentTurnStarted = true;
      remoteLog('debug', `New AI turn detected (now ${currentTurns} turns)`);
    } else {
      return; // still showing old content
    }
  }

  const latestText = getLatestResponse();
  if (!latestText) return;

  // ── 1. Detect MCP_ACTION — anchored extractor ──
  // Find every occurrence of "MCP_ACTION:" and extract the {} that follows it.
  // This avoids false positives from other JSON in the response and handles
  // malformed JSON (e.g. unescaped quotes in file content strings).
  const PREFIX = 'MCP_ACTION:';
  let searchPos = 0;
  while (true) {
    const prefixIdx = latestText.indexOf(PREFIX, searchPos);
    if (prefixIdx === -1) break;
    searchPos = prefixIdx + PREFIX.length;

    // Find the opening brace
    const braceStart = latestText.indexOf('{', prefixIdx + PREFIX.length);
    if (braceStart === -1) break;

    // Balanced-brace walk to find the matching closing brace
    let braceCount = 0;
    let inStr = false;
    let esc = false;
    let braceEnd = -1;
    for (let j = braceStart; j < latestText.length; j++) {
      const c = latestText[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (c === '{') braceCount++;
        if (c === '}') { braceCount--; if (braceCount === 0) { braceEnd = j; break; } }
      }
    }

    // FIX 1: If the closing brace hasn't arrived yet the AI is still streaming.
    // Use `return` (retry on next scan tick) instead of `break` (give up forever).
    // This was the root cause of write_file stopping mid-content.
    if (braceEnd === -1) return;

    const jsonStr = latestText.slice(braceStart, braceEnd + 1);
    const midAction = Math.floor(jsonStr.length / 2);
    const key = jsonStr.replace(/\s+/g, '').slice(0, 200) + ":" + jsonStr.length + ":" + jsonStr.slice(midAction, midAction+100) + ":" + jsonStr.slice(-100);
    if (processedActionKeys.has(key)) continue;

    let tool = null, args = {};

    // Try standard JSON.parse first
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed && typeof parsed.tool === 'string') {
        tool = parsed.tool;
        args = parsed.args || {};
      }
    } catch (_) {
      // FIX 2: When the AI includes raw HTML/code in a content string it produces
      // unescaped characters that break JSON.parse. Instead of a regex that chokes
      // on embedded quotes, we extract the tool name reliably and then use
      // run_terminal as the write mechanism (AI should base64-encode or use heredoc).
      // As a best-effort we still try to pull simple string fields.
      const toolMatch = jsonStr.match(/"tool"\s*:\s*"([^"]+)"/);
      if (toolMatch) {
        tool = toolMatch[1];
        // Locate the "args" object start and try JSON on it
        const argsKeyIdx = jsonStr.indexOf('"args"');
        if (argsKeyIdx !== -1) {
          const argsObjStart = jsonStr.indexOf('{', argsKeyIdx + 6);
          if (argsObjStart !== -1) {
            // Walk balanced braces to find args object end
            let ab = 0, inS = false, es = false, argsEnd = -1;
            for (let k = argsObjStart; k < jsonStr.length; k++) {
              const ch = jsonStr[k];
              if (es) { es = false; continue; }
              if (ch === '\\') { es = true; continue; }
              if (ch === '"') { inS = !inS; continue; }
              if (!inS) {
                if (ch === '{') ab++;
                if (ch === '}') { ab--; if (ab === 0) { argsEnd = k; break; } }
              }
            }
            const argsSlice = argsEnd !== -1 ? jsonStr.slice(argsObjStart, argsEnd + 1) : null;
            if (argsSlice) {
              try {
                args = JSON.parse(argsSlice);
              } catch (_2) {
                // Last resort: pull only simple quoted string fields (non-content fields like path)
                const fields = {};
                const fieldRe = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.){0,2000})"/g;
                let fm;
                while ((fm = fieldRe.exec(argsSlice)) !== null) {
                  fields[fm[1]] = fm[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
                }
                args = fields;
                // If args has a `path` but a corrupt/missing `content`, warn so AI retries
                if (args.path && !args.content) {
                  remoteLog('warn', `write_file: content field not parseable as JSON — AI should use run_terminal with a heredoc for large files`);
                }
              }
            }
          }
        }
      }
    }

    if (tool) {
      processedActionKeys.add(key);
      toolCallInProgress = true;
      clearTimeout(completionTimer);
      remoteLog('info', `🔧 Tool call detected: ${tool}`, tool);
      sendActionToBackend({ tool, args });
    }
  }


  // ── 2. WRITE_FILE block detection (legacy text format) ──
  const WF_MARKER   = 'WRITE_FILE:';
  const WF_CS       = '<<<CONTENT>>>';
  const WF_CE       = '<<<END>>>';
  const wfIdx = latestText.indexOf(WF_MARKER);
  if (wfIdx !== -1) {
    const csIdx = latestText.indexOf(WF_CS, wfIdx);
    const ceIdx = latestText.indexOf(WF_CE, wfIdx);
    if (csIdx !== -1 && ceIdx !== -1) {
      const rawPath    = latestText.slice(wfIdx + WF_MARKER.length, csIdx).trim();
      const rawContent = latestText.slice(csIdx + WF_CS.length, ceIdx);
      const wfKey      = `WF:${rawPath}:${rawContent.length}`;
      if (!processedActionKeys.has(wfKey)) {
        processedActionKeys.add(wfKey);
        toolCallInProgress = true;
        clearTimeout(completionTimer);
        remoteLog('info', `📝 WRITE_FILE: ${rawPath} (${rawContent.length} chars)`);
        sendWriteFileBlock(rawPath, rawContent);
      }
    } else if (csIdx !== -1 && ceIdx === -1) {
      return; // still streaming
    }
  }

  // ── 3. DOM code block extractor — auto-saves ALL code blocks ──
  // Works even when AI doesn't follow SAVE: convention.
  // Runs only when AI is done streaming to capture complete files.
  if (!isStillGenerating()) {
    (() => {
      const responses = findAssistantResponses();
      if (!responses.length) return;
      const lastResp = responses[responses.length - 1];

      // Collect all <pre> blocks in the last AI response
      const pres = Array.from(lastResp.querySelectorAll('pre'));
      let fileIndex = 0;

      // ── Scan FULL AI response text for subdirectory path hints ──
      // e.g. "ben10-website/index.html" → targetSubDir = "ben10-website"
      const fullRespText = lastResp.innerText || lastResp.textContent || '';
      // Match patterns like: folder/file.html  or  /abs/path/to/file.html
      const pathHintRe = /(?:^|[\s`'"])([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]{2,5})(?:[\s`'"]|$)/gm;
      let pathHintMatch;
      let detectedSubDir = null;
      while ((pathHintMatch = pathHintRe.exec(fullRespText)) !== null) {
        const p = pathHintMatch[1];
        // Must look like a real path (not a URL or node_modules etc.)
        if (!p.includes('://') && !p.includes('node_modules')) {
          const parts = p.split('/');
          if (parts.length >= 2) { detectedSubDir = parts.slice(0, -1).join('/'); break; }
        }
      }
      const effectiveCwd = detectedSubDir
        ? (detectedSubDir.startsWith('/') ? detectedSubDir : `${currentCwd || '/tmp'}/${detectedSubDir}`)
        : (currentCwd || '/tmp');

      pres.forEach(pre => {
        const codeEl = pre.querySelector('code') || pre;
        const raw = (codeEl.innerText || codeEl.textContent || '').trimStart();
        if (raw.length < 5) return; // skip truly empty blocks

        // Detect language from class attribute (e.g. "language-html")
        const allClasses = [codeEl.className, pre.className,
          (pre.parentElement && pre.parentElement.className) || ''].join(' ');
        const langMatch = allClasses.match(/language-([\w]+)/i)
                       || allClasses.match(/\blang-([\w]+)/i);
        const detectedLang = langMatch ? langMatch[1].toLowerCase() : '';

        const lines = raw.split('\n');
        const firstLine = lines[0].trim();

        // ─ Priority 1: Explicit SAVE: marker ─
        const saveMatch = firstLine.match(
          /^(?:\/\*\s*SAVE:\s*(.+?)\s*\*\/|<!--\s*SAVE:\s*(.+?)\s*-->|\/\/\s*SAVE:\s*(\S+)|#\s*SAVE:\s*(\S+))$/i
        );
        if (saveMatch) {
          const fp = (saveMatch[1]||saveMatch[2]||saveMatch[3]||saveMatch[4]||'').trim();
          if (fp.startsWith('/')) {
            const content = lines.slice(1).join('\n');
            const key = `SAVE:${fp}:${content.length}:${content.slice(-60)}`;
            if (!processedActionKeys.has(key) && content.trim()) {
              processedActionKeys.add(key);
              toolCallInProgress = true; clearTimeout(completionTimer);
              remoteLog('info', `💾 SAVE: ${fp} (${content.length}c)`);
              sendWriteFileBlock(fp, content);
            }
          }
          return;
        }

        // ─ Priority 2: filename: comment (optional hint from AI) ─
        const fnMatch = firstLine.match(
          /^(?:\/\/|#|<!--|\/\*)\s*filename:\s*([\w./-]+)(?:\s*-->|\s*\*\/)?/i
        );

        // ─ Bash/shell block: auto-execute safe commands ─
        // Only auto-execute if no filename is specified (if a filename is provided, it should be saved as a script)
        const isBash = ['bash','sh','shell','zsh','console','terminal'].includes(detectedLang);
        if (!fnMatch && (isBash || (!detectedLang && /^(mkdir|cd |npm |npx |node |python|pip |touch |ls |git |yarn |cargo |chmod )/.test(raw.trim())))) {
          const cmdLines = lines.filter(l => {
            const t = l.trim();
            return t && !t.startsWith('#'); // skip blanks and comments
          });
          if (cmdLines.length > 0) {
            // Check for # RUN: on first line (explicit override)
            const runMatch = firstLine.match(/^#\s*RUN:\s*(.+)$/);
            const command = runMatch
              ? runMatch[1].trim()
              : cmdLines.join('\n');
            // Safety: block dangerous destructive commands
            const DANGEROUS = /\brm\s+-rf\s*\/|mkfs|dd\s+if=|shutdown|reboot|format/;
            if (!DANGEROUS.test(command)) {
              const runKey = `RUN:${command.slice(0, 120)}`;
              if (!processedActionKeys.has(runKey)) {
                processedActionKeys.add(runKey);
                toolCallInProgress = true; clearTimeout(completionTimer);
                remoteLog('info', `⚡ Auto-run bash: ${command}`);
                sendActionToBackend({ tool: 'run_terminal', args: { command } });
              }
            }
          }
          return; // Don't try to save bash blocks as files
        }

        let filePath = null;
        let content = raw;
        if (fnMatch) {
          const hint = fnMatch[1].trim();
          // Support relative paths like "ben10-website/index.html"
          filePath = hint.startsWith('/') ? hint
                   : `${currentCwd || '/tmp'}/${hint}`;
          content = lines.slice(1).join('\n');
        } else {
          // ─ Priority 3: Auto-infer filename from language + content ─
          // Use effectiveCwd which may include a detected subdirectory
          const lang = detectedLang || detectLangFromContent(raw);
          const isHtml = lang === 'html' || raw.includes('<!DOCTYPE') || (raw.includes('<html') && raw.includes('</html>'));
          const isCss  = lang === 'css'  || (raw.includes('{') && /[a-z-]+\s*:\s*[^{]+;/.test(raw) && !raw.includes('function') && !raw.includes('<!'));
          const isJs   = lang === 'javascript' || lang === 'js' || lang === 'typescript' || lang === 'ts';
          const isPy   = lang === 'python' || lang === 'py';
          const isJson = lang === 'json' || (raw.trim().startsWith('{') && raw.trim().endsWith('}') && !isCss && !isJs);

          let fname = null;
          if (isHtml)  fname = fileIndex === 0 ? 'index.html'  : `page${fileIndex}.html`;
          else if (isCss) fname = fileIndex === 0 ? 'style.css'  : `style${fileIndex}.css`;
          else if (isJs)  fname = fileIndex === 0 ? 'script.js'  : `script${fileIndex}.js`;
          else if (isPy)  fname = 'main.py';
          else if (isJson) fname = fileIndex === 0 ? 'data.json' : `data${fileIndex}.json`;
          if (!fname) return; // unknown type, skip

          // ─ Also check text directly before this <pre> for a filename hint ─
          let nearHint = null;
          let sibling = pre.previousElementSibling || pre.parentElement?.previousElementSibling;
          for (let si = 0; si < 3 && sibling; si++, sibling = sibling.previousElementSibling) {
            const sibText = sibling.innerText || sibling.textContent || '';
            const sibPath = sibText.match(/`([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.[a-zA-Z]{2,5})`/);
            if (sibPath) { nearHint = sibPath[1]; break; }
          }
          if (nearHint) {
            filePath = nearHint.startsWith('/') ? nearHint : `${currentCwd || '/tmp'}/${nearHint}`;
          } else {
            filePath = `${effectiveCwd}/${fname}`;
          }
          content  = raw;
        }

        if (!filePath || !filePath.startsWith('/')) return;
        const mid = Math.floor(content.length / 2);
        const key = `CODEBLOCK:${filePath}:${content.length}:${content.slice(-60)}:${content.slice(mid, mid+60)}`;
        if (!processedActionKeys.has(key) && content.trim()) {
          processedActionKeys.add(key);
          toolCallInProgress = true; clearTimeout(completionTimer);
          remoteLog('info', `💾 Auto-save: ${filePath} (${content.length}c)`);
          sendWriteFileBlock(filePath, content);
          fileIndex++;
        }
      });

      // ─ Also scan inline backtick commands in response text ─
      // Catches patterns like: run `mkdir project-name` or execute `npm install`
      const SAFE_INLINE_RE = /^(mkdir|cd |npm |npx |node |python3?|pip |touch |git |yarn |chmod )/;
      const DANGER_RE = /\brm\s+-rf\s*\/|mkfs|dd\s+if=|shutdown|reboot/;
      const btRe = /`([^`\n]{3,120})`/g;
      let btMatch;
      while ((btMatch = btRe.exec(fullRespText)) !== null) {
        const cmd = btMatch[1].trim();
        if (SAFE_INLINE_RE.test(cmd) && !DANGER_RE.test(cmd) && !cmd.includes('\n')) {
          const runKey = `INLINE-RUN:${cmd}`;
          if (!processedActionKeys.has(runKey)) {
            processedActionKeys.add(runKey);
            toolCallInProgress = true; clearTimeout(completionTimer);
            remoteLog('info', `⚡ Inline cmd: ${cmd}`);
            sendActionToBackend({ tool: 'run_terminal', args: { command: cmd } });
          }
        }
      }

    })();
  }

  // ── 4. Stream incremental text ──
  if (latestText.length > lastTextSent.length) {
    const newText = latestText.slice(lastTextSent.length);
    const hasProtocol = newText.includes('MCP_ACTION') || newText.includes('[TOOL RESULT');
    if (!hasProtocol && newText.trim()) {
      sendToBackend('ai-stream', { text: newText });
    }
    lastTextSent = latestText;
    scheduleCompletion();
  }
}

const observer = new MutationObserver(() => scanForResponse());
setInterval(scanForResponse, 500);

function isStillGenerating() {
  const stopBtn = (currentConfig?.stopBtn) ?
                  document.querySelector(currentConfig.stopBtn) :
                  (document.querySelector('button[aria-label*="Stop"]') || document.querySelector('.stop-button'));

  return stopBtn && stopBtn.offsetParent !== null;
}

function scheduleCompletion() {
  clearTimeout(completionTimer);
  completionTimer = setTimeout(() => {
    if (!agentActive || !lastTextSent || toolCallInProgress) return;

    if (isStillGenerating()) {
      remoteLog('debug', 'Still generating...');
      scheduleCompletion();
      return;
    }

    const currentText = getLatestResponse();
    if (currentText.length > lastTextSent.length) {
      lastTextSent = currentText;
      scheduleCompletion();
      return;
    }

    // Always send AI_COMPLETE — server-side extractor is the backup save path
    remoteLog('info', `AI done — sending AI_COMPLETE (extension saved ${processedActionKeys.size} items)`);
    const rawMd = getLatestResponseHtml();
    sendToBackend('ai-complete', { rawMarkdown: rawMd });
    agentActive = false;
  }, 5000);
}

observer.observe(document.body, { childList: true, subtree: true, characterData: true });

remoteLog('info', `Extension active v2.3 — Direct Prompt Mode 🤖`);
