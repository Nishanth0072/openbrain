#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Open-Brain  —  Full Stack Launcher
#  Starts: n8n (port 5678)  +  Bridge backend (port 3000)  +  CLI
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
N8N_DIR="$SCRIPT_DIR/../n8n-local"
BACKEND_DIR="$SCRIPT_DIR/backend"

# ── Load API key from .env if present ──────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | xargs)
  echo "✅ Loaded env from $ENV_FILE"
fi

# ── Colours ────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RESET='\033[0m'

echo -e "${CYAN}"
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║   🧠  Open-Brain  ·  Full Stack Launcher              ║"
echo "  ║   n8n + Bridge + CLI — all in one                     ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo -e "${RESET}"

# ── Check if managed by systemd ───────────────────────────────────────────
SYSTEMD_N8N=false
SYSTEMD_BACKEND=false

if systemctl --user is-active --quiet n8n.service 2>/dev/null; then
  SYSTEMD_N8N=true
  echo -e "${GREEN}ℹ️  n8n is running 24/7 under systemd user service.${RESET}"
fi

if systemctl --user is-active --quiet backend.service 2>/dev/null; then
  SYSTEMD_BACKEND=true
  echo -e "${GREEN}ℹ️  Backend is running 24/7 under systemd user service.${RESET}"
fi

# ── 1. Start/verify n8n ───────────────────────────────────────────────────
if [ "$SYSTEMD_N8N" = "true" ]; then
  N8N_PID=""
else
  echo -e "${YELLOW}⏹  Clearing port 5678...${RESET}"
  fuser -k 5678/tcp 2>/dev/null
  sleep 1
  echo -e "${GREEN}🔧 Starting n8n on http://localhost:5678 ...${RESET}"
  (
    cd "$N8N_DIR"
    N8N_PUBLIC_API_DISABLED=false \
    N8N_SECURE_COOKIE=false \
    ./node_modules/.bin/n8n start 2>&1 | sed 's/^/  [n8n] /' &
  )
  N8N_PID=$!
  sleep 5
fi

if [ -n "$N8N_API_KEY" ]; then
  echo -e "${GREEN}🔗 n8n API key set → exporting to MCP server${RESET}"
  export N8N_API_KEY
else
  echo -e "${YELLOW}⚠️  N8N_API_KEY not set. Add it to $SCRIPT_DIR/.env:${RESET}"
  echo -e "   ${CYAN}N8N_API_KEY=your_key_here${RESET}"
  echo ""
  echo -e "   Get your key: http://localhost:5678 → Settings → API → Create API Key"
  echo ""
fi

# ── 2. Start/verify Bridge backend ────────────────────────────────────────
if [ "$SYSTEMD_BACKEND" = "true" ]; then
  BACKEND_PID=""
else
  echo -e "${YELLOW}⏹  Clearing port 3000...${RESET}"
  fuser -k 3000/tcp 2>/dev/null
  sleep 1
  echo -e "${GREEN}🚀 Starting Bridge backend on http://localhost:3000 ...${RESET}"
  (
    cd "$BACKEND_DIR"
    N8N_API_KEY="$N8N_API_KEY" \
    N8N_BASE_URL="http://localhost:5678" \
    node server.js 2>&1
  ) &
  BACKEND_PID=$!
  sleep 2
fi

# ── 3. Open n8n in browser ────────────────────────────────────────────────
DISPLAY=:0 google-chrome --new-tab http://localhost:5678 2>/dev/null &

# ── 4. Start CLI (foreground) ─────────────────────────────────────────────
echo -e "${GREEN}🧠 Starting Open-Brain CLI ...${RESET}"
echo ""

cleanup() {
  echo "Shutting down CLI wrapper..."
  if [ -n "$BACKEND_PID" ]; then
    kill "$BACKEND_PID" 2>/dev/null
  fi
  if [ -n "$N8N_PID" ]; then
    kill "$N8N_PID" 2>/dev/null
    fuser -k 5678/tcp 2>/dev/null
  fi
}
trap cleanup EXIT

node "$SCRIPT_DIR/cli.js"
