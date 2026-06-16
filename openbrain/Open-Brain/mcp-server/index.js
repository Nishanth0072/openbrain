import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { buildWorkflowFromTemplate, buildNode, chainNodes, validateWorkflow, N8N_TEMPLATES } from './n8n-enhanced.js';
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exec, spawn } from "child_process";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";

// ─── Limits ───
const MAX_OUTPUT_CHARS = 8000;
let currentCwd = process.cwd();

// Background process registry  { id -> { proc, output, exitCode } }
const bgProcesses = new Map();
let bgNextId = 1;

// Canonical list of every tool name — returned verbatim in "Unknown tool" errors
// so the AI can correct itself without guessing.
const VALID_TOOLS = [
  'read_file','write_file','edit_file','multi_edit_file','append_file','delete_file','list_directory','search_files',
  'verify_file',
  'run_terminal','run_background','get_background_output','kill_process',
  'get_running_processes','set_cwd','get_env','get_system_info',
  'open_url','open_application','focus_window','list_windows',
  'send_keys','type_text','mouse_click','take_screenshot',
  'get_clipboard','set_clipboard','get_screen_resolution',
  'speak_text','send_notification','install_package','open_path',
  'open_terminal','read_url',
  'git_status','git_diff','find_replace','move_file',
  // n8n workflow tools
  'n8n_list_workflows','n8n_get_workflow','n8n_create_workflow','n8n_update_workflow',
  'n8n_activate_workflow','n8n_delete_workflow','n8n_execute_workflow','n8n_list_executions',
  'n8n_from_template','n8n_validate_workflow','n8n_clone_workflow',
  'host_website'
];

// ─── n8n API Helper ───
const N8N_BASE = process.env.N8N_BASE_URL || 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY || '';

async function n8nRequest(method, endpoint, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (N8N_API_KEY) headers['X-N8N-API-KEY'] = N8N_API_KEY;

  const opts = {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  const url = `${N8N_BASE}/api/v1${endpoint}`;
  const cmd = `curl -s -X ${method} ${Object.entries(headers).map(([k,v]) => `-H "${k}: ${v}"`).join(' ')} ${
    body ? `-d ${JSON.stringify(JSON.stringify(body))}` : ''
  } --max-time 15 "${url}"`;

  return new Promise((resolve) => {
    exec(cmd, { timeout: 20000 }, (error, stdout, stderr) => {
      if (error) { resolve({ error: error.message, raw: stderr }); return; }
      try { resolve(JSON.parse(stdout)); }
      catch (e) { resolve({ error: 'JSON parse failed', raw: stdout }); }
    });
  });
}

function truncate(text, label = '') {
  if (!text) return '(no output)';
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) +
    `\n\n... [truncated — ${text.length - MAX_OUTPUT_CHARS} chars omitted${label ? ` in ${label}` : ''}]`;
}

function safeJoin(base, rel) {
  const resolved = path.resolve(base, rel || '.');
  return resolved; // No sandbox restriction — user requested full access
}

function execAsync(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { cwd: currentCwd, timeout: 30000, maxBuffer: 10 * 1024 * 1024, ...opts },
      (error, stdout, stderr) => {
        const out = [stdout, stderr ? `\nSTDERR:\n${stderr}` : ''].join('').trim() || '(no output)';
        resolve({ out, error, stdout, stderr });
      });
  });
}

// ─── Server ───
const server = new Server(
  { name: 'mcp-bridge-server', version: '3.0.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool Definitions ───
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [

    // ════════════════════════════════
    //  FILE SYSTEM TOOLS (original)
    // ════════════════════════════════
    {
      name: 'read_file',
      description: 'Reads the contents of a file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Writes (or overwrites) a file with given content, creating parent dirs as needed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path' },
          content: { type: 'string', description: 'Text content to write' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: 'PREFERRED tool for modifying existing files. Surgically replaces a specific block of text. ' +
        'Uses exact string matching — the target_text must appear in the file character-for-character (including whitespace/indentation). ' +
        'ALWAYS use this instead of write_file when modifying existing code. ' +
        'TIP: Use read_file first to see exact content, then copy-paste the exact target block. ' +
        'If target_text is not found, the tool returns the first 200 lines of the file to help you correct the match.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
          target_text: { type: 'string', description: 'The exact text to replace (must match character-for-character including whitespace)' },
          replacement_text: { type: 'string', description: 'The new text to replace it with' },
          replace_all: { type: 'boolean', description: 'Replace ALL occurrences (default: false, replaces only the first)' },
        },
        required: ['path', 'target_text', 'replacement_text'],
      },
    },
    {
      name: 'multi_edit_file',
      description: 'Apply MULTIPLE surgical edits to a single file in one tool call. ' +
        'Each edit is a { target_text, replacement_text } pair applied sequentially. ' +
        'Use this when making several changes to the same file (e.g. adding imports AND modifying functions). ' +
        'Returns a summary showing which edits succeeded and which failed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
          edits: {
            type: 'array',
            description: 'Array of edit objects, each with target_text and replacement_text',
            items: {
              type: 'object',
              properties: {
                target_text: { type: 'string', description: 'Exact text to find' },
                replacement_text: { type: 'string', description: 'Text to replace it with' },
              },
              required: ['target_text', 'replacement_text'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
    {
      name: 'verify_file',
      description: 'Validates the syntax of a file. Supports: .js/.mjs (Node --check), .py (py_compile), ' +
        '.json (JSON.parse), .html (tag balance check), .css (brace balance check). ' +
        'Returns OK or detailed error messages. Use after writing or editing code files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to verify' },
        },
        required: ['path'],
      },
    },
    {
      name: 'append_file',
      description: 'Appends text to an existing file (or creates it).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'delete_file',
      description: 'Deletes a file or empty directory.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'list_directory',
      description: 'Lists files and folders in a directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: current working dir)' },
        },
      },
    },
    {
      name: 'search_files',
      description: 'Grep for a text pattern across files.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          directory: { type: 'string', description: 'Directory to search (default: cwd)' },
          file_types: { type: 'string', description: 'Comma-separated extensions e.g. "js,ts,py"' },
        },
        required: ['pattern'],
      },
    },

    // ════════════════════════════════
    //  TERMINAL TOOLS
    // ════════════════════════════════
    {
      name: 'run_terminal',
      description: 'Runs ANY shell command synchronously and returns stdout+stderr. ' +
        'Full access — no allowlist. Use for: install packages, compile, test, git, ' +
        'move/copy files, curl, python scripts, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command string to execute' },
          cwd: { type: 'string', description: 'Working directory override (optional)' },
          timeout_seconds: { type: 'number', description: 'Max seconds to wait (default 30)' },
        },
        required: ['command'],
      },
    },
    {
      name: 'run_background',
      description: 'Starts a long-running process in the background (e.g. a dev server). ' +
        'Returns a process ID you can use with get_background_output and kill_process.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run in background' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
          label: { type: 'string', description: 'Human-readable label e.g. "dev-server"' },
        },
        required: ['command'],
      },
    },
    {
      name: 'get_background_output',
      description: 'Returns buffered stdout/stderr from a background process.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Process ID returned by run_background' },
        },
        required: ['id'],
      },
    },
    {
      name: 'kill_process',
      description: 'Kills a background process by its ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Process ID from run_background' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_running_processes',
      description: 'Lists currently running background processes started via run_background.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'set_cwd',
      description: 'Changes the working directory used by run_terminal and other tools.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to new cwd' },
        },
        required: ['path'],
      },
    },
    {
      name: 'get_env',
      description: 'Returns environment variables. Pass names array for specific vars, or empty for all.',
      inputSchema: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, description: 'Env var names (optional)' },
        },
      },
    },
    {
      name: 'get_system_info',
      description: 'Returns OS, CPU, memory, cwd, Node version, hostname.',
      inputSchema: { type: 'object', properties: {} },
    },

    // ════════════════════════════════
    //  APP NAVIGATION TOOLS
    // ════════════════════════════════
    {
      name: 'open_url',
      description: 'Opens a URL in the default browser (or a specific browser).',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open' },
          browser: { type: 'string', description: 'Browser to use: "chrome", "firefox", "chromium" (default: system default)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'open_application',
      description: 'Launches a desktop application by name or executable path.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'App name or path, e.g. "code", "nautilus", "vlc", "/usr/bin/gedit"' },
          args: { type: 'array', items: { type: 'string' }, description: 'Optional command-line arguments' },
        },
        required: ['app'],
      },
    },
    {
      name: 'focus_window',
      description: 'Brings a window to the foreground by its title substring (uses wmctrl).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Substring of the window title to focus' },
        },
        required: ['title'],
      },
    },
    {
      name: 'list_windows',
      description: 'Lists all open windows with their titles and IDs (uses wmctrl).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'send_keys',
      description: 'Sends keyboard shortcuts or key sequences to the focused window (uses xdotool). ' +
        'Examples: "ctrl+c", "ctrl+alt+t", "Return", "super".',
      inputSchema: {
        type: 'object',
        properties: {
          keys: { type: 'string', description: 'Key combo, e.g. "ctrl+s", "alt+F4", "Return"' },
          window_title: { type: 'string', description: 'Focus this window first (optional)' },
        },
        required: ['keys'],
      },
    },
    {
      name: 'type_text',
      description: 'Types a string of text into the currently focused input (uses xdotool type).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
          delay_ms: { type: 'number', description: 'Delay between keystrokes ms (default 20)' },
        },
        required: ['text'],
      },
    },
    {
      name: 'mouse_click',
      description: 'Moves the mouse to (x, y) and clicks. Button: 1=left, 2=middle, 3=right.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'number', description: '1=left, 2=middle, 3=right (default 1)' },
          double: { type: 'boolean', description: 'Double-click if true' },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'take_screenshot',
      description: 'Captures a screenshot of the entire screen or a specific window and saves it to a file.',
      inputSchema: {
        type: 'object',
        properties: {
          output_path: { type: 'string', description: 'File path to save PNG (default: /tmp/screenshot.png)' },
          window_title: { type: 'string', description: 'Capture only this window (optional, uses title match)' },
        },
      },
    },
    {
      name: 'get_clipboard',
      description: 'Returns the current clipboard text content.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'set_clipboard',
      description: 'Sets the clipboard to the given text.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to copy to clipboard' },
        },
        required: ['text'],
      },
    },
    {
      name: 'get_screen_resolution',
      description: 'Returns the current display resolution.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'speak_text',
      description: 'Uses text-to-speech to speak a message (uses espeak or spd-say).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message to speak' },
          speed: { type: 'number', description: 'Speaking speed (default 150)' }
        },
        required: ['text'],
      },
    },
    {
      name: 'send_notification',
      description: 'Sends a desktop notification (uses notify-send).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notification title' },
          message: { type: 'string', description: 'Notification body' },
          urgency: { type: 'string', description: 'low, normal, critical' }
        },
        required: ['message'],
      },
    },
    {
      name: 'install_package',
      description: 'Installs a package using various manager (npm, pip, apt).',
      inputSchema: {
        type: 'object',
        properties: {
          manager: { type: 'string', description: 'npm, pip, or apt' },
          package: { type: 'string', description: 'Name of the package' }
        },
        required: ['manager', 'package'],
      },
    },
    {
      name: 'open_path',
      description: 'Opens a file or folder using the system default handler (xdg-open).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to file or folder' }
        },
        required: ['path'],
      },
    },

    // ════════════════════════════════
    //  LOCAL ACCESS TOOLS
    // ════════════════════════════════
    {
      name: 'open_terminal',
      description:
        'Opens a real terminal window on the local desktop. Optionally runs a command inside it. ' +
        'Tries gnome-terminal, xterm, konsole, xfce4-terminal in order. ' +
        'Use this whenever the user asks to "open a terminal" or when you need an interactive shell window.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to run inside the terminal (optional). The terminal stays open after it finishes.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory to open the terminal in (default: current cwd)',
          },
          title: {
            type: 'string',
            description: 'Window title for the terminal (optional)',
          },
        },
      },
    },
    {
      name: 'read_url',
      description:
        'Fetches the text content of any URL (webpage, API, raw file). ' +
        'Returns the response body as plain text. Useful for reading docs, APIs, or web pages.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          method: { type: 'string', description: 'HTTP method: GET or POST (default: GET)' },
          body: { type: 'string', description: 'Request body for POST requests (optional)' },
          headers: {
            type: 'object',
            description: 'Extra HTTP headers as key-value pairs (optional)',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['url'],
      },
    },

    // ════════════════════════════════
    //  GIT & POWER TOOLS
    // ════════════════════════════════
    {
      name: 'git_status',
      description: 'Returns git status, recent commits, and branch info for the current or given repo.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Repo path (default: current cwd)' },
        },
      },
    },
    {
      name: 'git_diff',
      description: 'Shows git diff for unstaged or staged changes, or a specific file.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Specific file to diff (optional)' },
          staged: { type: 'boolean', description: 'Show staged changes (default false)' },
          cwd: { type: 'string', description: 'Repo path (default: current cwd)' },
        },
      },
    },
    {
      name: 'find_replace',
      description: 'Finds and replaces text in a file. Supports literal or regex patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit' },
          find: { type: 'string', description: 'Text or regex to find' },
          replace: { type: 'string', description: 'Replacement text' },
          regex: { type: 'boolean', description: 'Treat find as regex (default false)' },
          all: { type: 'boolean', description: 'Replace all occurrences (default true)' },
        },
        required: ['path', 'find', 'replace'],
      },
    },
    {
      name: 'move_file',
      description: 'Moves or renames a file or directory.',
      inputSchema: {
        type: 'object',
        properties: {
          src: { type: 'string', description: 'Source path' },
          dest: { type: 'string', description: 'Destination path' },
        },
        required: ['src', 'dest'],
      },
    },

    // ════════════════════════════════
    //  N8N WORKFLOW TOOLS
    // ════════════════════════════════
    {
      name: 'n8n_list_workflows',
      description: 'Lists all workflows in n8n. Returns id, name, active status for each workflow.',
      inputSchema: {
        type: 'object',
        properties: {
          active: { type: 'boolean', description: 'Filter by active status (optional)' },
          tags: { type: 'string', description: 'Filter by tag name (optional)' },
        },
      },
    },
    {
      name: 'n8n_get_workflow',
      description: 'Gets full details of an n8n workflow by ID, including all nodes and connections.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Workflow ID' },
        },
        required: ['id'],
      },
    },
    {
      name: 'n8n_create_workflow',
      description: 'Creates a new n8n workflow. Provide name and optionally nodes/connections JSON to build the full workflow.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Workflow name' },
          nodes: {
            type: 'array',
            description: 'Array of node objects. Each node needs: name, type, position:[x,y], parameters:{}, typeVersion.',
            items: { type: 'object' },
          },
          connections: {
            type: 'object',
            description: 'Connections map: { "NodeName": { "main": [[{ "node": "NextNode", "type": "main", "index": 0 }]] } }',
          },
          settings: { type: 'object', description: 'Workflow settings (optional)' },
          active: { type: 'boolean', description: 'Activate immediately after creation (default false)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'n8n_update_workflow',
      description: 'Updates an existing n8n workflow by ID. Pass only the fields to change.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Workflow ID to update' },
          name: { type: 'string', description: 'New workflow name (optional)' },
          nodes: { type: 'array', description: 'Updated nodes array (optional)', items: { type: 'object' } },
          connections: { type: 'object', description: 'Updated connections (optional)' },
          settings: { type: 'object', description: 'Updated settings (optional)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'n8n_activate_workflow',
      description: 'Activates or deactivates an n8n workflow.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Workflow ID' },
          active: { type: 'boolean', description: 'true to activate, false to deactivate' },
        },
        required: ['id', 'active'],
      },
    },
    {
      name: 'n8n_delete_workflow',
      description: 'Deletes an n8n workflow permanently by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Workflow ID to delete' },
        },
        required: ['id'],
      },
    },
    {
      name: 'n8n_execute_workflow',
      description: 'Manually triggers execution of an n8n workflow. Returns the execution ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Workflow ID to execute' },
          data: { type: 'object', description: 'Input data to pass to the workflow (optional)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'n8n_list_executions',
      description: 'Lists recent executions of n8n workflows. Optionally filter by workflow ID.',
      inputSchema: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: 'Filter by workflow ID (optional)' },
          limit: { type: 'number', description: 'Max results to return (default 20)' },
          status: { type: 'string', description: 'Filter by status: success, error, waiting (optional)' },
        },
      },
    },
    {
      name: 'n8n_from_template',
      description: 'Creates a fully-wired n8n workflow from a built-in template. Templates: schedule-fetch-notify, webhook-store, daily-digest, error-monitor, leetcode-tracker. Pass params like cron, url, webhookUrl, username to customize.',
      inputSchema: {
        type: 'object',
        properties: {
          template: { type: 'string', description: 'Template name. One of: schedule-fetch-notify, webhook-store, daily-digest, error-monitor, leetcode-tracker' },
          params: { type: 'object', description: 'Template params: name, cron, url, webhookUrl, username, path — depends on template' },
          active: { type: 'boolean', description: 'Activate after creation (default false)' },
        },
        required: ['template'],
      },
    },
    {
      name: 'n8n_validate_workflow',
      description: 'Validates a workflow JSON before creating it. Checks node names, connections, and required fields. Returns errors list.',
      inputSchema: {
        type: 'object',
        properties: {
          workflow: { type: 'object', description: 'Workflow object with name, nodes, connections to validate' },
        },
        required: ['workflow'],
      },
    },
    {
      name: 'n8n_clone_workflow',
      description: 'Clones an existing workflow by ID into a new workflow with a new name.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Source workflow ID to clone' },
          new_name: { type: 'string', description: 'Name for the cloned workflow' },
          active: { type: 'boolean', description: 'Activate clone immediately (default false)' },
        },
        required: ['id', 'new_name'],
      },
    },
    {
      name: 'host_website',
      description: 'Effortlessly host a local directory as a live public website using localtunnel. Starts an HTTP server and a secure tunnel instantly. Returns the live URL.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Directory to host (default: current cwd)' },
          port: { type: 'number', description: 'Local port to use (default: 8080)' }
        }
      }
    },
  ],
}));

// ─── Tool Handlers ───
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      case 'host_website': {
        const id = bgNextId++;
        const dir = args.directory ? path.resolve(currentCwd, args.directory) : currentCwd;
        const port = args.port || 8080;
        const label = `live-host-${id}`;
        let output = '';

        const cmd = `npx -y serve -l ${port} "${dir}" & npx -y localtunnel --port ${port}`;
        
        const proc = spawn('bash', ['-c', cmd], {
          cwd: currentCwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        
        let liveUrl = '';
        let resolved = false;

        return new Promise((resolve) => {
          proc.stdout.on('data', d => {
            const str = d.toString();
            output += str;
            if (output.length > 50000) output = output.slice(-40000);
            
            const urlMatch = str.match(/(https:\/\/[a-zA-Z0-9-]+\.loca\.lt)/);
            if (!resolved && urlMatch) {
              liveUrl = urlMatch[1];
              resolved = true;
              bgProcesses.set(id, { proc, label, get output() { return output; }, exitCode: null });
              resolve({ content: [{ type: 'text', text: `✅ Website is now LIVE!\n\n🌐 Live URL: ${liveUrl}\n📂 Directory: ${dir}\n\nNote: This is running as background process #${id}. You can view logs with get_background_output or stop it with kill_process.` }] });
            }
          });
          
          proc.stderr.on('data', d => {
            output += d.toString();
            if (output.length > 50000) output = output.slice(-40000);
          });

          proc.on('exit', code => { 
            if (bgProcesses.has(id)) bgProcesses.get(id).exitCode = code;
            if (!resolved) {
              resolved = true;
              resolve({ content: [{ type: 'text', text: `❌ Failed to start hosting. Process exited with code ${code}.\n\nOutput:\n${output}` }], isError: true });
            }
          });
          
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              bgProcesses.set(id, { proc, label, get output() { return output; }, exitCode: null });
              resolve({ content: [{ type: 'text', text: `⚠️ Hosting started as background process #${id}, but could not parse the live URL in time.\n\nCheck logs with get_background_output.` }] });
            }
          }, 15000);
        });
      }

      // ── File tools ──────────────────────────────────────────────────────

      case 'read_file': {
        const fp = safeJoin(currentCwd, args.path);
        const data = await fs.readFile(fp, 'utf-8');
        // Allow up to ~200k chars for reading files so the AI doesn't lose context on large files
        const maxReadChars = 200000;
        const textOut = data.length <= maxReadChars 
          ? data 
          : data.slice(0, maxReadChars) + `\n\n... [truncated — ${data.length - maxReadChars} chars omitted. File too large!]`;
        return { content: [{ type: 'text', text: textOut }] };
      }

      case 'write_file': {
        const fp = safeJoin(currentCwd, args.path);
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await fs.writeFile(fp, args.content, 'utf-8');
        return { content: [{ type: 'text', text: `✅ Wrote ${args.content.length} bytes to ${fp}` }] };
      }

      case 'edit_file': {
        const fp = safeJoin(currentCwd, args.path);
        let data;
        try {
          data = await fs.readFile(fp, 'utf-8');
        } catch (readErr) {
          return { content: [{ type: 'text', text: `❌ Cannot read file ${fp}: ${readErr.message}` }], isError: true };
        }

        // Normalize line endings to avoid \r\n vs \n matching issues
        const normalizedData = data.replace(/\r\n/g, '\n');
        const normalizedTarget = args.target_text.replace(/\r\n/g, '\n');

        if (!normalizedData.includes(normalizedTarget)) {
          // Build diagnostic: show first 200 lines + fuzzy match hints
          const lines = normalizedData.split('\n');
          const preview = lines.slice(0, 200).map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
          const totalLines = lines.length;

          // Try to find partial matches (first 40 non-whitespace chars of target)
          const targetTrimmed = normalizedTarget.trim();
          const searchSnippet = targetTrimmed.slice(0, 40);
          const partialMatches = [];
          for (let i = 0; i < lines.length && partialMatches.length < 5; i++) {
            if (lines[i].includes(searchSnippet) || (searchSnippet.length > 10 && lines[i].includes(searchSnippet.slice(0, 20)))) {
              partialMatches.push(`  Line ${i + 1}: ${lines[i].slice(0, 120)}`);
            }
          }

          const hint = partialMatches.length > 0
            ? `\n\n🔍 PARTIAL MATCHES (lines containing similar text):\n${partialMatches.join('\n')}\n\nCopy the EXACT text from above, including whitespace and indentation.`
            : `\n\n🔍 No partial matches found for: "${searchSnippet}"`;

          return {
            content: [{
              type: 'text',
              text: `❌ Target text NOT FOUND in ${fp} (${totalLines} lines).\n` +
                `The target_text must match character-for-character including whitespace and indentation.\n` +
                `\n📄 FILE CONTENT (first 200 lines):\n${preview}` +
                (totalLines > 200 ? `\n... (${totalLines - 200} more lines)` : '') +
                hint +
                `\n\n💡 TIP: Use read_file first to see the exact content, then copy the precise text block.`
            }],
            isError: true,
          };
        }

        // Apply replacement (first occurrence or all)
        const replaceAll = args.replace_all === true;
        const beforeLines = data.split('\n').length;
        if (replaceAll) {
          data = data.split(args.target_text).join(args.replacement_text);
        } else {
          data = data.replace(args.target_text, args.replacement_text);
        }
        const afterLines = data.split('\n').length;
        await fs.writeFile(fp, data, 'utf-8');

        // Count occurrences replaced
        const occurrences = replaceAll
          ? (data.split(args.replacement_text).length - 1)
          : 1;

        // Find the line number where replacement was made
        const replacedIdx = data.indexOf(args.replacement_text);
        const lineNum = replacedIdx >= 0 ? data.slice(0, replacedIdx).split('\n').length : '?';

        return {
          content: [{
            type: 'text',
            text: `✅ Edited ${fp}\n` +
              `   Replaced ${occurrences} occurrence(s) at line ~${lineNum}\n` +
              `   Lines: ${beforeLines} → ${afterLines}`
          }],
        };
      }

      case 'multi_edit_file': {
        const fp = safeJoin(currentCwd, args.path);
        let data;
        try {
          data = await fs.readFile(fp, 'utf-8');
        } catch (readErr) {
          return { content: [{ type: 'text', text: `❌ Cannot read file ${fp}: ${readErr.message}` }], isError: true };
        }

        const edits = args.edits || [];
        if (edits.length === 0) {
          return { content: [{ type: 'text', text: `❌ No edits provided. Pass an array of { target_text, replacement_text } objects.` }], isError: true };
        }

        const results = [];
        let successCount = 0;
        let failCount = 0;
        
        let normalizedData = data.replace(/\r\n/g, '\n');

        for (let i = 0; i < edits.length; i++) {
          const edit = edits[i];
          const label = `Edit #${i + 1}`;
          if (!edit.target_text || edit.replacement_text === undefined) {
            results.push(`${label}: ❌ Missing target_text or replacement_text`);
            failCount++;
            continue;
          }

          const normalizedTarget = edit.target_text.replace(/\r\n/g, '\n');

          if (!normalizedData.includes(normalizedTarget)) {
            // Show a snippet of what was searched for
            const snippet = normalizedTarget.slice(0, 60).replace(/\n/g, '\\n');
            results.push(`${label}: ❌ Target not found: "${snippet}..."`);
            failCount++;
            continue;
          }

          normalizedData = normalizedData.replace(normalizedTarget, edit.replacement_text.replace(/\r\n/g, '\n'));
          successCount++;
          const snippet = edit.replacement_text.slice(0, 40).replace(/\n/g, '\\n');
          results.push(`${label}: ✅ Replaced → "${snippet}..."`);
        }

        if (successCount > 0) {
          await fs.writeFile(fp, normalizedData, 'utf-8');
        }

        const status = failCount === 0 ? '✅' : (successCount > 0 ? '⚠️' : '❌');
        return {
          content: [{
            type: 'text',
            text: `${status} Multi-edit on ${fp}: ${successCount}/${edits.length} succeeded\n\n${results.join('\n')}` +
              (failCount > 0 ? `\n\n💡 For failed edits, use read_file to see the exact file content and retry with corrected target_text.` : '')
          }],
          isError: failCount > 0 && successCount === 0,
        };
      }

      case 'verify_file': {
        const fp = safeJoin(currentCwd, args.path);
        const ext = path.extname(fp).toLowerCase();
        let verifyCmd = null;
        let verifyLabel = '';

        switch (ext) {
          case '.js':
          case '.mjs':
            verifyCmd = `node --check "${fp}" 2>&1`;
            verifyLabel = 'JavaScript syntax (node --check)';
            break;
          case '.ts':
            verifyCmd = `npx -y tsc --noEmit --allowJs "${fp}" 2>&1 || node --check "${fp}" 2>&1`;
            verifyLabel = 'TypeScript syntax';
            break;
          case '.py':
            verifyCmd = `python3 -m py_compile "${fp}" 2>&1`;
            verifyLabel = 'Python syntax (py_compile)';
            break;
          case '.json':
            verifyCmd = `node -e "JSON.parse(require('fs').readFileSync('${fp.replace(/'/g, "\\'")}','utf-8')); console.log('Valid JSON')" 2>&1`;
            verifyLabel = 'JSON parse validation';
            break;
          case '.html':
          case '.htm': {
            // Check for unclosed major tags
            try {
              const htmlContent = await fs.readFile(fp, 'utf-8');
              const majorTags = ['html', 'head', 'body', 'div', 'section', 'main', 'header', 'footer', 'nav', 'article', 'form', 'table', 'ul', 'ol', 'script', 'style'];
              const issues = [];
              for (const tag of majorTags) {
                const openRe = new RegExp(`<${tag}[\\s>]`, 'gi');
                const closeRe = new RegExp(`</${tag}>`, 'gi');
                const opens = (htmlContent.match(openRe) || []).length;
                const closes = (htmlContent.match(closeRe) || []).length;
                if (opens > closes) issues.push(`  ⚠️ <${tag}> opened ${opens}x but closed ${closes}x`);
              }
              if (issues.length === 0) {
                return { content: [{ type: 'text', text: `✅ HTML tag balance check passed for ${fp}` }] };
              }
              return { content: [{ type: 'text', text: `⚠️ HTML tag balance issues in ${fp}:\n${issues.join('\n')}` }], isError: true };
            } catch (e) {
              return { content: [{ type: 'text', text: `❌ Cannot read ${fp}: ${e.message}` }], isError: true };
            }
          }
          case '.css': {
            // Check brace balance
            try {
              const cssContent = await fs.readFile(fp, 'utf-8');
              let braceDepth = 0;
              let lineNum = 1;
              const issues = [];
              for (const char of cssContent) {
                if (char === '\n') lineNum++;
                if (char === '{') braceDepth++;
                if (char === '}') {
                  braceDepth--;
                  if (braceDepth < 0) {
                    issues.push(`  ⚠️ Extra closing brace at line ~${lineNum}`);
                    braceDepth = 0;
                  }
                }
              }
              if (braceDepth > 0) issues.push(`  ⚠️ ${braceDepth} unclosed brace(s) at end of file`);
              if (issues.length === 0) {
                return { content: [{ type: 'text', text: `✅ CSS brace balance check passed for ${fp}` }] };
              }
              return { content: [{ type: 'text', text: `⚠️ CSS issues in ${fp}:\n${issues.join('\n')}` }], isError: true };
            } catch (e) {
              return { content: [{ type: 'text', text: `❌ Cannot read ${fp}: ${e.message}` }], isError: true };
            }
          }
          default:
            return { content: [{ type: 'text', text: `⚠️ No syntax verifier for ${ext} files. Supported: .js, .mjs, .ts, .py, .json, .html, .css` }] };
        }

        // For command-based verifiers (JS, TS, Python, JSON)
        if (verifyCmd) {
          const { out, error } = await execAsync(verifyCmd, { timeout: 15000 });
          if (error) {
            return {
              content: [{ type: 'text', text: `❌ ${verifyLabel} FAILED for ${fp}:\n${out}` }],
              isError: true,
            };
          }
          return { content: [{ type: 'text', text: `✅ ${verifyLabel} passed for ${fp}${out.trim() ? '\n' + out.trim() : ''}` }] };
        }

        return { content: [{ type: 'text', text: `⚠️ Verification not available for ${ext}` }] };
      }

      case 'append_file': {
        const fp = safeJoin(currentCwd, args.path);
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await fs.appendFile(fp, args.content, 'utf-8');
        return { content: [{ type: 'text', text: `✅ Appended ${args.content.length} bytes to ${fp}` }] };
      }

      case 'delete_file': {
        const fp = safeJoin(currentCwd, args.path);
        await fs.rm(fp, { recursive: false });
        return { content: [{ type: 'text', text: `✅ Deleted ${fp}` }] };
      }

      case 'list_directory': {
        const dp = safeJoin(currentCwd, args.path || '.');
        const entries = await fs.readdir(dp, { withFileTypes: true });
        const list = entries.map(e => {
          if (e.isDirectory()) return `📁 ${e.name}/`;
          const ext = path.extname(e.name).toLowerCase();
          const icon =
            ['.js', '.ts', '.jsx', '.tsx', '.mjs'].includes(ext) ? '📜' :
            ['.json', '.yaml', '.yml', '.toml', '.env'].includes(ext) ? '⚙️' :
            ['.md', '.txt', '.rst'].includes(ext) ? '📝' :
            ['.py', '.rb', '.go', '.rs', '.php'].includes(ext) ? '🐍' :
            ext === '.sh' ? '🔧' : '📄';
          return `${icon} ${e.name}`;
        }).join('\n');
        return { content: [{ type: 'text', text: list || '(empty directory)' }] };
      }

      case 'search_files': {
        const dir = safeJoin(currentCwd, args.directory || '.');
        const safePattern = (args.pattern || '').replace(/'/g, "\\'");
        const types = (args.file_types || 'js,ts,jsx,tsx,json,md,txt,yaml,yml,sh,py,css,html').split(',');
        const includes = types.map(t => `--include="*.${t.trim()}"`).join(' ');
        const cmd = `grep -rn ${includes} -i '${safePattern}' '${dir}' 2>/dev/null | head -50`;
        const { stdout } = await execAsync(cmd, {});
        return { content: [{ type: 'text', text: stdout.trim() || `No matches for: ${args.pattern}` }] };
      }

      // ── Terminal tools ──────────────────────────────────────────────────

      case 'run_terminal': {
        // Accept both "command" and "cmd" — AIs frequently use "cmd" as an alias
        const command = args.command || args.cmd;
        if (!command || typeof command !== 'string') {
          return {
            content: [{ type: 'text', text: `❌ run_terminal requires a "command" argument (string). Received args: ${JSON.stringify(args)}\nUsage: {"tool": "run_terminal", "args": {"command": "your shell command here"}}` }],
            isError: true,
          };
        }
        const cwd = args.cwd ? path.resolve(currentCwd, args.cwd) : currentCwd;
        const timeout = (args.timeout_seconds || 30) * 1000;
        const { out, error } = await execAsync(command, { cwd, timeout });
        const label = error ? `⚠️ exit error` : '✅';
        return { content: [{ type: 'text', text: `${label}\n${truncate(out, command)}` }], isError: !!error };
      }

      case 'run_background': {
        const id = bgNextId++;
        const cwd = args.cwd ? path.resolve(currentCwd, args.cwd) : currentCwd;
        const label = args.label || `proc-${id}`;
        let output = '';

        const proc = spawn('bash', ['-c', args.command], {
          cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', d => { output += d.toString(); if (output.length > 50000) output = output.slice(-40000); });
        proc.stderr.on('data', d => { output += d.toString(); if (output.length > 50000) output = output.slice(-40000); });

        let exitCode = null;
        proc.on('exit', code => { exitCode = code; });

        bgProcesses.set(id, { proc, label, get output() { return output; }, get exitCode() { return exitCode; } });
        return { content: [{ type: 'text', text: `✅ Started background process #${id} [${label}]\nPID: ${proc.pid}\nCommand: ${args.command}` }] };
      }

      case 'get_background_output': {
        const entry = bgProcesses.get(Number(args.id));
        if (!entry) return { content: [{ type: 'text', text: `❌ No background process #${args.id}` }], isError: true };
        const status = entry.exitCode !== null ? `Exited: ${entry.exitCode}` : 'Running';
        return { content: [{ type: 'text', text: `Process #${args.id} [${entry.label}] — ${status}\n\n${truncate(entry.output)}` }] };
      }

      case 'kill_process': {
        const entry = bgProcesses.get(Number(args.id));
        if (!entry) return { content: [{ type: 'text', text: `❌ No background process #${args.id}` }], isError: true };
        try {
          process.kill(-entry.proc.pid, 'SIGTERM');
        } catch (e) {
          entry.proc.kill('SIGTERM');
        }
        bgProcesses.delete(Number(args.id));
        return { content: [{ type: 'text', text: `✅ Killed process #${args.id} [${entry.label}]` }] };
      }

      case 'get_running_processes': {
        if (bgProcesses.size === 0) return { content: [{ type: 'text', text: '(no background processes running)' }] };
        const list = [...bgProcesses.entries()].map(([id, e]) =>
          `#${id} [${e.label}] — ${e.exitCode !== null ? 'Exited: ' + e.exitCode : 'Running'}`
        ).join('\n');
        return { content: [{ type: 'text', text: list }] };
      }

      case 'set_cwd': {
        const next = path.resolve(currentCwd, args.path);
        try {
          const stat = await fs.stat(next);
          if (!stat.isDirectory()) throw new Error('Not a directory');
          currentCwd = next;
          return { content: [{ type: 'text', text: `✅ Working directory changed to: ${currentCwd}` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true };
        }
      }

      case 'get_env': {
        const names = args.names;
        if (names && names.length > 0) {
          const result = {};
          for (const k of names) result[k] = process.env[k] ?? null;
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(process.env, null, 2) }] };
      }

      case 'get_system_info': {
        return {
          content: [{
            type: 'text', text: JSON.stringify({
              platform: os.platform(), arch: os.arch(),
              hostname: os.hostname(), cwd: currentCwd,
              home: os.homedir(), node_version: process.version,
              memory_free_mb: Math.round(os.freemem() / 1024 / 1024),
              memory_total_mb: Math.round(os.totalmem() / 1024 / 1024),
              uptime_minutes: Math.round(os.uptime() / 60),
              cpu_model: os.cpus()[0]?.model || 'unknown',
              cpu_cores: os.cpus().length,
            }, null, 2),
          }],
        };
      }

      // ── App navigation tools ────────────────────────────────────────────

      case 'open_url': {
        const url = args.url;
        let cmd;
        switch ((args.browser || '').toLowerCase()) {
          case 'chrome':     cmd = `google-chrome "${url}"`; break;
          case 'chromium':   cmd = `chromium-browser "${url}"`; break;
          case 'firefox':    cmd = `firefox "${url}"`; break;
          default:           cmd = `xdg-open "${url}"`; break;
        }
        const { out } = await execAsync(cmd);
        return { content: [{ type: 'text', text: `✅ Opened URL: ${url}\n${out}` }] };
      }

      case 'open_application': {
        const appArgs = (args.args || []).join(' ');
        const { out, error } = await execAsync(`${args.app} ${appArgs} &`);
        return { content: [{ type: 'text', text: `✅ Launched: ${args.app} ${appArgs}\n${out}` }], isError: !!error };
      }

      case 'focus_window': {
        const { out, error } = await execAsync(`wmctrl -a "${args.title}"`);
        if (error) return { content: [{ type: 'text', text: `❌ wmctrl error: ${out}\nMake sure wmctrl is installed: sudo apt install wmctrl` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Focused window matching: "${args.title}"` }] };
      }

      case 'list_windows': {
        const { out, error } = await execAsync('wmctrl -l');
        if (error) return { content: [{ type: 'text', text: `❌ wmctrl error: ${out}\nInstall with: sudo apt install wmctrl` }], isError: true };
        return { content: [{ type: 'text', text: out }] };
      }

      case 'send_keys': {
        let cmd = '';
        if (args.window_title) {
          cmd += `wmctrl -a "${args.window_title}" && sleep 0.2 && `;
        }
        cmd += `xdotool key "${args.keys}"`;
        const { out, error } = await execAsync(cmd);
        if (error) return { content: [{ type: 'text', text: `❌ xdotool error: ${out}\nInstall with: sudo apt install xdotool` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Sent keys: ${args.keys}` }] };
      }

      case 'type_text': {
        const delay = args.delay_ms ?? 20;
        const safeText = args.text.replace(/"/g, '\\"');
        const { out, error } = await execAsync(`xdotool type --delay ${delay} "${safeText}"`);
        if (error) return { content: [{ type: 'text', text: `❌ xdotool error: ${out}\nInstall with: sudo apt install xdotool` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Typed ${args.text.length} characters` }] };
      }

      case 'mouse_click': {
        const btn = args.button ?? 1;
        const dbl = args.double ? '--repeat 2 --delay 100' : '';
        const { out, error } = await execAsync(`xdotool mousemove ${args.x} ${args.y} && xdotool click ${dbl} ${btn}`);
        if (error) return { content: [{ type: 'text', text: `❌ xdotool error: ${out}` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Clicked (${args.x}, ${args.y}) button=${btn}` }] };
      }

      case 'take_screenshot': {
        const output = args.output_path || '/tmp/screenshot.png';
        let cmd;
        if (args.window_title) {
          cmd = `import -window "$(xdotool search --name '${args.window_title}' | head -1)" "${output}"`;
        } else {
          // Try scrot first, fall back to import (ImageMagick)
          cmd = `scrot "${output}" 2>/dev/null || import -window root "${output}"`;
        }
        const { out, error } = await execAsync(cmd);
        if (error && !existsSync(output)) {
          return { content: [{ type: 'text', text: `❌ Screenshot failed: ${out}\nInstall scrot: sudo apt install scrot` }], isError: true };
        }
        return { content: [{ type: 'text', text: `✅ Screenshot saved to: ${output}` }] };
      }

      case 'get_clipboard': {
        const { out, error } = await execAsync('xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null || wl-paste 2>/dev/null');
        if (error) return { content: [{ type: 'text', text: `❌ Clipboard read failed: ${out}\nInstall: sudo apt install xclip` }], isError: true };
        return { content: [{ type: 'text', text: out || '(clipboard empty)' }] };
      }

      case 'set_clipboard': {
        const safe = args.text.replace(/'/g, "'\\''");
        const { out, error } = await execAsync(
          `echo '${safe}' | xclip -selection clipboard 2>/dev/null || ` +
          `echo '${safe}' | xsel --clipboard --input 2>/dev/null || ` +
          `echo '${safe}' | wl-copy 2>/dev/null`
        );
        if (error) return { content: [{ type: 'text', text: `❌ Clipboard write failed. Install: sudo apt install xclip` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Clipboard set (${args.text.length} chars)` }] };
      }

      case 'get_screen_resolution': {
        const { out } = await execAsync(`xrandr 2>/dev/null | grep ' connected' | grep -o '[0-9]*x[0-9]*+0+0' | head -1`);
        const res = out.trim().replace(/\+.*/, '') || 'unknown';
        return { content: [{ type: 'text', text: `Screen resolution: ${res}` }] };
      }

      case 'speak_text': {
        const cmd = `spd-say "${args.text.replace(/"/g, '')}" || espeak "${args.text.replace(/"/g, '')}" -s ${args.speed || 150}`;
        const { out, error } = await execAsync(cmd);
        return { content: [{ type: 'text', text: `✅ Said: ${args.text}` }], isError: !!error };
      }

      case 'send_notification': {
        const urgency = args.urgency || 'normal';
        const title = args.title || 'MCP Bridge';
        const cmd = `notify-send -u ${urgency} "${title}" "${args.message}"`;
        const { out, error } = await execAsync(cmd);
        return { content: [{ type: 'text', text: `✅ Notification sent` }], isError: !!error };
      }

      case 'install_package': {
        let cmd = '';
        if (args.manager === 'npm') cmd = `npm install ${args.package}`;
        else if (args.manager === 'pip') cmd = `pip install ${args.package}`;
        else if (args.manager === 'apt') cmd = `sudo apt-get install -y ${args.package}`;
        else return { content: [{ type: 'text', text: `❌ Unknown manager: ${args.manager}` }], isError: true };
        
        const { out, error } = await execAsync(cmd);
        return { content: [{ type: 'text', text: `${error ? '⚠️' : '✅'} ${cmd}\n${truncate(out)}` }], isError: !!error };
      }

      case 'open_path': {
        const fp = safeJoin(currentCwd, args.path);
        const { out, error } = await execAsync(`xdg-open "${fp}"`);
        return { content: [{ type: 'text', text: `✅ Opened: ${fp}` }], isError: !!error };
      }

      // ── Git & power tools ──────────────────────────────────────────

      case 'git_status': {
        const gitCwd = args.cwd ? path.resolve(currentCwd, args.cwd) : currentCwd;
        const [status, branch, log] = await Promise.all([
          execAsync('git status', { cwd: gitCwd }),
          execAsync('git branch --show-current 2>/dev/null', { cwd: gitCwd }),
          execAsync('git log --oneline -10 2>/dev/null', { cwd: gitCwd }),
        ]);
        const out = [
          `Branch: ${branch.stdout.trim() || '(none)'}`,
          '\n--- Status ---\n' + (status.stdout || status.stderr || '(not a git repo)').trim(),
          '\n--- Recent Commits ---\n' + (log.stdout.trim() || '(none)'),
        ].join('\n');
        return { content: [{ type: 'text', text: truncate(out) }] };
      }

      case 'git_diff': {
        const gitCwd = args.cwd ? path.resolve(currentCwd, args.cwd) : currentCwd;
        const staged = args.staged ? '--staged' : '';
        const file = args.file ? `-- "${args.file}"` : '';
        const { out } = await execAsync(`git diff ${staged} ${file}`, { cwd: gitCwd });
        return { content: [{ type: 'text', text: truncate(out || '(no diff)', 'git diff') }] };
      }

      case 'find_replace': {
        const fp = safeJoin(currentCwd, args.path);
        let content = await fs.readFile(fp, 'utf-8');
        const all = args.all !== false;
        let newContent;
        if (args.regex) {
          const flags = all ? 'g' : '';
          const re = new RegExp(args.find, flags);
          newContent = content.replace(re, args.replace);
        } else {
          if (all) {
            newContent = content.split(args.find).join(args.replace);
          } else {
            newContent = content.replace(args.find, args.replace);
          }
        }
        const changed = (content !== newContent);
        if (changed) await fs.writeFile(fp, newContent, 'utf-8');
        return { content: [{ type: 'text', text: changed ? `✅ Replaced in ${fp}` : `⚠️ Pattern not found in ${fp}` }] };
      }

      case 'move_file': {
        const src = safeJoin(currentCwd, args.src);
        const dest = safeJoin(currentCwd, args.dest);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(src, dest);
        return { content: [{ type: 'text', text: `✅ Moved: ${src} → ${dest}` }] };
      }

      // ── n8n workflow tools ──────────────────────────────────────────────

      case 'n8n_list_workflows': {
        let qs = '';
        if (args.active !== undefined) qs += `?active=${args.active}`;
        if (args.tags) qs += `${qs ? '&' : '?'}tags=${encodeURIComponent(args.tags)}`;
        const res = await n8nRequest('GET', `/workflows${qs}`);
        if (res.error) return { content: [{ type: 'text', text: `❌ n8n error: ${res.error}\n${res.raw || ''}\n\nMake sure n8n is running at ${N8N_BASE} and N8N_API_KEY is set.` }], isError: true };
        const list = (res.data || []).map(w =>
          `ID: ${w.id}  |  Name: ${w.name}  |  Active: ${w.active}  |  Nodes: ${(w.nodes||[]).length}`
        ).join('\n') || '(no workflows found)';
        return { content: [{ type: 'text', text: `✅ ${(res.data||[]).length} workflow(s):\n\n${list}` }] };
      }

      case 'n8n_get_workflow': {
        const res = await n8nRequest('GET', `/workflows/${args.id}`);
        if (res.error) return { content: [{ type: 'text', text: `❌ n8n error: ${res.error}` }], isError: true };
        return { content: [{ type: 'text', text: truncate(JSON.stringify(res, null, 2), `workflow ${args.id}`) }] };
      }

      case 'n8n_create_workflow': {
        const wfBody = {
          name: args.name,
          nodes: args.nodes || [buildNode('Start', 'n8n-nodes-base.manualTrigger', [250, 300])],
          connections: args.connections || {},
          settings: args.settings || { executionOrder: 'v1' },
          active: false,
        };
        const validation = validateWorkflow(wfBody);
        if (!validation.valid) return { content: [{ type: 'text', text: `❌ Workflow validation failed:\n${validation.errors.map(e=>'  • '+e).join('\n')}` }], isError: true };
        const res = await n8nRequest('POST', '/workflows', wfBody);
        if (res.error) return { content: [{ type: 'text', text: `❌ n8n create error: ${res.error}\n${res.raw || ''}` }], isError: true };
        if (args.active && res.id) await n8nRequest('PATCH', `/workflows/${res.id}`, { active: true });
        return { content: [{ type: 'text', text:
          `✅ Workflow created!\nID: ${res.id}\nName: ${res.name}\nActive: ${args.active ? 'true (activated)' : 'false'}\nNodes: ${(res.nodes||[]).length}\n\nOpen: ${N8N_BASE}/workflow/${res.id}` }] };
      }

      case 'n8n_from_template': {
        let wf;
        try { wf = buildWorkflowFromTemplate(args.template, args.params || {}); }
        catch(e) {
          const available = Object.keys(N8N_TEMPLATES).join(', ');
          return { content: [{ type: 'text', text: `❌ ${e.message}\nAvailable templates: ${available}` }], isError: true };
        }
        const validation = validateWorkflow(wf);
        if (!validation.valid) return { content: [{ type: 'text', text: `❌ Template validation failed:\n${validation.errors.join('\n')}` }], isError: true };
        const res = await n8nRequest('POST', '/workflows', wf);
        if (res.error) return { content: [{ type: 'text', text: `❌ n8n create error: ${res.error}\n${res.raw || ''}` }], isError: true };
        if (args.active && res.id) await n8nRequest('PATCH', `/workflows/${res.id}`, { active: true });
        return { content: [{ type: 'text', text:
          `✅ Workflow created from template "${args.template}"!\nID: ${res.id}\nName: ${res.name}\nNodes: ${(res.nodes||[]).length}\nActive: ${args.active ? 'true' : 'false'}\n\nOpen: ${N8N_BASE}/workflow/${res.id}` }] };
      }

      case 'n8n_validate_workflow': {
        const result = validateWorkflow(args.workflow || {});
        const nodeList = (args.workflow?.nodes || []).map((n,i) => `  ${i+1}. ${n.name} (${n.type})`).join('\n');
        if (result.valid) {
          return { content: [{ type: 'text', text: `✅ Workflow is valid!\nNodes (${args.workflow?.nodes?.length || 0}):\n${nodeList}` }] };
        }
        return { content: [{ type: 'text', text: `❌ Validation failed (${result.errors.length} error(s)):\n${result.errors.map(e=>'  • '+e).join('\n')}\n\nNodes:\n${nodeList}` }], isError: true };
      }

      case 'n8n_clone_workflow': {
        const src = await n8nRequest('GET', `/workflows/${args.id}`);
        if (src.error) return { content: [{ type: 'text', text: `❌ Could not fetch source workflow: ${src.error}` }], isError: true };
        const clone = { name: args.new_name, nodes: src.nodes, connections: src.connections, settings: src.settings || { executionOrder: 'v1' }, active: false };
        const res = await n8nRequest('POST', '/workflows', clone);
        if (res.error) return { content: [{ type: 'text', text: `❌ Clone failed: ${res.error}\n${res.raw || ''}` }], isError: true };
        if (args.active && res.id) await n8nRequest('PATCH', `/workflows/${res.id}`, { active: true });
        return { content: [{ type: 'text', text:
          `✅ Cloned "${src.name}" → "${args.new_name}"\nNew ID: ${res.id}\nNodes: ${(res.nodes||[]).length}\n\nOpen: ${N8N_BASE}/workflow/${res.id}` }] };
      }

      case 'n8n_update_workflow': {
        // First fetch existing workflow to merge changes
        const existing = await n8nRequest('GET', `/workflows/${args.id}`);
        if (existing.error) return { content: [{ type: 'text', text: `❌ n8n fetch error: ${existing.error}` }], isError: true };
        const body = {
          name: args.name || existing.name,
          nodes: args.nodes || existing.nodes,
          connections: args.connections || existing.connections,
          settings: args.settings || existing.settings,
          active: existing.active,
        };
        const res = await n8nRequest('PUT', `/workflows/${args.id}`, body);
        if (res.error) return { content: [{ type: 'text', text: `❌ n8n update error: ${res.error}\n${res.raw || ''}` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Workflow updated!\nID: ${res.id}\nName: ${res.name}\nNodes: ${(res.nodes||[]).length}` }] };
      }

      case 'n8n_activate_workflow': {
        const res = await n8nRequest('PATCH', `/workflows/${args.id}`, { active: args.active });
        if (res.error) return { content: [{ type: 'text', text: `❌ n8n activate error: ${res.error}\n${res.raw || ''}` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Workflow ${args.id} is now ${args.active ? '🟢 ACTIVE' : '🔴 INACTIVE'}` }] };
      }

      case 'n8n_delete_workflow': {
        const res = await n8nRequest('DELETE', `/workflows/${args.id}`);
        if (res.error) return { content: [{ type: 'text', text: `❌ n8n delete error: ${res.error}` }], isError: true };
        return { content: [{ type: 'text', text: `✅ Workflow ${args.id} deleted.` }] };
      }

      case 'n8n_execute_workflow': {
        const body = args.data ? { data: args.data } : {};
        const res = await n8nRequest('POST', `/workflows/${args.id}/run`, body);
        if (res.error) return { content: [{ type: 'text', text: `❌ n8n execute error: ${res.error}\n${res.raw || ''}` }], isError: true };
        return { content: [{ type: 'text', text:
          `✅ Workflow execution triggered!\nExecution ID: ${res.data?.executionId || res.executionId || '(check n8n)'}\nStatus: ${res.data?.status || 'running'}` }] };
      }

      case 'n8n_list_executions': {
        let qs = `?limit=${args.limit || 20}`;
        if (args.workflow_id) qs += `&workflowId=${args.workflow_id}`;
        if (args.status) qs += `&status=${args.status}`;
        const res = await n8nRequest('GET', `/executions${qs}`);
        if (res.error) return { content: [{ type: 'text', text: `❌ n8n executions error: ${res.error}` }], isError: true };
        const list = (res.data || []).map(e =>
          `ID: ${e.id}  |  Workflow: ${e.workflowId}  |  Status: ${e.status}  |  Started: ${e.startedAt}  |  Mode: ${e.mode}`
        ).join('\n') || '(no executions found)';
        return { content: [{ type: 'text', text: `✅ ${(res.data||[]).length} execution(s):\n\n${list}` }] };
      }

      // ── Local access tools (Codex-style) ────────────────────────────────

      case 'open_terminal': {
        const termCwd = args.cwd ? path.resolve(currentCwd, args.cwd) : currentCwd;
        const title = args.title || 'Open-Brain Terminal';
        const cmd = args.command || '';

        // ── Detect desktop session env vars via Python (null-byte safe) ──
        const pyLines = [
          'import glob',
          'want={"DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR","DBUS_SESSION_BUS_ADDRESS","XAUTHORITY","LANG"}',
          'found={}',
          'exec(open("/dev/stdin","rb").read())',
        ];
        const pyScript = `
import glob
want = {"DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR","DBUS_SESSION_BUS_ADDRESS","XAUTHORITY","LANG"}
found = {}
for f in glob.glob("/proc/*/environ"):
    try:
        for item in open(f,"rb").read().split(b"\x00"):
            try:
                k,v = item.decode("utf-8","replace").split("=",1)
                if k in want and k not in found:
                    found[k] = v
            except: pass
    except: pass
print("\n".join(k+"="+v for k,v in found.items()))
`.trim();

        const detectedVars = {};
        try {
          const pyOut = await new Promise(res =>
            exec(`python3 -c ${JSON.stringify(pyScript)}`, { timeout: 4000 }, (e, o) => res(o || '')));
          for (const line of pyOut.split('\n')) {
            const eq = line.indexOf('=');
            if (eq > 0) detectedVars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
        } catch { /* ignore */ }

        const displayEnv = { ...process.env, ...detectedVars };
        if (!displayEnv.DISPLAY && !displayEnv.WAYLAND_DISPLAY) displayEnv.DISPLAY = ':0';
        if (!displayEnv.LANG) displayEnv.LANG = 'en_US.UTF-8';
        if (!displayEnv.XDG_RUNTIME_DIR) {
          try {
            const uid = await new Promise(res => exec('id -u', (e, o) => res((o || '').trim())));
            displayEnv.XDG_RUNTIME_DIR = `/run/user/${uid}`;
          } catch { displayEnv.XDG_RUNTIME_DIR = '/run/user/1000'; }
        }

        const inner = cmd
          ? `bash -c ${JSON.stringify(cmd + '; echo; echo "=== done (Enter to close) ==="; read -r')}`
          : 'bash';

        const dispStr = displayEnv.DISPLAY || displayEnv.WAYLAND_DISPLAY || ':0';
        const attempts = [
          `gnome-terminal --title="${title}" --working-directory="${termCwd}" -- ${inner}`,
          `xfce4-terminal --title="${title}" --working-directory="${termCwd}" -e bash`,
          `xterm -title "${title}" -e ${inner}`,
          `konsole --workdir "${termCwd}" -e bash`,
          `x-terminal-emulator -e ${inner}`,
        ];

        for (const attempt of attempts) {
          const { error } = await new Promise(res =>
            exec(`${attempt} &`, { cwd: termCwd, env: displayEnv, timeout: 4000 },
              (e, o, r) => res({ error: e })));
          if (!error) {
            return { content: [{ type: 'text', text:
              `✅ Terminal opened (DISPLAY=${dispStr})${cmd ? '\nCommand: ' + cmd : ''}\nCWD: ${termCwd}` }] };
          }
        }
        return { content: [{ type: 'text', text:
          `❌ Could not open terminal.\n` +
          `  DISPLAY=${displayEnv.DISPLAY || '(none)'}\n` +
          `  WAYLAND_DISPLAY=${displayEnv.WAYLAND_DISPLAY || '(none)'}\n` +
          `  XDG_RUNTIME_DIR=${displayEnv.XDG_RUNTIME_DIR || '(none)'}\n` +
          `  LANG=${displayEnv.LANG}\n\n` +
          `Tried: gnome-terminal, xfce4-terminal, xterm, konsole, x-terminal-emulator\n` +
          `Install one: sudo apt install xterm` }], isError: true };
      }

      case 'read_url': {
        const method = (args.method || 'GET').toUpperCase();
        const headers = args.headers || {};
        const headerStr = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(' ');
        const bodyStr = args.body ? `-d ${JSON.stringify(args.body)}` : '';
        const cmd = `curl -s -L -X ${method} ${headerStr} ${bodyStr} --max-time 15 "${args.url}"`;
        const { out, error } = await execAsync(cmd, { timeout: 20000 });
        if (error) return { content: [{ type: 'text', text: `❌ Failed to fetch ${args.url}: ${out}` }], isError: true };
        return { content: [{ type: 'text', text: truncate(out, args.url) }] };
      }

      default: {
        // Return the valid tool list so the AI stops guessing
        const hint = VALID_TOOLS.join(', ');
        return {
          content: [{ type: 'text', text:
            `❌ Unknown tool: "${name}"\n\n` +
            `VALID TOOL NAMES (use EXACTLY one of these, no others exist):\n${VALID_TOOLS.map(t => `  - ${t}`).join('\n')}\n\n` +
            `COMMON MAPPINGS:\n` +
            `  create_directory / mkdir / make_directory   → run_terminal with command "mkdir -p <path>"\n` +
            `  shell_execute / exec / run_command          → run_terminal\n` +
            `  create_file / make_file                     → write_file\n` +
            `  open_browser / navigate                     → open_url\n` +
            `Retry immediately using the EXACT correct tool name from the list above.`
          }],
          isError: true,
        };
      }
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error in ${name}: ${error.message}` }],
      isError: true,
    };
  }
});

// ─── Start ───
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[MCP Server] Ready — 41 tools available (incl. 11 n8n tools, multi_edit_file, verify_file) — cwd: ${currentCwd}`);
  console.error(`[MCP Server] 🕷 n8n templates: ${Object.keys(N8N_TEMPLATES).join(', ')}`);
  if (!N8N_API_KEY) console.error('[MCP Server] ⚠️  N8N_API_KEY not set — n8n tools will work only if n8n auth is disabled.');
  else console.error(`[MCP Server] 🔗 n8n tools connected → ${N8N_BASE}`);
}

main().catch((err) => {
  console.error('[MCP Server] Fatal error:', err);
  process.exit(1);
});
