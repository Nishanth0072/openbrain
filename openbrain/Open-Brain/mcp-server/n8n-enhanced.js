// ─── Enhanced n8n Workflow Helpers ───
// Import this into index.js: import { buildWorkflowFromTemplate, N8N_TEMPLATES, validateWorkflow, buildNode } from './n8n-enhanced.js';

export const N8N_TEMPLATES = {
  // ── Scheduled HTTP fetch → code transform → notification ──
  'schedule-fetch-notify': ({ name = 'Scheduled Notify', cron = '0 9 * * *', url = '', webhookUrl = '' } = {}) => ({
    name,
    nodes: [
      buildNode('Schedule', 'n8n-nodes-base.scheduleTrigger', [250, 300], {
        rule: { interval: [{ field: 'cronExpression', expression: cron }] }
      }),
      buildNode('HTTP Fetch', 'n8n-nodes-base.httpRequest', [480, 300], {
        method: 'GET', url, responseFormat: 'json',
      }),
      buildNode('Transform', 'n8n-nodes-base.code', [710, 300], {
        jsCode: `// Transform fetched data\nconst data = items[0].json;\nreturn [{ json: { message: JSON.stringify(data).slice(0,200), timestamp: new Date().toISOString() } }];`
      }),
      buildNode('Notify', 'n8n-nodes-base.httpRequest', [940, 300], {
        method: 'POST', url: webhookUrl,
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ text: $json.message }) }}'
      }),
    ],
    connections: chainNodes(['Schedule', 'HTTP Fetch', 'Transform', 'Notify']),
  }),

  // ── Webhook → validate → store → respond ──
  'webhook-store': ({ name = 'Webhook Store', path = 'webhook' } = {}) => ({
    name,
    nodes: [
      buildNode('Webhook', 'n8n-nodes-base.webhook', [250, 300], {
        httpMethod: 'POST', path, responseMode: 'responseNode',
      }, { typeVersion: 2 }),
      buildNode('Validate', 'n8n-nodes-base.code', [480, 300], {
        jsCode: `const body = items[0].json.body || items[0].json;\nif (!body) throw new Error('Empty payload');\nreturn [{ json: { ...body, receivedAt: new Date().toISOString(), valid: true } }];`
      }),
      buildNode('Respond', 'n8n-nodes-base.respondToWebhook', [710, 300], {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ ok: true, id: $json.id || "stored" }) }}',
      }, { typeVersion: 1 }),
    ],
    connections: chainNodes(['Webhook', 'Validate', 'Respond']),
  }),

  // ── Daily digest: fetch multiple sources → merge → send ──
  'daily-digest': ({ name = 'Daily Digest', cron = '0 8 * * *', webhookUrl = '' } = {}) => ({
    name,
    nodes: [
      buildNode('Every Morning', 'n8n-nodes-base.scheduleTrigger', [250, 300], {
        rule: { interval: [{ field: 'cronExpression', expression: cron }] }
      }),
      buildNode('Merge & Format', 'n8n-nodes-base.code', [480, 300], {
        jsCode: `const ts = new Date().toLocaleString();\nreturn [{ json: { title: 'Daily Digest', time: ts, summary: 'Digest ready.' } }];`
      }),
      buildNode('Send Digest', 'n8n-nodes-base.httpRequest', [710, 300], {
        method: 'POST', url: webhookUrl,
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ text: "📋 " + $json.title + " — " + $json.time }) }}'
      }),
    ],
    connections: chainNodes(['Every Morning', 'Merge & Format', 'Send Digest']),
  }),

  // ── Error monitor: poll API → check for errors → alert ──
  'error-monitor': ({ name = 'Error Monitor', cron = '*/15 * * * *', url = '', webhookUrl = '' } = {}) => ({
    name,
    nodes: [
      buildNode('Poll', 'n8n-nodes-base.scheduleTrigger', [250, 300], {
        rule: { interval: [{ field: 'cronExpression', expression: cron }] }
      }),
      buildNode('Fetch Status', 'n8n-nodes-base.httpRequest', [480, 300], {
        method: 'GET', url, responseFormat: 'json',
      }),
      buildNode('Check Errors', 'n8n-nodes-base.code', [710, 300], {
        jsCode: `const data = items[0].json;\nconst hasError = data.status === 'error' || data.error || data.errors?.length > 0;\nif (!hasError) return [];\nreturn [{ json: { alert: true, message: 'Error detected: ' + JSON.stringify(data).slice(0,200), ts: new Date().toISOString() } }];`
      }),
      buildNode('Alert', 'n8n-nodes-base.httpRequest', [940, 300], {
        method: 'POST', url: webhookUrl,
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ text: "🚨 " + $json.message }) }}'
      }),
    ],
    connections: chainNodes(['Poll', 'Fetch Status', 'Check Errors', 'Alert']),
  }),

  // ── LeetCode tracker (existing use-case, improved) ──
  'leetcode-tracker': ({ name = 'LeetCode Daily Tracker', username = 'YOUR_USERNAME', webhookUrl = '' } = {}) => ({
    name,
    nodes: [
      buildNode('Daily at 8PM', 'n8n-nodes-base.scheduleTrigger', [250, 300], {
        rule: { interval: [{ field: 'cronExpression', expression: '0 20 * * *' }] }
      }),
      buildNode('Fetch Submissions', 'n8n-nodes-base.httpRequest', [480, 300], {
        method: 'POST', url: 'https://leetcode.com/graphql',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'content-type', value: 'application/json' }] },
        sendBody: true, specifyBody: 'json',
        jsonBody: JSON.stringify({ query: 'query userRecentSubmissionList($username:String!,$limit:Int!){recentSubmissionList(username:$username,limit:$limit){title titleSlug timestamp statusDisplay lang}}', variables: { username, limit: 1 } }),
      }, { typeVersion: 4.1 }),
      buildNode('Check Streak', 'n8n-nodes-base.code', [710, 300], {
        jsCode: `const data = items[0].json.data?.recentSubmissionList;\nif(!data?.length) return [{json:{message:'⚠️ No submissions found! Start grinding!'}}];\nconst s=data[0], t=new Date(s.timestamp*1000), today=t.toDateString()===new Date().toDateString();\nreturn [{json:{title:s.title,status:s.statusDisplay,lang:s.lang,link:'https://leetcode.com/problems/'+s.titleSlug+'/',solvedToday:today,message:today?'🔥 Solved: '+s.title+' ('+s.lang+') — '+s.statusDisplay:'⚠️ No LeetCode today! Protect your streak!'}}];`
      }),
      buildNode('Notify', 'n8n-nodes-base.httpRequest', [940, 300], {
        method: 'POST', url: webhookUrl,
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ text: $json.message }) }}'
      }),
    ],
    connections: chainNodes(['Daily at 8PM', 'Fetch Submissions', 'Check Streak', 'Notify']),
  }),
};

/** Build a standard n8n node object */
export function buildNode(name, type, position, parameters = {}, extra = {}) {
  return {
    id: generateId(),
    name,
    type,
    typeVersion: extra.typeVersion ?? (type === 'n8n-nodes-base.httpRequest' ? 4.1 : type === 'n8n-nodes-base.code' ? 2 : 1),
    position,
    parameters,
    ...extra,
  };
}

/** Chain a list of node names into a linear connection map */
export function chainNodes(names) {
  const conn = {};
  for (let i = 0; i < names.length - 1; i++) {
    conn[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] };
  }
  return conn;
}

/** Build a workflow from a named template */
export function buildWorkflowFromTemplate(template, params = {}) {
  const fn = N8N_TEMPLATES[template];
  if (!fn) throw new Error(`Unknown template: "${template}". Available: ${Object.keys(N8N_TEMPLATES).join(', ')}`);
  const wf = fn(params);
  return { ...wf, settings: { executionOrder: 'v1' } };
}

/** Validate a workflow before sending to n8n */
export function validateWorkflow(wf) {
  const errors = [];
  if (!wf.name) errors.push('Missing workflow name');
  if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) errors.push('No nodes defined');
  const nodeNames = new Set((wf.nodes || []).map(n => n.name));
  for (const [src, conns] of Object.entries(wf.connections || {})) {
    if (!nodeNames.has(src)) errors.push(`Connection source "${src}" not found in nodes`);
    for (const targets of Object.values(conns)) {
      for (const group of targets) {
        for (const t of group) {
          if (!nodeNames.has(t.node)) errors.push(`Connection target "${t.node}" not found in nodes`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
