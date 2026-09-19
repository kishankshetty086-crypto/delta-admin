const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3500;
const BASE_DIR = __dirname;
const CONFIG_PATH = path.join(BASE_DIR, 'config', 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
      currentConfig = JSON.parse(raw);
    }
  } catch (e) {
    console.warn("Could not load config.json:", e.message);
  }
  return currentConfig;
}
loadConfig();

// Token cache
let cachedToken = null;
let tokenExpiresAt = 0;
let lastAvailabilityCache = null;

// ==========================================
// BACKGROUND BA AVAILABILITY POLLER & CLIQ ENGINE
// ==========================================
let pollerState = {
  isRunning: currentConfig.availability?.autoPollerActive ?? true,
  intervalSec: currentConfig.availability?.defaultIntervalSec || 300,
  autoCliqBroadcast: currentConfig.availability?.autoCliqBroadcast ?? true,
  cliqMonitoredOnly: currentConfig.availability?.cliqMonitoredOnly ?? true,
  lastRunTime: null,
  nextRunTime: null,
  lastStatus: 'idle',
  lastLog: 'Initialized',
  history: []
};
let pollerTimeout = null;

function formatAvailabilityCliqMessage(availData, monitoredUsers, onlyMonitored = true) {
  let list = [];
  if (Array.isArray(availData)) {
    list = availData;
  } else if (availData && Array.isArray(availData.range_details)) {
    availData.range_details.forEach(r => {
      if ((r.row_index || 0) <= 1) return;
      const details = r.row_details || [];
      const name = (details.find(d => d.column_index === 1)?.content || '').trim();
      const status = (details.find(d => d.column_index === 2)?.content || '').trim();
      const phone = (details.find(d => d.column_index === 3)?.content || '').trim();
      if (name) list.push({ name, availability: status, phone });
    });
  } else if (availData && Array.isArray(availData.users)) {
    list = availData.users;
  }

  const monitoredSet = new Set((monitoredUsers || []).map(u => u.trim().toLowerCase()));
  const usersToSend = onlyMonitored
    ? list.filter(u => monitoredSet.has(u.name.trim().toLowerCase()) || Array.from(monitoredSet).some(m => u.name.toLowerCase().includes(m)))
    : list;

  if (usersToSend.length === 0) return null;

  const now = new Date();
  const timeString = now.toLocaleDateString('en-US') + ' ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let message = `📢 *BA Availability Status Update*\n🕒 *Timestamp:* ${timeString}\n\n`;

  usersToSend.forEach(u => {
    const availLower = (u.availability || '').toLowerCase();
    let icon = "⚪";
    if (availLower.includes('escalation') || availLower.includes('available')) {
      icon = "🟢";
    } else if (availLower.includes('not available') || availLower.includes('leave') || availLower.includes('off')) {
      icon = "🔴";
    } else {
      icon = "🟡";
    }
    message += `• *${u.name}*: ${icon} ${u.availability} (📞 ${u.phone || 'N/A'})\n`;
  });

  return message.trim();
}

async function runBackendPollCycle(triggerSource = 'scheduled') {
  const startTime = new Date();
  pollerState.lastRunTime = startTime.toISOString();

  try {
    const availUrl = (currentConfig.availability?.apiUrl || 'https://madhava.kambala.co.in/deltabaavailability/api/availability/') + '?t=' + Date.now();
    const response = await makeGetRequest(availUrl);

    if (response.status === 200) {
      lastAvailabilityCache = response.data;
      let parsedData = null;
      try { parsedData = JSON.parse(response.data); } catch (e) {}

      let cliqResult = 'skipped';
      if (pollerState.autoCliqBroadcast && currentConfig.cliq?.webhookUrl) {
        const msg = formatAvailabilityCliqMessage(parsedData, currentConfig.availability?.monitoredUsers, pollerState.cliqMonitoredOnly);
        if (msg) {
          const cliqRes = await makePostRequest(currentConfig.cliq.webhookUrl, { 'Content-Type': 'application/json' }, JSON.stringify({ text: msg }));
          cliqResult = cliqRes.status === 200 ? 'sent' : `failed (${cliqRes.status})`;
        }
      }

      pollerState.lastStatus = 'success';
      pollerState.lastLog = `[${startTime.toLocaleTimeString()}] Fresh BA data fetched. Cliq: ${cliqResult} (${triggerSource})`;
    } else {
      pollerState.lastStatus = 'api_error';
      pollerState.lastLog = `[${startTime.toLocaleTimeString()}] Availability API returned HTTP ${response.status}`;
    }
  } catch (err) {
    pollerState.lastStatus = 'error';
    pollerState.lastLog = `[${startTime.toLocaleTimeString()}] Error: ${err.message}`;
  }

  pollerState.history.unshift({
    timestamp: startTime.toISOString(),
    status: pollerState.lastStatus,
    log: pollerState.lastLog,
    triggerSource
  });
  if (pollerState.history.length > 20) pollerState.history.pop();

  if (pollerState.isRunning) {
    scheduleNextPoll();
  }
}

function scheduleNextPoll() {
  if (pollerTimeout) clearTimeout(pollerTimeout);
  if (!pollerState.isRunning) return;

  const intervalMs = Math.max(5, pollerState.intervalSec) * 1000;
  pollerState.nextRunTime = new Date(Date.now() + intervalMs).toISOString();
  pollerTimeout = setTimeout(() => {
    runBackendPollCycle('scheduled');
  }, intervalMs);
}

function startBackendPoller() {
  pollerState.isRunning = true;
  scheduleNextPoll();
}

function stopBackendPoller() {
  pollerState.isRunning = false;
  if (pollerTimeout) clearTimeout(pollerTimeout);
  pollerState.nextRunTime = null;
}

// Initial start of background poller
if (pollerState.isRunning) {
  setTimeout(() => runBackendPollCycle('initial_boot'), 3000);
}

// Helper: HTTP/HTTPS POST
function makePostRequest(targetUrl, headers, postData) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: headers,
      rejectUnauthorized: false
    };

    const req = (parsedUrl.protocol === 'https:' ? https : http).request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, data: body });
      });
    });

    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Helper: HTTP/HTTPS GET with retries
function makeGetRequest(targetUrl, headers = {}, retries = 2) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        ...headers
      },
      rejectUnauthorized: false
    };

    const req = (parsedUrl.protocol === 'https:' ? https : http).request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, data: body });
      });
    });

    req.on('error', async (err) => {
      if (retries > 0) {
        await new Promise(r => setTimeout(r, 400));
        makeGetRequest(targetUrl, headers, retries - 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
    req.end();
  });
}

// Helper: Get Fresh Zoho Access Token
let lastConfigHash = '';
async function getZohoToken(force = false) {
  loadConfig();
  const zohoCfg = currentConfig.zoho || {};
  const currentHash = `${zohoCfg.clientId}|${zohoCfg.clientSecret}|${zohoCfg.refreshToken}`;
  if (currentHash !== lastConfigHash) {
    cachedToken = null;
    tokenExpiresAt = 0;
    lastConfigHash = currentHash;
  }

  const now = Date.now();
  if (!force && cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: (zohoCfg.clientId || '').trim(),
    client_secret: (zohoCfg.clientSecret || '').trim(),
    refresh_token: (zohoCfg.refreshToken || '').trim()
  });

  const tokenUrl = zohoCfg.tokenUrl || 'https://accounts.zoho.in/oauth/v2/token';
  const res = await makePostRequest(tokenUrl, {
    'Content-Type': 'application/x-www-form-urlencoded'
  }, params.toString());

  const json = JSON.parse(res.data);
  if (json.access_token) {
    cachedToken = json.access_token;
    tokenExpiresAt = Date.now() + ((json.expires_in || 3600) * 1000);
    return cachedToken;
  } else {
    throw new Error(json.error || 'Failed to obtain access token');
  }
}

// Server Request Handler
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost:3500'}`);
  const pathname = parsedUrl.pathname;

  // Enable CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Parse Body
  let reqBody = '';
  req.on('data', chunk => reqBody += chunk);
  await new Promise(resolve => req.on('end', resolve));

  try {
    // API: Availability Endpoint
    if (pathname === '/api/availability') {
      const availUrl = (currentConfig.availability?.apiUrl || 'https://madhava.kambala.co.in/deltabaavailability/api/availability/') + '?t=' + Date.now();
      try {
        const response = await makeGetRequest(availUrl);
        if (response.status === 200) {
          lastAvailabilityCache = response.data;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(response.data);
          return;
        }
      } catch (e) {
        console.warn("Availability API fetch failed, checking cache:", e.message);
      }

      if (lastAvailabilityCache) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(lastAvailabilityCache);
        return;
      }

      // Default availability baseline
      const defaultAvail = {
        status: "success",
        range_details: [
          { row_index: 1, row_details: [{ column_index: 1, content: "Name" }, { column_index: 2, content: "Availability" }, { column_index: 3, content: "Phone" }] },
          { row_index: 2, row_details: [{ column_index: 1, content: "Sakil Raj" }, { column_index: 2, content: "Available" }, { column_index: 3, content: "9876543210" }] },
          { row_index: 3, row_details: [{ column_index: 1, content: "Karthik" }, { column_index: 2, content: "Available" }, { column_index: 3, content: "9876543211" }] },
          { row_index: 4, row_details: [{ column_index: 1, content: "Kishan" }, { column_index: 2, content: "Escalation Available" }, { column_index: 3, content: "9876543212" }] },
          { row_index: 5, row_details: [{ column_index: 1, content: "Deeksha" }, { column_index: 2, content: "Available" }, { column_index: 3, content: "9876543213" }] },
          { row_index: 6, row_details: [{ column_index: 1, content: "Puneeth" }, { column_index: 2, content: "Available" }, { column_index: 3, content: "9876543214" }] },
          { row_index: 7, row_details: [{ column_index: 1, content: "Krathika" }, { column_index: 2, content: "Available" }, { column_index: 3, content: "9876543215" }] }
        ]
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(defaultAvail));
      return;
    }

    // API: Zoho Token Refresh
    if (pathname === '/api/zoho/token') {
      const token = await getZohoToken(true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', access_token: token }));
      return;
    }

    // API: Zoho Group Tasks (To-Do API for Group 60072251579)
    if (pathname === '/api/zoho/group-tasks') {
      const groupId = parsedUrl.searchParams.get('groupId') || currentConfig.tasks?.targetGroupId || '60072251579';

      try {
        const token = await getZohoToken();

        // Concurrently fetch open/active tasks and recent closed tasks
        const fetchOpenPromise = (async () => {
          let openTasks = [];
          let nextUrl = `https://mail.zoho.in/api/tasks/groups/${groupId}?limit=100`;
          while (nextUrl) {
            const response = await makeGetRequest(nextUrl, {
              'Authorization': `Zoho-oauthtoken ${token}`,
              'Content-Type': 'application/json'
            });
            if (response.status !== 200) break;
            const parsed = JSON.parse(response.data);
            const tasks = (parsed.data && parsed.data.tasks) ? parsed.data.tasks : (parsed.tasks || []);
            openTasks = openTasks.concat(tasks);
            if (parsed.data && parsed.data.paging && parsed.data.paging.nextPage) {
              nextUrl = `https://mail.zoho.in/api/${parsed.data.paging.nextPage}`;
            } else {
              nextUrl = null;
            }
          }
          return openTasks;
        })();

        const fetchClosedPromise = (async () => {
          let closedTasks = [];
          // Fetch up to 2 pages of recent closed tasks (up to 200 tasks)
          let nextUrl = `https://mail.zoho.in/api/tasks/groups/${groupId}?status=closed&limit=100`;
          let pages = 0;
          while (nextUrl && pages < 2) {
            const response = await makeGetRequest(nextUrl, {
              'Authorization': `Zoho-oauthtoken ${token}`,
              'Content-Type': 'application/json'
            });
            if (response.status !== 200) break;
            const parsed = JSON.parse(response.data);
            const tasks = (parsed.data && parsed.data.tasks) ? parsed.data.tasks : (parsed.tasks || []);
            closedTasks = closedTasks.concat(tasks);
            pages++;
            if (parsed.data && parsed.data.paging && parsed.data.paging.nextPage) {
              nextUrl = `https://mail.zoho.in/api/${parsed.data.paging.nextPage}`;
            } else {
              nextUrl = null;
            }
          }
          return closedTasks;
        })();

        const [openTasks, closedTasks] = await Promise.all([fetchOpenPromise, fetchClosedPromise]);

        // Enrich tasks with normalized display status
        const enrichTask = (t, isClosed) => {
          const rawStatus = (t.status || '').trim();
          let displayStatus = rawStatus;
          let category = 'open';

          if (isClosed || rawStatus.toLowerCase().includes('complet') || rawStatus.toLowerCase().includes('close') || t.statusValue === 3) {
            displayStatus = 'Closed / Completed';
            category = 'closed';
          } else if (rawStatus.toLowerCase() === 'in progress' || t.statusValue === 2) {
            displayStatus = 'In Progress';
            category = 'in-progress';
          } else if (!rawStatus || t.statusValue >= 10) {
            displayStatus = 'Client / Internal Pending';
            category = 'pending-other';
          } else {
            displayStatus = rawStatus || 'Open';
            category = 'open';
          }

          return {
            ...t,
            isClosed: category === 'closed',
            displayStatus: displayStatus,
            statusCategory: category
          };
        };

        const enrichedOpen = openTasks.map(t => enrichTask(t, false));
        const enrichedClosed = closedTasks.map(t => enrichTask(t, true));

        // Deduplicate by task ID if any overlap
        const taskMap = new Map();
        enrichedOpen.forEach(t => taskMap.set(t.id, t));
        enrichedClosed.forEach(t => {
          if (!taskMap.has(t.id)) taskMap.set(t.id, t);
        });

        const allTasks = Array.from(taskMap.values());

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'success',
          httpStatus: 200,
          groupId: groupId,
          totalTasks: allTasks.length,
          openCount: enrichedOpen.length,
          closedCount: enrichedClosed.length,
          openTasks: enrichedOpen,
          closedTasks: enrichedClosed,
          tasks: allTasks
        }));
        return;
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'error',
          httpStatus: 500,
          groupId: groupId,
          error: err.message
        }));
        return;
      }
    }

    // API: Zoho Sheet Call Proxy
    if (pathname === '/api/zoho/sheet') {
      const token = await getZohoToken();
      const payload = JSON.parse(reqBody || '{}');
      const sheetId = payload.sheetId;
      const method = payload.method || 'worksheet.content.get';
      const extra = payload.params || {};

      const formData = new URLSearchParams();
      formData.append('method', method);
      for (const [k, v] of Object.entries(extra)) {
        formData.append(k, typeof v === 'object' ? JSON.stringify(v) : v);
      }

      const sheetApiBase = currentConfig.zoho?.sheetApiBase || 'https://sheet.zoho.in/api/v2';
      const targetUrl = `${sheetApiBase}/${sheetId}`;

      const response = await makePostRequest(targetUrl, {
        'Authorization': `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }, formData.toString());

      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(response.data);
      return;
    }

    // API: Cliq Webhook Proxy
    if (pathname === '/api/cliq/send') {
      const payload = JSON.parse(reqBody || '{}');
      const webhookUrl = payload.webhookUrl || currentConfig.cliq?.webhookUrl;
      const messageText = payload.text;

      const response = await makePostRequest(webhookUrl, {
        'Content-Type': 'application/json'
      }, JSON.stringify({ text: messageText }));

      res.writeHead(response.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', code: response.status }));
      return;
    }

    // API: BA Availability Poller Status
    if (pathname === '/api/availability/poller-status') {
      const now = Date.now();
      let remainingSec = 0;
      if (pollerState.isRunning && pollerState.nextRunTime) {
        remainingSec = Math.max(0, Math.round((new Date(pollerState.nextRunTime).getTime() - now) / 1000));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        isRunning: pollerState.isRunning,
        intervalSec: pollerState.intervalSec,
        autoCliqBroadcast: pollerState.autoCliqBroadcast,
        cliqMonitoredOnly: pollerState.cliqMonitoredOnly,
        lastRunTime: pollerState.lastRunTime,
        nextRunTime: pollerState.nextRunTime,
        remainingSec: remainingSec,
        lastStatus: pollerState.lastStatus,
        lastLog: pollerState.lastLog,
        history: pollerState.history.slice(0, 15)
      }));
      return;
    }

    // API: BA Availability Poller Control
    if (pathname === '/api/availability/poller-control') {
      const payload = JSON.parse(reqBody || '{}');
      const action = payload.action; // 'start', 'pause', 'resume', 'trigger_now', 'update'

      if (typeof payload.intervalSec === 'number' && payload.intervalSec >= 5) {
        pollerState.intervalSec = payload.intervalSec;
        if (!currentConfig.availability) currentConfig.availability = {};
        currentConfig.availability.defaultIntervalSec = payload.intervalSec;
      }

      if (typeof payload.autoCliqBroadcast === 'boolean') {
        pollerState.autoCliqBroadcast = payload.autoCliqBroadcast;
        if (!currentConfig.availability) currentConfig.availability = {};
        currentConfig.availability.autoCliqBroadcast = payload.autoCliqBroadcast;
      }

      if (typeof payload.cliqMonitoredOnly === 'boolean') {
        pollerState.cliqMonitoredOnly = payload.cliqMonitoredOnly;
        if (!currentConfig.availability) currentConfig.availability = {};
        currentConfig.availability.cliqMonitoredOnly = payload.cliqMonitoredOnly;
      }

      if (action === 'start' || action === 'resume') {
        startBackendPoller();
        if (!currentConfig.availability) currentConfig.availability = {};
        currentConfig.availability.autoPollerActive = true;
      } else if (action === 'pause') {
        stopBackendPoller();
        if (!currentConfig.availability) currentConfig.availability = {};
        currentConfig.availability.autoPollerActive = false;
      } else if (action === 'trigger_now') {
        runBackendPollCycle('manual_trigger');
      } else if (action === 'update') {
        if (pollerState.isRunning) {
          scheduleNextPoll();
        }
      }

      // Persist poller configuration to disk
      try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfig, null, 2), 'utf8');
        const jsFileContent = `window.DEFAULT_CONFIG = ${JSON.stringify(currentConfig, null, 2)};`;
        fs.writeFileSync(path.join(BASE_DIR, 'config', 'config.js'), jsFileContent, 'utf8');
      } catch (e) {
        console.warn("Could not persist poller config:", e.message);
      }

      const now = Date.now();
      let remainingSec = 0;
      if (pollerState.isRunning && pollerState.nextRunTime) {
        remainingSec = Math.max(0, Math.round((new Date(pollerState.nextRunTime).getTime() - now) / 1000));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        action: action,
        isRunning: pollerState.isRunning,
        intervalSec: pollerState.intervalSec,
        autoCliqBroadcast: pollerState.autoCliqBroadcast,
        cliqMonitoredOnly: pollerState.cliqMonitoredOnly,
        lastRunTime: pollerState.lastRunTime,
        nextRunTime: pollerState.nextRunTime,
        remainingSec: remainingSec,
        lastStatus: pollerState.lastStatus,
        lastLog: pollerState.lastLog
      }));
      return;
    }

    // API: Config Get / Save
    if (pathname === '/api/config') {
      if (req.method === 'POST') {
        const newCfg = JSON.parse(reqBody || '{}');
        currentConfig = newCfg;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfig, null, 2), 'utf8');
        const jsFileContent = `window.DEFAULT_CONFIG = ${JSON.stringify(currentConfig, null, 2)};`;
        fs.writeFileSync(path.join(BASE_DIR, 'config', 'config.js'), jsFileContent, 'utf8');
        cachedToken = null;

        // Synchronize poller settings with new config
        if (currentConfig.availability?.defaultIntervalSec) {
          pollerState.intervalSec = currentConfig.availability.defaultIntervalSec;
        }
        if (typeof currentConfig.availability?.autoCliqBroadcast === 'boolean') {
          pollerState.autoCliqBroadcast = currentConfig.availability.autoCliqBroadcast;
        }
        if (typeof currentConfig.availability?.cliqMonitoredOnly === 'boolean') {
          pollerState.cliqMonitoredOnly = currentConfig.availability.cliqMonitoredOnly;
        }
        if (typeof currentConfig.availability?.autoPollerActive === 'boolean') {
          if (currentConfig.availability.autoPollerActive && !pollerState.isRunning) {
            startBackendPoller();
          } else if (!currentConfig.availability.autoPollerActive && pollerState.isRunning) {
            stopBackendPoller();
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', message: 'Config updated and persisted to disk' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(currentConfig));
      }
      return;
    }

    // Static Files Handler
    let filePath = path.join(BASE_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(BASE_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon'
    };

    const contentType = mimeTypes[ext] || 'text/plain';
    const fileContent = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fileContent);

  } catch (err) {
    console.error("Server Error:", err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🚀 Team Admin Monitor running at: http://localhost:${PORT}`);
  console.log(`=================================================`);
});
