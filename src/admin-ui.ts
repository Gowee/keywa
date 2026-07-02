/**
 * HTML templates for the admin web UI.
 * Embedded in the Worker — no external static assets.
 * Supports automatic light/dark mode with manual toggle.
 */

const THEME_CSS = `
:root {
  --bg: #ffffff; --bg-card: #f6f8fa; --bg-input: #ffffff;
  --border: #d0d7de; --border-light: #e8e8e8;
  --text: #1f2328; --text-muted: #656d76;
  --accent: #0969da; --green: #1a7f37; --red: #cf222e;
  --green-bg: #238636; --green-bg-hover: #2ea043;
  --btn-bg: #f6f8fa; --btn-hover: #e8e8e8;
  --toast-bg: #ffffff;
}
[data-theme="dark"] {
  --bg: #0d1117; --bg-card: #161b22; --bg-input: #0d1117;
  --border: #30363d; --border-light: #21262d;
  --text: #c9d1d9; --text-muted: #8b949e;
  --accent: #58a6ff; --green: #3fb950; --red: #f85149;
  --green-bg: #238636; --green-bg-hover: #2ea043;
  --btn-bg: #21262d; --btn-hover: #30363d;
  --toast-bg: #161b22;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); transition: background 0.2s, color 0.2s; }
.header { background: var(--bg-card); border-bottom: 1px solid var(--border); padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; }
.header h1 { font-size: 1.2rem; }
.header-actions { display: flex; gap: 0.5rem; align-items: center; }
.header button { background: var(--btn-bg); color: var(--text); border: 1px solid var(--border); padding: 0.4rem 0.8rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
.header button:hover { background: var(--btn-hover); }
.container { max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
.section { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 1.5rem; }
.section-header { padding: 1rem 1.25rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
.section-header h2 { font-size: 1rem; }
.section-header .count { font-size: 0.85rem; color: var(--text-muted); font-weight: normal; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.75rem 1.25rem; text-align: left; border-bottom: 1px solid var(--border-light); font-size: 0.9rem; }
th { color: var(--text-muted); font-weight: 500; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
.mono { font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.85rem; }
.muted { color: var(--text-muted); font-size: 0.82rem; }
.actions { white-space: nowrap; }
.actions button { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 0.85rem; padding: 0.2rem 0.5rem; }
.actions button:hover { text-decoration: underline; }
.actions button.danger { color: var(--red); }
.btn { padding: 0.5rem 1rem; border: none; border-radius: 6px; font-size: 0.9rem; cursor: pointer; font-weight: 500; }
.btn-primary { background: var(--green-bg); color: #fff; }
.btn-primary:hover { background: var(--green-bg-hover); }
.btn-secondary { background: var(--btn-bg); color: var(--text); border: 1px solid var(--border); }
.btn-secondary:hover { background: var(--btn-hover); }
.form-row { display: flex; gap: 0.75rem; align-items: end; margin-bottom: 0.75rem; flex-wrap: wrap; }
.form-row label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; color: var(--text-muted); flex: 1; min-width: 0; }
.form-row input, .form-row textarea { background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem; color: var(--text); font-size: 0.9rem; font-family: inherit; min-width: 0; }
.form-row input:focus, .form-row textarea:focus { border-color: var(--accent); outline: none; }
.form-row textarea { resize: vertical; min-height: 2.5rem; }
.input-with-btn { display: flex; gap: 0.3rem; }
.input-with-btn input { flex: 1; }
.input-with-btn .btn-inline { padding: 0.5rem 0.6rem; font-size: 0.75rem; white-space: nowrap; }
.char-count { font-size: 0.75rem; color: var(--text-muted); text-align: right; margin-top: 0.2rem; }
.empty { padding: 2rem; text-align: center; color: var(--text-muted); }
.toast { position: fixed; bottom: 1rem; right: 1rem; background: var(--toast-bg); border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem 1rem; font-size: 0.85rem; z-index: 100; transition: opacity 0.3s; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
.toast.error { border-color: var(--red); }
.toast.success { border-color: var(--green); }
.curl-example { margin-top: 0.75rem; padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.75rem; white-space: pre-wrap; word-break: break-all; cursor: pointer; color: var(--text-muted); opacity: 0.7; background: var(--bg-input); border: 1px solid var(--border); }
.curl-example:hover { opacity: 1; }
`;

const THEME_JS = `
(function() {
  const stored = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', stored || (prefersDark ? 'dark' : 'light'));
})();
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = next === 'dark' ? '☀️' : '🌙';
}
function initThemeBtn() {
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
}
`;

const LIMITS = {
  secretId: 128,
  token: 128,
  value: 65536,
};

export function loginPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>keywa — Login</title>
  <style>${THEME_CSS}
    body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 2rem; width: 100%; max-width: 420px; text-align: center; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    h1 a { color: inherit; text-decoration: none; }
    p { color: var(--text-muted); margin-bottom: 1rem; font-size: 0.9rem; }
    .btn { display: inline-block; padding: 0.65rem 1.2rem; border: none; border-radius: 6px; font-size: 0.9rem; cursor: pointer; font-weight: 500; transition: background 0.2s; }
    .btn-primary { background: var(--green-bg); color: #fff; }
    .btn-primary:hover { background: var(--green-bg-hover); }
    .btn-primary:disabled { background: var(--btn-bg); color: var(--text-muted); cursor: not-allowed; }
    .status { margin-top: 0.75rem; font-size: 0.85rem; color: var(--text-muted); }
    .status.error { color: var(--red); }
    .spinner { display: inline-block; width: 1em; height: 1em; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 0.5rem; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .setup-guide { text-align: left; font-size: 0.82rem; color: var(--text-muted); background: var(--bg-input); border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1rem; line-height: 1.6; }
    .setup-guide code { background: var(--bg-card); padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.8rem; }
    .divider { display: flex; align-items: center; gap: 0.75rem; margin: 1rem 0; color: var(--text-muted); font-size: 0.8rem; }
    .divider::before, .divider::after { content: ''; flex: 1; border-top: 1px solid var(--border); }
    .token-input { display: flex; gap: 0.5rem; }
    .token-input input { flex: 1; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem; color: var(--text); font-size: 0.9rem; }
    .token-input input:focus { border-color: var(--accent); outline: none; }
    .session-info { font-size:0.75rem; color:var(--text-muted); margin-bottom:0.75rem; }
    .session-info code { background:var(--bg-input); padding:0.1rem 0.35rem; border-radius:3px; font-size:0.75rem; }
    .hidden { display: none; }
  </style>
  <script>${THEME_JS}</script>
</head>
<body>
  <div class="card">
    <h1><a href="https://github.com/gowee/keywa" target="_blank" rel="noopener">🔐 keywa</a></h1>
    <div id="loading"><p>Checking configuration...</p></div>
    <div id="login-telegram" class="hidden">
      <p>Approve login via Telegram</p>
      <div class="session-info">Session: <code id="session-id"></code></div>
      <button id="login-btn" class="btn btn-primary" onclick="startTelegramLogin()">Login with Telegram</button>
    </div>
    <div id="login-token" class="hidden">
      <div class="divider">or</div>
      <p>Enter admin token</p>
      <div class="token-input">
        <input id="token-input" type="password" placeholder="ADMIN_TOKEN" autocomplete="off">
        <button class="btn btn-primary" onclick="startTokenLogin()">Login</button>
      </div>
    </div>
    <div id="setup-guide" class="hidden">
      <div class="setup-guide">
        <strong>Setup required.</strong> Set these secrets via Wrangler:<br><br>
        <code>pnpm wrangler secret put TELEGRAM_BOT_TOKEN</code><br>
        <code>pnpm wrangler secret put TELEGRAM_CHAT_ID</code><br>
        <code>pnpm wrangler secret put ADMIN_TOKEN</code><br><br>
        Then register the webhook:<br>
        <code>curl -X POST /admin/webhook -H "Authorization: Bearer ..."</code>
      </div>
    </div>
    <div id="status" class="status"></div>
  </div>
  <script>
    const sessionId = 'login-' + crypto.randomUUID().slice(0, 8);

    async function init() {
      try {
        const resp = await fetch('/admin/status');
        const config = await resp.json();
        document.getElementById('loading').style.display = 'none';

        if (config.telegram && !config.telegramDisabled) {
          document.getElementById('login-telegram').classList.remove('hidden');
          document.getElementById('session-id').textContent = sessionId;
        }
        document.getElementById('login-token').classList.remove('hidden');
        if (!config.telegram) {
          document.getElementById('setup-guide').classList.remove('hidden');
        }
      } catch (e) {
        document.getElementById('loading').innerHTML = '<p class="status error">Failed to check configuration</p>';
      }
    }

    async function startTelegramLogin() {
      const btn = document.getElementById('login-btn');
      const status = document.getElementById('status');
      btn.disabled = true;
      status.className = 'status';
      status.innerHTML = '<span class="spinner"></span> Waiting for approval...';

      try {
        const resp = await fetch('/admin/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: sessionId }),
        });
        const data = await resp.json();
        handleLoginResult(data, btn, status);
      } catch (e) {
        status.className = 'status error';
        status.innerHTML = '⚠️ Network error';
        btn.disabled = false;
      }
    }

    async function startTokenLogin() {
      const input = document.getElementById('token-input');
      const status = document.getElementById('status');
      const token = input.value.trim();
      if (!token) { status.className = 'status error'; status.innerHTML = 'Token required'; return; }

      status.className = 'status';
      status.innerHTML = '<span class="spinner"></span> Logging in...';

      try {
        const resp = await fetch('/admin/auth/login-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await resp.json();
        handleLoginResult(data, input, status);
      } catch (e) {
        status.className = 'status error';
        status.innerHTML = '⚠️ Network error';
      }
    }

    function handleLoginResult(data, _btn, status) {
      if (data.status === 'approved') {
        status.innerHTML = '✅ Redirecting...';
        setTimeout(() => window.location.href = '/admin/dashboard', 500);
      } else if (data.status === 'denied') {
        status.className = 'status error';
        status.innerHTML = '❌ Denied';
        if (_btn) _btn.disabled = false;
      } else if (data.status === 'expired') {
        status.className = 'status error';
        status.innerHTML = '⏰ Timed out. Try again.';
        if (_btn) _btn.disabled = false;
      } else if (data.status === 'rate_limited') {
        status.className = 'status error';
        status.innerHTML = '⏳ ' + (data.error || 'Rate limited. Try again shortly.');
        if (_btn) _btn.disabled = false;
      } else {
        status.className = 'status error';
        status.innerHTML = '⚠️ ' + (data.error || 'Unknown error');
        if (_btn) _btn.disabled = false;
      }
    }

    init();
  </script>
</body>
</html>`;
}

export function dashboardPage(timeoutSeconds: number = 900): string {
  const timeoutMin = Math.round(timeoutSeconds / 60);
  const timeoutLabel =
    timeoutMin >= 60 ? Math.round(timeoutMin / 60) + "h" : timeoutMin + "m";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>keywa — Admin</title>
  <style>${THEME_CSS}
    .timeout-badge { font-size: 0.75rem; color: var(--text-muted); cursor: help; margin-left: 0.5rem; }
    .header h1 a { color: inherit; text-decoration: none; }
  </style>
  <script>${THEME_JS}</script>
</head>
<body>
  <div class="header">
    <h1><a href="https://github.com/gowee/keywa" target="_blank" rel="noopener">🔐 keywa</a> <span class="timeout-badge" title="Approval timeout. Set TIMEOUT_SECONDS env var to change.">⏱ ${timeoutLabel}</span></h1>
    <div class="header-actions">
      <button onclick="registerWebhook()" title="Register Telegram webhook">📡 Webhook</button>
      <button id="theme-btn" onclick="toggleTheme()" title="Toggle theme">🌙</button>
      <button onclick="logout()">Logout</button>
    </div>
  </div>
  <div class="container">
    <div class="section">
      <div class="section-header">
        <h2>Secrets <span id="secret-count" class="count"></span></h2>
      </div>
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>ID</th><th>Token</th><th>Updated</th><th>Actions</th></tr></thead>
        <tbody id="secret-list"><tr><td colspan="4" class="empty">Loading...</td></tr></tbody>
      </table>
      </div>
    </div>
    <div class="section">
      <div class="section-header"><h2 id="form-title">Add Secret</h2></div>
      <div style="padding: 1rem 1.25rem;">
        <div class="form-row">
          <label>Secret ID
            <input id="f-id" placeholder="e.g. tyo2-luks" maxlength="${LIMITS.secretId}">
            <div class="char-count"><span id="f-id-count">0</span>/${LIMITS.secretId}</div>
          </label>
          <label>Token
            <div class="input-with-btn">
              <input id="f-token" placeholder="leave empty to keep existing" title="per-secret access token" maxlength="${LIMITS.token}">
              <button class="btn btn-secondary btn-inline" onclick="generateToken()" title="Generate random token">🎲</button>
            </div>
            <div class="char-count"><span id="f-token-count">0</span>/${LIMITS.token}</div>
          </label>
        </div>
        <div class="form-row">
          <label>Value
            <textarea id="f-value" rows="3" placeholder="leave empty to keep existing" title="the secret value to store" maxlength="${LIMITS.value}"></textarea>
            <div class="char-count"><span id="f-value-count">0</span>/${LIMITS.value}</div>
          </label>
        </div>
        <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
          <button class="btn btn-secondary" onclick="clearForm()">Clear</button>
          <button class="btn btn-primary" onclick="saveSecret()">Save</button>
        </div>
        <pre id="curl-example" class="curl-example" style="display:none" title="Click to select · double-click to copy" onclick="selectCurl(this)" ondblclick="copyCurl(this)"></pre>
      </div>
    </div>
  </div>
  <div id="toast" class="toast" style="display:none"></div>
  <script>
    const API = '/admin/api/secrets';

    // Character counters + curl example
    ['f-id', 'f-token', 'f-value'].forEach(id => {
      const el = document.getElementById(id);
      const counter = document.getElementById(id + '-count');
      if (el && counter) {
        el.addEventListener('input', () => { counter.textContent = el.value.length; updateCurlExample(); });
      }
    });

    function updateCurlExample() {
      const id = document.getElementById('f-id').value.trim();
      const token = document.getElementById('f-token').value.trim();
      const pre = document.getElementById('curl-example');
      if (id && token) {
        const origin = window.location.origin;
        pre.textContent = "curl -H 'Authorization: Bearer " + token + "' " + origin + "/secret/" + encodeURIComponent(id);
        pre.style.display = 'block';
      } else {
        pre.style.display = 'none';
      }
    }

    function selectCurl(el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      navigator.clipboard.writeText(el.textContent).catch(() => {});
    }

    function copyCurl(el) {
      navigator.clipboard.writeText(el.textContent).then(
        () => toast('Copied'),
        () => selectCurl(el)
      );
    }

    function renderSecrets(secrets) {
      const tbody = document.getElementById('secret-list');
      const count = document.getElementById('secret-count');
      count.textContent = secrets.length ? '(' + secrets.length + ')' : '';

      if (!secrets.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">No secrets</td></tr>';
        return;
      }

      tbody.innerHTML = secrets.map(s => {
        const tok = s.token || '';
        const masked = tok.length >= 8 ? tok.slice(0,4) + '****' + tok.slice(-4) : tok ? '****' : '(none)';
        const updated = s.updated_at ? timeAgo(s.updated_at) : '—';
        return '<tr>' +
          '<td class="mono">' + esc(s.id) + '</td>' +
          '<td class="mono">' + esc(masked) + '</td>' +
          '<td class="muted">' + esc(updated) + '</td>' +
          '<td class="actions">' +
            '<button onclick="editSecret(this.dataset.id)" data-id="' + escAttr(s.id) + '">Edit</button> ' +
            '<button class="danger" onclick="deleteSecret(this.dataset.id)" data-id="' + escAttr(s.id) + '">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    function timeAgo(ms) {
      const sec = Math.floor((Date.now() - ms) / 1000);
      if (sec < 60) return 'just now';
      const min = Math.floor(sec / 60);
      if (min < 60) return min + 'm ago';
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + 'h ago';
      const d = Math.floor(hr / 24);
      return d + 'd ago';
    }

    async function loadSecrets() {
      try {
        const resp = await fetch(API);
        if (resp.status === 401) { window.location.href = '/admin'; return; }
        if (!resp.ok) { toast('Server error: ' + resp.status, true); return; }
        renderSecrets(await resp.json());
      } catch (e) { toast('Failed to load secrets: ' + e.message, true); }
    }

    async function saveSecret() {
      const id = document.getElementById('f-id').value.trim();
      const secret = document.getElementById('f-value').value;
      const token = document.getElementById('f-token').value.trim();
      if (!id) { toast('Secret ID required', true); return; }
      if (!token && !secret) { toast('Provide token or value', true); return; }
      if (id.length > ${LIMITS.secretId}) { toast('Secret ID too long (max ${LIMITS.secretId})', true); return; }
      if (token && token.length > ${LIMITS.token}) { toast('Token too long (max ${LIMITS.token})', true); return; }
      if (secret && secret.length > ${LIMITS.value}) { toast('Value too long (max ${LIMITS.value})', true); return; }
      const body = {};
      if (token) body.token = token;
      if (secret) body.secret = secret;
      try {
        const resp = await fetch(API + '/' + encodeURIComponent(id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (resp.ok) {
          toast('Saved');
          clearForm();
          await loadSecrets();
        }
        else { toast('Save failed: ' + (await resp.text()), true); }
      } catch (e) { toast('Network error', true); }
    }

    async function deleteSecret(id) {
      if (!confirm('Delete secret "' + id + '"?')) return;
      try {
        const resp = await fetch(API + '/' + encodeURIComponent(id), { method: 'DELETE' });
        if (resp.ok) {
          toast('Deleted');
          await loadSecrets();
        }
        else { toast('Delete failed', true); }
      } catch (e) { toast('Network error', true); }
    }

    function editSecret(id) {
      document.getElementById('f-id').value = id;
      document.getElementById('form-title').textContent = 'Edit Secret';
      document.getElementById('f-token').focus();
      updateCounters();
      updateCurlExample();
    }

    function clearForm() {
      document.getElementById('f-id').value = '';
      document.getElementById('f-value').value = '';
      document.getElementById('f-token').value = '';
      document.getElementById('form-title').textContent = 'Add Secret';
      updateCounters();
      updateCurlExample();
    }

    function generateToken() {
      const arr = new Uint8Array(24);
      crypto.getRandomValues(arr);
      document.getElementById('f-token').value = btoa(String.fromCharCode(...arr)).replace(/[^a-zA-Z0-9]/g, '').slice(0, ${LIMITS.token});
      updateCounters();
      updateCurlExample();
    }

    function updateCounters() {
      ['f-id', 'f-token', 'f-value'].forEach(id => {
        const el = document.getElementById(id);
        const counter = document.getElementById(id + '-count');
        if (el && counter) counter.textContent = el.value.length;
      });
    }

    async function logout() {
      await fetch('/admin/auth/logout', { method: 'POST' });
      window.location.href = '/admin';
    }

    async function registerWebhook() {
      try {
        const resp = await fetch('/admin/webhook', { method: 'POST' });
        const data = await resp.json();
        if (data.ok) toast('Webhook registered: ' + data.webhookUrl);
        else toast('Webhook failed: ' + (data.description || 'Unknown error'), true);
      } catch (e) { toast('Network error', true); }
    }

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

    function toast(msg, isError) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast ' + (isError ? 'error' : 'success');
      el.style.display = 'block';
      setTimeout(() => el.style.display = 'none', 3000);
    }

    initThemeBtn();
    loadSecrets();
  </script>
</body>
</html>`;
}
