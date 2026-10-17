const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3500;
const BASE_DIR = __dirname;
const CONFIG_PATH = path.join(BASE_DIR, 'config', 'config.json');
const REBUILD_VAULT_DIR = path.join(os.homedir(), '.delta-admin-crons-backup');
const VAULT_CONFIG_PATH = path.join(REBUILD_VAULT_DIR, 'config.json');

let currentConfig = {};

function persistConfigToDisk(cfg) {
  try {
    cfg._savedAt = cfg._savedAt || Date.now();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    const jsFileContent = `window.DEFAULT_CONFIG = ${JSON.stringify(cfg, null, 2)};`;
    fs.writeFileSync(path.join(BASE_DIR, 'config', 'config.js'), jsFileContent, 'utf8');
    if (!fs.existsSync(REBUILD_VAULT_DIR)) fs.mkdirSync(REBUILD_VAULT_DIR, { recursive: true });
    fs.writeFileSync(VAULT_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.warn("Could not persist config to disk/vault:", e.message);
  }
}

function loadConfig() {
  try {
    let repoCfg = null;
    let vaultCfg = null;
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
      repoCfg = JSON.parse(raw);
    }
    if (fs.existsSync(VAULT_CONFIG_PATH)) {
      const rawV = fs.readFileSync(VAULT_CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
      vaultCfg = JSON.parse(rawV);
    }
    // If the user previously saved settings into the external vault, keep the vault settings even if a rebuild reset config/config.json
    if (vaultCfg && (!repoCfg || (vaultCfg._savedAt || 0) >= (repoCfg._savedAt || 0))) {
      currentConfig = { ...(repoCfg || {}), ...vaultCfg };
      persistConfigToDisk(currentConfig);
    } else if (repoCfg) {
      currentConfig = repoCfg;
      if (!fs.existsSync(VAULT_CONFIG_PATH)) {
        persistConfigToDisk(currentConfig);
      }
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
  const timeString = now.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
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
      const logTimeStr = startTime.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
      pollerState.lastLog = `[${logTimeStr}] Fresh BA data fetched. Cliq: ${cliqResult} (${triggerSource})`;
    } else {
      pollerState.lastStatus = 'api_error';
      const logTimeStr = startTime.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
      pollerState.lastLog = `[${logTimeStr}] Availability API returned HTTP ${response.status}`;
    }
  } catch (err) {
    pollerState.lastStatus = 'error';
    const logTimeStr = startTime.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
    pollerState.lastLog = `[${logTimeStr}] Error: ${err.message}`;
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

// ==========================================
// 24/7 AUTO-DISCOVERY CRONS & SCRIPT ENGINE (.bat / .awk / .ps1 / .sh)
// ==========================================
const CRONS_DIR = path.join(BASE_DIR, 'crons');
const SCHEDULE_FILE = path.join(CRONS_DIR, 'schedule.txt');
const RUN_HISTORY_LOG = path.join(CRONS_DIR, 'run_history.log');
const RUN_HISTORY_JSON = path.join(CRONS_DIR, 'run_history.json');
const ALLOWED_SCRIPT_EXTS = new Set(['.bat', '.awk', '.cmd', '.ps1', '.sh']);

if (!fs.existsSync(CRONS_DIR)) {
  fs.mkdirSync(CRONS_DIR, { recursive: true });
}
if (!fs.existsSync(REBUILD_VAULT_DIR)) {
  try { fs.mkdirSync(REBUILD_VAULT_DIR, { recursive: true }); } catch (e) {}
}

// Restore any scripts/schedules from the external Rebuild-Safe Vault if missing after a build/re-clone
function restoreFromRebuildSafeVault() {
  try {
    if (!fs.existsSync(REBUILD_VAULT_DIR)) return;
    const vaultEntries = fs.readdirSync(REBUILD_VAULT_DIR, { withFileTypes: true });
    for (const entry of vaultEntries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const srcPath = path.join(REBUILD_VAULT_DIR, entry.name);
      const destPath = path.join(CRONS_DIR, entry.name);
      if (ALLOWED_SCRIPT_EXTS.has(ext) && !fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
      } else if ((entry.name === 'run_history.log' || entry.name === 'run_history.json') && !fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
    // Merge vault schedule.txt entries into local schedule.txt so custom schedules survive rebuilds
    const vaultSchedPath = path.join(REBUILD_VAULT_DIR, 'schedule.txt');
    if (fs.existsSync(vaultSchedPath)) {
      if (!fs.existsSync(SCHEDULE_FILE)) {
        fs.copyFileSync(vaultSchedPath, SCHEDULE_FILE);
      } else {
        const localText = fs.readFileSync(SCHEDULE_FILE, 'utf8');
        const vaultText = fs.readFileSync(vaultSchedPath, 'utf8');
        const localMap = new Map();
        localText.split(/\r?\n/).forEach(l => {
          const t = l.trim();
          if (!t || t.startsWith('#') || t.startsWith('//')) return;
          const name = t.split(/[\s=|]+/)[0].toLowerCase();
          if (name) localMap.set(name, t);
        });
        let linesToAppend = '';
        vaultText.split(/\r?\n/).forEach(l => {
          const t = l.trim();
          if (!t || t.startsWith('#') || t.startsWith('//')) return;
          const name = t.split(/[\s=|]+/)[0].toLowerCase();
          if (name && !localMap.has(name)) {
            linesToAppend += `\n${t}`;
          }
        });
        if (linesToAppend) {
          fs.appendFileSync(SCHEDULE_FILE, linesToAppend + '\n', 'utf8');
        }
      }
    }
  } catch (e) {
    console.warn("Vault restore check note:", e.message);
  }
}

// Mirror current crons/ scripts & schedule.txt to the external Rebuild-Safe Vault
function mirrorToRebuildSafeVault() {
  try {
    if (!fs.existsSync(REBUILD_VAULT_DIR)) fs.mkdirSync(REBUILD_VAULT_DIR, { recursive: true });
    if (fs.existsSync(SCHEDULE_FILE)) {
      fs.copyFileSync(SCHEDULE_FILE, path.join(REBUILD_VAULT_DIR, 'schedule.txt'));
    }
    if (fs.existsSync(RUN_HISTORY_LOG)) {
      fs.copyFileSync(RUN_HISTORY_LOG, path.join(REBUILD_VAULT_DIR, 'run_history.log'));
    }
    if (fs.existsSync(RUN_HISTORY_JSON)) {
      fs.copyFileSync(RUN_HISTORY_JSON, path.join(REBUILD_VAULT_DIR, 'run_history.json'));
    }
    for (const scriptObj of Object.values(cronEngineState.scripts)) {
      if (scriptObj.fullPath && fs.existsSync(scriptObj.fullPath)) {
        fs.copyFileSync(scriptObj.fullPath, path.join(REBUILD_VAULT_DIR, scriptObj.name));
      }
    }
  } catch (e) {}
}

let cronEngineState = {
  isRunning: currentConfig.crons?.engineActive ?? true,
  scripts: {}, // keyed by script filename
  history: [],
  lastScanTime: null
};

// Load persisted run history if available
function loadCronHistory() {
  try {
    if (fs.existsSync(RUN_HISTORY_JSON)) {
      const parsed = JSON.parse(fs.readFileSync(RUN_HISTORY_JSON, 'utf8'));
      if (Array.isArray(parsed.history)) {
        cronEngineState.history = parsed.history;
      }
      if (parsed.scriptStats && typeof parsed.scriptStats === 'object') {
        for (const [name, stats] of Object.entries(parsed.scriptStats)) {
          cronEngineState.scripts[name] = {
            ...(cronEngineState.scripts[name] || {}),
            ...stats,
            isExecuting: false
          };
        }
      }
    }
  } catch (e) {
    console.warn("Could not load cron history JSON:", e.message);
  }
}

function saveCronHistory() {
  try {
    const scriptStats = {};
    for (const [name, s] of Object.entries(cronEngineState.scripts)) {
      scriptStats[name] = {
        lastRunTime: s.lastRunTime || null,
        lastDurationMs: s.lastDurationMs ?? null,
        lastStatus: s.lastStatus || 'idle',
        lastExitCode: s.lastExitCode ?? null,
        lastOutput: s.lastOutput || '',
        lastTrigger: s.lastTrigger || null,
        runCount: s.runCount || 0,
        lastFiredMinuteKey: s.lastFiredMinuteKey || null
      };
    }
    fs.writeFileSync(RUN_HISTORY_JSON, JSON.stringify({
      updatedAt: new Date().toISOString(),
      scriptStats,
      history: cronEngineState.history.slice(0, 100)
    }, null, 2), 'utf8');
  } catch (e) {
    console.warn("Could not save cron history JSON:", e.message);
  }
}

function resolveAwkExecutable() {
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\awk.exe',
    'C:\\Program Files\\Git\\usr\\bin\\gawk.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\awk.exe',
    'C:\\msys64\\usr\\bin\\awk.exe'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return `"${c}"`;
  }
  return 'awk';
}

// Parse flexible human schedule string from schedule.txt
function parseCronScheduleRule(rawRule) {
  let rule = (rawRule || '').trim();
  let autoCliq = false;
  if (/\[cliq\]/i.test(rule)) {
    autoCliq = true;
    rule = rule.replace(/\[cliq\]/gi, '').trim();
  }

  if (!rule || /^(manual|off|none|disabled|pause|paused|-)$/i.test(rule)) {
    return { type: 'manual', raw: rawRule || 'manual', autoCliq, label: 'Manual Only' };
  }

  // 1. Check interval format: "every 5m", "every 30s", "every 2h", "15m", "300s", "10 mins"
  const intervalMatch = rule.match(/^(?:every\s+)?(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i);
  if (intervalMatch) {
    const val = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    let intervalSec = val;
    if (unit.startsWith('m')) intervalSec = val * 60;
    else if (unit.startsWith('h')) intervalSec = val * 3600;
    intervalSec = Math.max(5, intervalSec);
    return {
      type: 'interval',
      intervalSec,
      raw: rawRule,
      autoCliq,
      label: `Every ${val}${unit[0]}`
    };
  }

  // 2. Check daily time(s) format: "09:30", "09:30, 14:00, 18:30", "9:30 AM", "06:15 PM"
  const timeParts = rule.split(',').map(p => p.trim()).filter(Boolean);
  const parsedTimes = [];
  let allValidTimes = timeParts.length > 0;

  for (const part of timeParts) {
    const tm = part.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
    if (!tm) {
      allValidTimes = false;
      break;
    }
    let hh = parseInt(tm[1], 10);
    const mm = parseInt(tm[2], 10);
    const ampm = tm[3] ? tm[3].toUpperCase() : null;
    if (ampm === 'PM' && hh < 12) hh += 12;
    if (ampm === 'AM' && hh === 12) hh = 0;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      allValidTimes = false;
      break;
    }
    parsedTimes.push({ hh, mm, formatted: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` });
  }

  if (allValidTimes) {
    parsedTimes.sort((a, b) => (a.hh * 60 + a.mm) - (b.hh * 60 + b.mm));
    return {
      type: 'daily_times',
      times: parsedTimes,
      raw: rawRule,
      autoCliq,
      label: `Daily at ${parsedTimes.map(t => t.formatted).join(', ')}`
    };
  }

  // 3. Check standard 5-field cron expression: "* * * * *" (min hour dom month dow)
  const cronTokens = rule.split(/\s+/);
  if (cronTokens.length === 5) {
    return {
      type: 'cron_expr',
      expr: rule,
      fields: cronTokens,
      raw: rawRule,
      autoCliq,
      label: `Cron (${rule})`
    };
  }

  return { type: 'invalid', raw: rawRule, autoCliq, label: `Invalid (${rule})` };
}

function matchCronField(fieldStr, value) {
  if (fieldStr === '*') return true;
  const parts = fieldStr.split(',');
  for (const part of parts) {
    if (part.includes('/')) {
      const [base, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (!step || step <= 0) continue;
      if (base === '*') {
        if (value % step === 0) return true;
      } else if (base.includes('-')) {
        const [min, max] = base.split('-').map(Number);
        if (value >= min && value <= max && (value - min) % step === 0) return true;
      }
    } else if (part.includes('-')) {
      const [min, max] = part.split('-').map(Number);
      if (value >= min && value <= max) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

function doesCronExprMatchDate(fields, dateObj) {
  const [minF, hourF, domF, monF, dowF] = fields;
  return (
    matchCronField(minF, dateObj.getMinutes()) &&
    matchCronField(hourF, dateObj.getHours()) &&
    matchCronField(domF, dateObj.getDate()) &&
    matchCronField(monF, dateObj.getMonth() + 1) &&
    matchCronField(dowF, dateObj.getDay())
  );
}

function computeNextRunTime(scriptObj, nowMs = Date.now()) {
  if (!cronEngineState.isRunning) return null;
  const parsed = scriptObj.parsedSchedule;
  if (!parsed || parsed.type === 'manual' || parsed.type === 'invalid') return null;

  if (parsed.type === 'interval') {
    const baseMs = scriptObj.lastRunTime ? new Date(scriptObj.lastRunTime).getTime() : scriptObj.discoveredAtMs || nowMs;
    const nextMs = baseMs + parsed.intervalSec * 1000;
    return new Date(Math.max(nowMs + 1000, nextMs)).toISOString();
  }

  if (parsed.type === 'daily_times') {
    const now = new Date(nowMs);
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      for (const t of parsed.times) {
        const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, t.hh, t.mm, 0, 0);
        const candMinuteKey = `${candidate.getFullYear()}-${candidate.getMonth()}-${candidate.getDate()}-${t.hh}:${t.mm}`;
        if (candidate.getTime() > nowMs || (candidate.getTime() + 59000 > nowMs && scriptObj.lastFiredMinuteKey !== candMinuteKey)) {
          if (candidate.getTime() <= nowMs && scriptObj.lastFiredMinuteKey !== candMinuteKey) {
            return new Date(nowMs).toISOString();
          }
          if (candidate.getTime() > nowMs) {
            return candidate.toISOString();
          }
        }
      }
    }
  }

  if (parsed.type === 'cron_expr') {
    const base = new Date(nowMs);
    base.setSeconds(0, 0);
    for (let i = 0; i < 1440 * 7; i++) {
      const cand = new Date(base.getTime() + i * 60000);
      const candKey = `${cand.getFullYear()}-${cand.getMonth()}-${cand.getDate()}-${cand.getHours()}:${cand.getMinutes()}`;
      if (doesCronExprMatchDate(parsed.fields, cand)) {
        if (i === 0 && scriptObj.lastFiredMinuteKey !== candKey) {
          return new Date(nowMs).toISOString();
        } else if (i > 0) {
          return cand.toISOString();
        }
      }
    }
  }

  return null;
}

// Scan crons/ folder and sync with crons/schedule.txt
function syncCronsFolderAndSchedule() {
  try {
    if (!fs.existsSync(CRONS_DIR)) fs.mkdirSync(CRONS_DIR, { recursive: true });
    if (!fs.existsSync(SCHEDULE_FILE)) {
      fs.writeFileSync(SCHEDULE_FILE, `# DELTA ADMIN - AUTO CRON SCHEDULE FILE (crons/schedule.txt)\n# Format: script_name = HH:MM  OR  every 15m  OR  */30 * * * *\n\n`, 'utf8');
    }

    // 1. Read schedule.txt lines
    const rawScheduleText = fs.readFileSync(SCHEDULE_FILE, 'utf8');
    const scheduleMap = new Map(); // filename -> { args, ruleStr }

    rawScheduleText.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return;

      // Support "script.bat [args] = schedule" or "script.bat | schedule"
      let left = '';
      let right = '';
      if (trimmed.includes('=')) {
        const idx = trimmed.indexOf('=');
        left = trimmed.slice(0, idx).trim();
        right = trimmed.slice(idx + 1).trim();
      } else if (trimmed.includes('|')) {
        const idx = trimmed.indexOf('|');
        left = trimmed.slice(0, idx).trim();
        right = trimmed.slice(idx + 1).trim();
      } else {
        const tokens = trimmed.split(/\s+/);
        left = tokens[0];
        right = tokens.slice(1).join(' ');
      }

      if (left) {
        const parts = left.split(/\s+/);
        const scriptName = parts[0].trim();
        const scriptArgs = parts.slice(1).join(' ').trim();
        scheduleMap.set(scriptName.toLowerCase(), {
          exactName: scriptName,
          args: scriptArgs,
          ruleStr: right || 'manual'
        });
      }
    });

    // 2. Discover all script files in crons/ (and crons/scripts/ if present)
    const discoveredFiles = new Map(); // lowerName -> { name, relPath, fullPath, ext, size, mtime }
    const scanDirs = [CRONS_DIR, path.join(CRONS_DIR, 'scripts')];

    for (const dir of scanDirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_SCRIPT_EXTS.has(ext)) continue;
        const fullPath = path.join(dir, entry.name);
        const st = fs.statSync(fullPath);
        discoveredFiles.set(entry.name.toLowerCase(), {
          name: entry.name,
          fullPath,
          ext,
          size: st.size,
          mtime: st.mtime.toISOString()
        });
      }
    }

    // 3. Auto-append newly dropped files to schedule.txt so user sees them immediately
    let appendedNewToSchedule = false;
    let newLinesToAppend = '';
    for (const [lowerName, fileInfo] of discoveredFiles.entries()) {
      if (!scheduleMap.has(lowerName)) {
        scheduleMap.set(lowerName, {
          exactName: fileInfo.name,
          args: '',
          ruleStr: 'manual'
        });
        newLinesToAppend += `\n${fileInfo.name} = manual`;
        appendedNewToSchedule = true;
      }
    }

    if (appendedNewToSchedule) {
      try {
        fs.appendFileSync(SCHEDULE_FILE, newLinesToAppend + '\n', 'utf8');
      } catch (e) {
        console.warn("Could not auto-append to schedule.txt:", e.message);
      }
    }

    // 4. Update cronEngineState.scripts
    const nowMs = Date.now();
    const activeNames = new Set();

    for (const [lowerName, fileInfo] of discoveredFiles.entries()) {
      activeNames.add(fileInfo.name);
      const schedEntry = scheduleMap.get(lowerName) || { args: '', ruleStr: 'manual' };
      const existing = cronEngineState.scripts[fileInfo.name] || {};
      const parsedSchedule = parseCronScheduleRule(schedEntry.ruleStr);

      const updatedScript = {
        name: fileInfo.name,
        ext: fileInfo.ext,
        fullPath: fileInfo.fullPath,
        size: fileInfo.size,
        mtime: fileInfo.mtime,
        args: schedEntry.args || '',
        scheduleRaw: schedEntry.ruleStr,
        parsedSchedule,
        discoveredAtMs: existing.discoveredAtMs || nowMs,
        isExecuting: existing.isExecuting || false,
        lastRunTime: existing.lastRunTime || null,
        lastDurationMs: existing.lastDurationMs ?? null,
        lastStatus: existing.lastStatus || 'idle',
        lastExitCode: existing.lastExitCode ?? null,
        lastOutput: existing.lastOutput || '',
        lastTrigger: existing.lastTrigger || null,
        runCount: existing.runCount || 0,
        lastFiredMinuteKey: existing.lastFiredMinuteKey || null
      };
      updatedScript.nextRunTime = computeNextRunTime(updatedScript, nowMs);
      cronEngineState.scripts[fileInfo.name] = updatedScript;
    }

    // Remove deleted scripts from active map
    for (const existingName of Object.keys(cronEngineState.scripts)) {
      if (!activeNames.has(existingName)) {
        delete cronEngineState.scripts[existingName];
      }
    }

    cronEngineState.lastScanTime = new Date().toISOString();
    mirrorToRebuildSafeVault();
  } catch (err) {
    console.warn("Error scanning crons folder:", err.message);
  }
}

// Update a single script's schedule line inside crons/schedule.txt
function updateScheduleFileForScript(scriptName, newScheduleRaw, scriptArgs = '') {
  let content = '';
  if (fs.existsSync(SCHEDULE_FILE)) {
    content = fs.readFileSync(SCHEDULE_FILE, 'utf8');
  }
  const lines = content.split(/\r?\n/);
  const targetLower = scriptName.toLowerCase();
  let found = false;
  const formattedLeft = scriptArgs ? `${scriptName} ${scriptArgs}` : scriptName;

  const updatedLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return line;
    const firstToken = trimmed.split(/[\s=|]+/)[0].toLowerCase();
    if (firstToken === targetLower) {
      found = true;
      return `${formattedLeft} = ${newScheduleRaw}`;
    }
    return line;
  });

  if (!found) {
    updatedLines.push(`${formattedLeft} = ${newScheduleRaw}`);
  }

  fs.writeFileSync(SCHEDULE_FILE, updatedLines.join('\n'), 'utf8');
  syncCronsFolderAndSchedule();
}

// Execute a .bat / .awk / .ps1 / .sh script and record runtime to crons/run_history.log & .json
async function executeCronScript(scriptName, triggerSource = 'scheduled') {
  syncCronsFolderAndSchedule();
  const scriptObj = cronEngineState.scripts[scriptName];
  if (!scriptObj) {
    throw new Error(`Script "${scriptName}" not found in crons/ directory.`);
  }
  if (scriptObj.isExecuting) {
    return { status: 'busy', message: `Script "${scriptName}" is already running.` };
  }

  scriptObj.isExecuting = true;
  const startMs = Date.now();
  const startIso = new Date(startMs).toISOString();
  scriptObj.lastRunTime = startIso;
  scriptObj.lastTrigger = triggerSource;
  scriptObj.lastStatus = 'running';

  // Build command line based on file extension
  const fullPath = scriptObj.fullPath;
  const args = scriptObj.args || '';
  let cmd = '';

  if (scriptObj.ext === '.awk') {
    const awkBin = resolveAwkExecutable();
    // Provide < NUL if no input file argument is passed so AWK scripts never hang waiting for stdin
    const inputRedir = args ? '' : ' < NUL';
    cmd = `${awkBin} -f "${fullPath}" ${args}${inputRedir}`;
  } else if (scriptObj.ext === '.bat' || scriptObj.ext === '.cmd') {
    cmd = `cmd.exe /c ""${fullPath}" ${args}"`;
  } else if (scriptObj.ext === '.ps1') {
    cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${fullPath}" ${args}`;
  } else if (scriptObj.ext === '.sh') {
    cmd = `bash "${fullPath}" ${args}`;
  } else {
    cmd = `"${fullPath}" ${args}`;
  }

  // Ensure Git usr\bin is in PATH so .bat scripts calling awk/sed/grep work natively on Windows
  const envPath = process.env.PATH || '';
  const extraPaths = ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files\\Git\\bin'];
  const augmentedPath = [...extraPaths, envPath].join(path.delimiter);

  return new Promise((resolve) => {
    exec(cmd, {
      cwd: CRONS_DIR,
      env: { ...process.env, PATH: augmentedPath },
      timeout: 5 * 60 * 1000, // 5 minute safety timeout
      maxBuffer: 1024 * 1024 * 2
    }, async (error, stdout, stderr) => {
      const endMs = Date.now();
      const durationMs = endMs - startMs;
      const exitCode = error ? (error.code ?? 1) : 0;
      const status = error ? 'error' : 'success';
      const combinedOutput = [stdout, stderr, error && !stderr ? error.message : '']
        .map(s => (s || '').trim())
        .filter(Boolean)
        .join('\n') || '(No console output)';

      scriptObj.isExecuting = false;
      scriptObj.lastDurationMs = durationMs;
      scriptObj.lastStatus = status;
      scriptObj.lastExitCode = exitCode;
      scriptObj.lastOutput = combinedOutput.slice(0, 4000);
      scriptObj.runCount = (scriptObj.runCount || 0) + 1;
      scriptObj.nextRunTime = computeNextRunTime(scriptObj, endMs);

      const istTimeStr = new Date(startMs).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });

      const historyEntry = {
        id: `${startMs}-${scriptName}`,
        timestamp: startIso,
        istTime: istTimeStr,
        scriptName,
        ext: scriptObj.ext,
        scheduleLabel: scriptObj.parsedSchedule?.label || scriptObj.scheduleRaw,
        triggerSource,
        status,
        exitCode,
        durationMs,
        output: scriptObj.lastOutput
      };

      cronEngineState.history.unshift(historyEntry);
      if (cronEngineState.history.length > 100) cronEngineState.history.pop();
      saveCronHistory();

      // Append to human-readable crons/run_history.log (1 unified file with run time of all recorded)
      const singleLineOutput = combinedOutput.replace(/\r?\n/g, ' :: ').slice(0, 500);
      const logLine = `[${istTimeStr}] | SCRIPT: ${scriptName.padEnd(22)} | SCHEDULE: ${(scriptObj.scheduleRaw || 'manual').padEnd(16)} | TRIGGER: ${triggerSource.padEnd(10)} | STATUS: ${status.toUpperCase()} (Code ${exitCode}) | RUN TIME: ${durationMs}ms | OUTPUT: ${singleLineOutput}\n`;
      try {
        fs.appendFileSync(RUN_HISTORY_LOG, logLine, 'utf8');
      } catch (e) {
        console.warn("Could not write to run_history.log:", e.message);
      }
      mirrorToRebuildSafeVault();

      // Optional Auto-Cliq broadcast if [cliq] tag is in schedule.txt
      if (scriptObj.parsedSchedule?.autoCliq && currentConfig.cliq?.webhookUrl) {
        try {
          const icon = status === 'success' ? '✅' : '❌';
          const cliqMsg = `${icon} *Cron Script Executed: ${scriptName}*\n🕒 *Time:* ${istTimeStr}\n⏱️ *Run Duration:* ${durationMs}ms | *Trigger:* ${triggerSource}\n\`\`\`\n${combinedOutput.slice(0, 800)}\n\`\`\``;
          await makePostRequest(currentConfig.cliq.webhookUrl, { 'Content-Type': 'application/json' }, JSON.stringify({ text: cliqMsg }));
        } catch (e) {}
      }

      resolve(historyEntry);
    });
  });
}

// 24/7 Background Scheduler Loop (runs every 1 second independent of any browser tab)
let lastFolderSyncMs = 0;
setInterval(() => {
  const nowMs = Date.now();
  // Auto-rescan crons folder & schedule.txt every 3 seconds to pick up new files/edits automatically
  if (nowMs - lastFolderSyncMs >= 3000) {
    lastFolderSyncMs = nowMs;
    syncCronsFolderAndSchedule();
  }

  if (!cronEngineState.isRunning) return;

  const now = new Date(nowMs);
  const currentMinuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}:${now.getMinutes()}`;

  for (const scriptObj of Object.values(cronEngineState.scripts)) {
    if (scriptObj.isExecuting) continue;
    const parsed = scriptObj.parsedSchedule;
    if (!parsed || parsed.type === 'manual' || parsed.type === 'invalid') continue;

    if (parsed.type === 'interval') {
      const nextMs = scriptObj.nextRunTime ? new Date(scriptObj.nextRunTime).getTime() : 0;
      if (nextMs && nowMs >= nextMs) {
        executeCronScript(scriptObj.name, 'scheduled');
      }
    } else if (parsed.type === 'daily_times') {
      for (const t of parsed.times) {
        if (now.getHours() === t.hh && now.getMinutes() === t.mm && scriptObj.lastFiredMinuteKey !== currentMinuteKey) {
          scriptObj.lastFiredMinuteKey = currentMinuteKey;
          executeCronScript(scriptObj.name, 'scheduled');
          break;
        }
      }
    } else if (parsed.type === 'cron_expr') {
      if (doesCronExprMatchDate(parsed.fields, now) && scriptObj.lastFiredMinuteKey !== currentMinuteKey) {
        scriptObj.lastFiredMinuteKey = currentMinuteKey;
        executeCronScript(scriptObj.name, 'scheduled');
      }
    }
  }
}, 1000);

// Initialize Cron History & Initial Scan on Server Boot (Auto-Restore from Vault if rebuilt)
restoreFromRebuildSafeVault();
loadCronHistory();
syncCronsFolderAndSchedule();

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

      // Persist poller configuration to disk & external Rebuild-Safe Vault
      currentConfig._savedAt = Date.now();
      persistConfigToDisk(currentConfig);

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
        newCfg._savedAt = newCfg._savedAt || Date.now();
        currentConfig = newCfg;
        persistConfigToDisk(currentConfig);
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

    // API: Crons Status & Auto-Discovery
    if (pathname === '/api/crons/status') {
      syncCronsFolderAndSchedule();
      let rawScheduleText = '';
      let rawLogText = '';
      try {
        if (fs.existsSync(SCHEDULE_FILE)) rawScheduleText = fs.readFileSync(SCHEDULE_FILE, 'utf8');
        if (fs.existsSync(RUN_HISTORY_LOG)) {
          const fullLog = fs.readFileSync(RUN_HISTORY_LOG, 'utf8');
          const logLines = fullLog.trim().split(/\r?\n/).filter(Boolean);
          rawLogText = logLines.slice(-100).reverse().join('\n');
        }
      } catch (e) {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        isRunning: cronEngineState.isRunning,
        cronsDir: CRONS_DIR,
        scheduleFile: SCHEDULE_FILE,
        runHistoryLogFile: RUN_HISTORY_LOG,
        lastScanTime: cronEngineState.lastScanTime,
        scripts: Object.values(cronEngineState.scripts),
        history: cronEngineState.history.slice(0, 60),
        rawScheduleText,
        rawLogText
      }));
      return;
    }

    // API: Crons Read Script Source Content
    if (pathname === '/api/crons/script-content') {
      const scriptName = path.basename(parsedUrl.searchParams.get('name') || '');
      const scriptObj = cronEngineState.scripts[scriptName];
      if (!scriptObj || !fs.existsSync(scriptObj.fullPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: 'Script file not found' }));
        return;
      }
      const code = fs.readFileSync(scriptObj.fullPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', name: scriptName, content: code }));
      return;
    }

    // API: Crons Control (Run Now, Update Schedule, Save schedule.txt, Create/Edit Script, Toggle Engine, Clear Logs)
    if (pathname === '/api/crons/control') {
      const payload = JSON.parse(reqBody || '{}');
      const action = payload.action;

      if (action === 'toggle_engine') {
        cronEngineState.isRunning = typeof payload.isRunning === 'boolean' ? payload.isRunning : !cronEngineState.isRunning;
        if (!currentConfig.crons) currentConfig.crons = {};
        currentConfig.crons.engineActive = cronEngineState.isRunning;
        try {
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfig, null, 2), 'utf8');
        } catch (e) {}
        syncCronsFolderAndSchedule();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', isRunning: cronEngineState.isRunning }));
        return;
      }

      if (action === 'run_now') {
        const scriptName = path.basename(payload.scriptName || '');
        const runRes = await executeCronScript(scriptName, 'manual');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', result: runRes }));
        return;
      }

      if (action === 'update_script_schedule') {
        const scriptName = path.basename(payload.scriptName || '');
        const scheduleRaw = (payload.scheduleRaw || 'manual').trim();
        const scriptArgs = (payload.args || '').trim();
        updateScheduleFileForScript(scriptName, scheduleRaw, scriptArgs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'success',
          message: `Updated schedule for ${scriptName} in crons/schedule.txt`,
          script: cronEngineState.scripts[scriptName]
        }));
        return;
      }

      if (action === 'save_schedule_file') {
        const content = typeof payload.content === 'string' ? payload.content : '';
        fs.writeFileSync(SCHEDULE_FILE, content, 'utf8');
        syncCronsFolderAndSchedule();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', message: 'crons/schedule.txt saved and auto-captured!' }));
        return;
      }

      if (action === 'save_script_file') {
        const rawName = path.basename((payload.scriptName || '').trim());
        const ext = path.extname(rawName).toLowerCase();
        if (!rawName || !ALLOWED_SCRIPT_EXTS.has(ext)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'Script filename must end with .bat, .awk, .cmd, .ps1, or .sh' }));
          return;
        }
        const targetPath = path.join(CRONS_DIR, rawName);
        fs.writeFileSync(targetPath, payload.content || '', 'utf8');
        if (payload.scheduleRaw) {
          updateScheduleFileForScript(rawName, payload.scheduleRaw.trim(), (payload.args || '').trim());
        } else {
          syncCronsFolderAndSchedule();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', message: `Script ${rawName} saved in crons/ folder!` }));
        return;
      }

      if (action === 'clear_history') {
        cronEngineState.history = [];
        try {
          if (fs.existsSync(RUN_HISTORY_LOG)) fs.writeFileSync(RUN_HISTORY_LOG, '', 'utf8');
          saveCronHistory();
        } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', message: 'Run history cleared.' }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: `Unknown action: ${action}` }));
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
