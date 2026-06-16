const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const toolCountEl = document.getElementById('tool-count');

function checkBackend() {
  statusEl.textContent = 'Checking...';
  statusEl.className = 'checking';
  logEl.textContent = '';
  toolCountEl.textContent = '';

  // Check backend + extension status in parallel
  Promise.all([
    fetch('http://localhost:3000/info').then(r => r.json()).catch(() => null),
    fetch('http://localhost:3000/extension-status').then(r => r.json()).catch(() => null),
  ]).then(([info, extStatus]) => {
    if (!info) {
      statusEl.textContent = 'Offline ✗';
      statusEl.className = 'offline';
      logEl.textContent = 'Cannot reach backend on port 3000.\nRun: cd backend && node server.js';
      return;
    }

    if (info.status !== 'online') {
      statusEl.textContent = 'MCP Error';
      statusEl.className = 'offline';
      logEl.textContent = 'Backend online but MCP server error: ' + (info.error || '?');
      return;
    }

    const count = info.tools?.tools?.length ?? 0;
    toolCountEl.textContent = `${count} tools available`;

    const wsConnected = extStatus?.connected;
    if (wsConnected) {
      statusEl.textContent = 'Connected ✓';
      statusEl.className = 'online';
      logEl.textContent = 'Extension WebSocket active. Ready for commands.';
    } else {
      statusEl.textContent = 'Backend OK · WS Disconnected';
      statusEl.className = 'checking';
      logEl.textContent = 'Backend is reachable but WebSocket bridge is not connected.\nOpen ChatGPT / Claude / Gemini in a tab, then reload extension.';
    }
  });
}

document.getElementById('check').addEventListener('click', checkBackend);

// Auto-check on open
checkBackend();
