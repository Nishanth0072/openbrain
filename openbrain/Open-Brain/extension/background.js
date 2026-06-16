// ─── OpenBrain Background Service Worker ───
// Maintains WebSocket connection to backend and relays messages to content scripts.
// This runs independently of any tab, ensuring the bridge stays connected.

const BACKEND_WS = 'ws://localhost:3000?type=extension';
const BACKEND_HTTP = 'http://localhost:3000';
const AI_HOSTS = ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com'];
const VERSION = 'v2.4-BG';

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let isConnecting = false;

// ─── Logging ───
function log(level, text, tool = null) {
  const vText = `[${VERSION}] ${text}`;
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[MCP Bridge BG] ${vText}`);
  // Send log to backend via HTTP (don't use WS to avoid loops)
  fetch(`${BACKEND_HTTP}/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, text: vText, tool }),
  }).catch(() => {});
}

// ─── Find AI tabs ───
async function findAITabs() {
  const tabs = [];
  for (const host of AI_HOSTS) {
    const found = await chrome.tabs.query({ url: `*://${host}/*` });
    tabs.push(...found);
  }
  return tabs;
}

// ─── Send message to content script on the best AI tab ───
async function sendToContentScript(msg) {
  const tabs = await findAITabs();
  if (tabs.length === 0) {
    log('error', 'No ChatGPT/Claude/Gemini tab open — cannot relay prompt');
    // Tell backend there's no AI tab
    sendHttpToBackend('ai-complete', {
      text: 'ERROR: No ChatGPT/Claude/Gemini tab is open in Chrome. Please open one and try again.',
    });
    return false;
  }

  // Prefer the active/focused tab, otherwise use the first one
  const activeTab = tabs.find(t => t.active) || tabs[0];
  try {
    await chrome.tabs.sendMessage(activeTab.id, msg);
    log('info', `Relayed ${msg.type} to tab ${activeTab.id} (${activeTab.url?.slice(0, 40)})`);
    return true;
  } catch (err) {
    log('error', `Failed to send to content script: ${err.message}`);
    // Try other tabs
    for (const tab of tabs) {
      if (tab.id === activeTab.id) continue;
      try {
        await chrome.tabs.sendMessage(tab.id, msg);
        log('info', `Relayed ${msg.type} to fallback tab ${tab.id}`);
        return true;
      } catch (_) { /* try next */ }
    }
    return false;
  }
}

// ─── Send to backend via HTTP ───
async function sendHttpToBackend(endpoint, data) {
  try {
    const res = await fetch(`${BACKEND_HTTP}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

// ─── Send to backend via WS (preferred) with HTTP fallback ───
function sendToBackend(endpoint, data) {
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: data.type || endpoint.toUpperCase(), ...data }));
      return;
    } catch (_) { /* fall through to HTTP */ }
  }
  sendHttpToBackend(endpoint, data);
}

// ─── WebSocket Connection ───
function connect() {
  if (isConnecting) return;
  isConnecting = true;

  // Clean up old timers
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  try {
    socket = new WebSocket(BACKEND_WS);
  } catch (err) {
    log('error', `WebSocket constructor failed: ${err.message}`);
    isConnecting = false;
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    isConnecting = false;
    log('info', 'Connected to backend ✓');

    // Register with backend
    fetch(`${BACKEND_HTTP}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'background-service-worker' }),
    }).catch(() => {});

    // Start heartbeat (single interval, cleaned up on reconnect)
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        log('debug', 'Heartbeat (background)');
      }
    }, 30000);
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      log('warn', `Error parsing message from backend: ${err.message}`);
      return;
    }

    // Relay SEND_PROMPT and MCP_RESULT to content script
    if (msg.type === 'SEND_PROMPT' || msg.type === 'MCP_RESULT') {
      log('info', `Received ${msg.type} from backend — relaying to content script`);
      const sent = await sendToContentScript(msg);
      if (!sent) {
        log('error', `Failed to relay ${msg.type} — no content script available`);
      }
    }
  };

  socket.onclose = () => {
    isConnecting = false;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    log('warn', 'Disconnected from backend');
    scheduleReconnect();
  };

  socket.onerror = (err) => {
    isConnecting = false;
    console.warn('[MCP Bridge BG] WebSocket error', err);
    // onclose will fire after this and handle reconnect
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

// ─── Message handler for content script and popup ───
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Status check from popup
  if (request.type === 'BRIDGE_PING') {
    fetch(`${BACKEND_HTTP}/info`)
      .then(res => res.json())
      .then(data => {
        sendResponse({
          ok: true,
          data,
          wsConnected: socket?.readyState === WebSocket.OPEN,
        });
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }

  // Content script forwarding messages to backend
  if (request.type === 'MCP_ACTION') {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(request));
    } else {
      sendHttpToBackend('mcp-action', request);
    }
    return;
  }

  // Content script forwarding AI stream/complete/log
  if (request.type === 'FORWARD_TO_BACKEND') {
    const { endpoint, data } = request;
    if (endpoint === 'ai-stream' || endpoint === 'ai-complete' || endpoint === 'log') {
      sendHttpToBackend(endpoint, data);
    }
    return;
  }

  // Content script sending write-file
  if (request.type === 'WRITE_FILE_BLOCK') {
    sendHttpToBackend('write-file', request.data);
    return;
  }

  // Registration relay
  if (request.type === 'BRIDGE_REGISTER') {
    fetch(`${BACKEND_HTTP}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: request.url }),
    }).catch(() => {});
    return;
  }
});

// ─── Keep service worker alive via periodic alarm ───
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // Reconnect if not connected
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      log('info', 'Alarm: reconnecting WebSocket...');
      connect();
    }
  }
});

// Start connection immediately
connect();
