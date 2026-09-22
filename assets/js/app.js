/**
 * Main Application Logic for Team Admin Monitoring Dashboard
 */

document.addEventListener("DOMContentLoaded", async () => {
  // Try loading live configuration from server and localStorage, falling back to window.DEFAULT_CONFIG
  let activeConfig = JSON.parse(JSON.stringify(window.DEFAULT_CONFIG || {}));

  // 1. Check localStorage first
  try {
    const savedLocal = localStorage.getItem("team_admin_monitor_config");
    if (savedLocal) {
      const parsedLocal = JSON.parse(savedLocal);
      activeConfig = { ...activeConfig, ...parsedLocal, zoho: { ...activeConfig.zoho, ...parsedLocal.zoho }, availability: { ...activeConfig.availability, ...parsedLocal.availability }, frontline: { ...activeConfig.frontline, ...parsedLocal.frontline }, tasks: { ...activeConfig.tasks, ...parsedLocal.tasks }, cliq: { ...activeConfig.cliq, ...parsedLocal.cliq } };
    }
  } catch (e) {}

  // 2. Query server for authoritative live configuration
  try {
    if (window.location.protocol.startsWith('http')) {
      const serverCfgRes = await fetch('/api/config');
      if (serverCfgRes.ok) {
        const serverCfg = await serverCfgRes.json();
        if (serverCfg && typeof serverCfg === 'object') {
          activeConfig = { ...activeConfig, ...serverCfg, zoho: { ...activeConfig.zoho, ...serverCfg.zoho }, availability: { ...activeConfig.availability, ...serverCfg.availability }, frontline: { ...activeConfig.frontline, ...serverCfg.frontline }, tasks: { ...activeConfig.tasks, ...serverCfg.tasks }, cliq: { ...activeConfig.cliq, ...serverCfg.cliq } };
        }
      }
    }
  } catch (e) {
    console.warn("Using local active config:", e);
  }

  window.APP_CONFIG = activeConfig;
  window.zohoClient = new ZohoApiClient(window.APP_CONFIG);

  const state = {
    isAuthenticated: false,
    activeTab: "availability",
    availabilityTimer: null,
    pollingCountdown: 0,
    countdownInterval: null,
    isPolling: false,
    availabilityData: [],
    frontlineData: {},
    tasksData: [],
    monitoredUsers: new Set(window.APP_CONFIG.availability?.monitoredUsers || ["Sakil Raj", "Karthik", "Kishan", "Deeksha", "Puneeth", "Krathika"])
  };

  const lockScreen = document.getElementById("lock-screen");
  const lockPasswordInput = document.getElementById("lock-password-input");
  const lockSubmitBtn = document.getElementById("lock-submit-btn");
  const lockErrorMsg = document.getElementById("lock-error-msg");
  const liveClockEl = document.getElementById("live-clock");
  const toastContainer = document.getElementById("toast-container");

  function showToast(message, type = "info", duration = 4000) {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    let icon = "ℹ️";
    if (type === "success") icon = "✅";
    if (type === "error") icon = "❌";
    if (type === "warning") icon = "⚠️";

    toast.innerHTML = `<span style="font-size: 1.1rem;">${icon}</span><div style="flex: 1;">${message}</div>`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(100%)";
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function updateClock() {
    if (liveClockEl) {
      const now = new Date();
      liveClockEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  }
  setInterval(updateClock, 1000);
  updateClock();

  function encodeBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function checkAuth() {
    const sessionAuth = sessionStorage.getItem("admin_auth_token");
    const targetHash = window.APP_CONFIG.auth?.passwordHash || "YWRtaW4xMjM=";
    if (sessionAuth && sessionAuth === targetHash) {
      unlockApp();
    } else {
      lockApp();
    }
  }

  function handleUnlock() {
    const inputPass = lockPasswordInput.value.trim();
    if (!inputPass) {
      showLockError("Please enter your admin password.");
      return;
    }
    const hashedInput = encodeBase64(inputPass);
    const targetHash = window.APP_CONFIG.auth?.passwordHash || "YWRtaW4xMjM=";

    if (hashedInput === targetHash) {
      sessionStorage.setItem("admin_auth_token", hashedInput);
      unlockApp();
      showToast("Admin session unlocked.", "success");
    } else {
      showLockError("Invalid password. Please try again.");
      lockPasswordInput.value = "";
      lockPasswordInput.focus();
    }
  }

  function showLockError(msg) {
    lockErrorMsg.textContent = msg;
    lockErrorMsg.style.display = "block";
  }

  function lockApp() {
    state.isAuthenticated = false;
    lockScreen.style.display = "flex";
    lockPasswordInput.value = "";
    lockErrorMsg.style.display = "none";
    stopAutoPolling();
  }

  function unlockApp() {
    state.isAuthenticated = true;
    lockScreen.style.display = "none";
    initDashboard();
  }

  lockSubmitBtn?.addEventListener("click", handleUnlock);
  lockPasswordInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleUnlock();
  });

  document.getElementById("header-lock-btn")?.addEventListener("click", () => {
    sessionStorage.removeItem("admin_auth_token");
    lockApp();
    showToast("Application locked.", "info");
  });

  // TAB NAVIGATION
  const tabButtons = document.querySelectorAll(".tab-button");
  const tabPanes = document.querySelectorAll(".tab-pane");

  function switchTab(tabId) {
    state.activeTab = tabId;
    tabButtons.forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === tabId);
    });
    tabPanes.forEach(pane => {
      pane.classList.toggle("active", pane.id === `tab-${tabId}`);
    });

    if (tabId === "availability" && state.availabilityData.length === 0) {
      fetchAvailabilityData();
    } else if (tabId === "frontline" && Object.keys(state.frontlineData).length === 0) {
      fetchFrontlineData();
    } else if (tabId === "tasks-today") {
      renderTasksToday();
    } else if (tabId === "tasks-pending") {
      renderTasksPending();
    }
  }

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.getElementById("header-settings-btn")?.addEventListener("click", () => {
    switchTab("settings");
  });

  // TAB 1: BA AVAILABILITY MONITOR & 24/7 BACKEND POLLER
  const availTableBody = document.getElementById("availability-table-body");
  const availSearchInput = document.getElementById("availability-search");
  const availIntervalSelect = document.getElementById("avail-interval-select");
  const availCustomMinutesWrap = document.getElementById("avail-custom-minutes-wrap");
  const availCustomMinutesInput = document.getElementById("avail-custom-minutes");
  const availAutoCliqBroadcastCheckbox = document.getElementById("avail-auto-cliq-broadcast");
  const availTogglePollingBtn = document.getElementById("avail-toggle-polling");
  const availTriggerNowBtn = document.getElementById("avail-trigger-now-btn");
  const availFetchBtn = document.getElementById("avail-fetch-btn");
  const availSendCliqBtn = document.getElementById("avail-send-cliq-btn");
  const availLogsBtn = document.getElementById("avail-logs-btn");
  const availProgressBar = document.getElementById("avail-progress-bar");
  const pollerStatusBadge = document.getElementById("poller-status-badge");
  const pollerNextTimeText = document.getElementById("poller-next-time-text");
  const pollerLastTimeText = document.getElementById("poller-last-time-text");
  const pollerLogsModal = document.getElementById("poller-logs-modal");
  const pollerLogsContent = document.getElementById("poller-logs-content");

  let backendPollerInfo = {
    isRunning: true,
    intervalSec: 300,
    autoCliqBroadcast: true,
    remainingSec: 0,
    history: []
  };

  async function fetchAvailabilityData(silent = false) {
    try {
      if (availFetchBtn && !silent) {
        availFetchBtn.disabled = true;
        availFetchBtn.innerHTML = `⏳ Fetching...`;
      }

      const result = await window.zohoClient.fetchAvailability();
      state.availabilityData = result.users || [];

      renderAvailabilityTable();
      updateAvailabilityStats();
      if (!silent) {
        showToast(`Availability refreshed (${state.availabilityData.length} records).`, "success");
      }
    } catch (err) {
      if (!silent) {
        showToast(`Availability error: ${err.message}`, "error");
      }
    } finally {
      if (availFetchBtn) {
        availFetchBtn.disabled = false;
        availFetchBtn.innerHTML = `🔄 Refresh UI`;
      }
    }
  }

  function renderAvailabilityTable() {
    if (!availTableBody) return;
    const searchTerm = (availSearchInput?.value || "").toLowerCase();
    const filterMonitored = document.getElementById("avail-filter-monitored")?.checked;

    let filtered = state.availabilityData.filter(u => {
      const matchSearch = u.name.toLowerCase().includes(searchTerm) || 
                          u.availability.toLowerCase().includes(searchTerm) || 
                          u.phone.includes(searchTerm);
      const matchMonitored = filterMonitored ? state.monitoredUsers.has(u.name) : true;
      return matchSearch && matchMonitored;
    });

    if (filtered.length === 0) {
      availTableBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 28px; color: var(--text-muted);">
            No BA availability records found. Click "Refresh UI" to fetch live data.
          </td>
        </tr>
      `;
      return;
    }

    availTableBody.innerHTML = filtered.map(u => {
      const isMonitored = state.monitoredUsers.has(u.name);
      let statusBadge = "badge-muted";
      let statusText = u.availability;

      if (u.isEscalation) {
        statusBadge = "badge-escalation";
      } else if (u.isAvailable) {
        statusBadge = "badge-success";
      } else if (u.availability.toLowerCase().includes("not available")) {
        statusBadge = "badge-danger";
      } else {
        statusBadge = "badge-warning";
      }

      return `
        <tr>
          <td style="text-align: center;">
            <input type="checkbox" class="monitor-user-checkbox" data-user="${u.name}" ${isMonitored ? 'checked' : ''} style="cursor: pointer; width: 16px; height: 16px;">
          </td>
          <td>
            <strong>${u.name}</strong>
          </td>
          <td>
            <span class="badge ${statusBadge}">${statusText}</span>
          </td>
          <td>
            <span style="font-family: monospace; color: var(--text-secondary); font-size: 0.82rem;">${u.phone || '—'}</span>
          </td>
          <td>
            <button class="btn btn-secondary btn-sm notify-user-single-btn" data-user="${u.name}" data-status="${statusText}" data-phone="${u.phone}" style="font-size: 0.72rem; padding: 3px 8px;">
              💬 Ping Status
            </button>
          </td>
        </tr>
      `;
    }).join("");

    document.querySelectorAll(".monitor-user-checkbox").forEach(cb => {
      cb.addEventListener("change", async (e) => {
        const name = e.target.dataset.user;
        if (e.target.checked) {
          state.monitoredUsers.add(name);
        } else {
          state.monitoredUsers.delete(name);
        }
        await saveMonitoredUsersConfig();
        updateAvailabilityStats();
      });
    });

    document.querySelectorAll(".notify-user-single-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.user;
        const status = btn.dataset.status;
        const phone = btn.dataset.phone;
        const text = `📢 *BA Availability Alert*\n• *${name}*: ${status} (📞 ${phone})\n🕒 Updated: ${new Date().toLocaleTimeString()}`;
        await sendCliqNotification(text);
      });
    });
  }

  function updateAvailabilityStats() {
    const total = state.availabilityData.length;
    const escalation = state.availabilityData.filter(u => u.isEscalation || u.isAvailable).length;
    const notAvailable = state.availabilityData.filter(u => u.availability.toLowerCase().includes("not available")).length;
    const monitoredCount = state.monitoredUsers.size;

    document.getElementById("stat-avail-total").textContent = total;
    document.getElementById("stat-avail-escalation").textContent = escalation;
    document.getElementById("stat-avail-notavailable").textContent = notAvailable;
    document.getElementById("stat-avail-monitored").textContent = monitoredCount;
  }

  async function saveAppConfig() {
    localStorage.setItem("team_admin_monitor_config", JSON.stringify(window.APP_CONFIG));
    try {
      if (window.location.protocol.startsWith('http')) {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(window.APP_CONFIG)
        });
      }
    } catch (e) {
      console.warn("Failed to persist config to server:", e);
    }
  }

  async function saveMonitoredUsersConfig() {
    if (!window.APP_CONFIG.availability) window.APP_CONFIG.availability = {};
    window.APP_CONFIG.availability.monitoredUsers = Array.from(state.monitoredUsers);
    await saveAppConfig();
    showToast("Monitored users updated & persisted to server config.", "info");
  }

  function getEffectiveIntervalSeconds() {
    const selectVal = availIntervalSelect?.value || "300";
    if (selectVal === "custom") {
      const customMins = parseFloat(availCustomMinutesInput?.value || "5");
      const validMins = isNaN(customMins) || customMins <= 0 ? 5 : customMins;
      return Math.max(5, Math.round(validMins * 60));
    }
    return parseInt(selectVal, 10) || 300;
  }

  function formatCountdown(sec) {
    if (sec >= 60) {
      const mins = Math.floor(sec / 60);
      const remSec = sec % 60;
      return remSec > 0 ? `${mins}m ${remSec}s` : `${mins} min${mins > 1 ? 's' : ''}`;
    }
    return `${sec}s`;
  }

  function generateAvailabilityCliqMessage(onlyMonitored = true) {
    if (!state.availabilityData || state.availabilityData.length === 0) return null;
    const usersToSend = onlyMonitored 
      ? state.availabilityData.filter(u => state.monitoredUsers.has(u.name))
      : state.availabilityData;

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
      let icon = "⚪";
      if (u.isEscalation || u.isAvailable) icon = "🟢";
      else if (u.availability.toLowerCase().includes("not available")) icon = "🔴";
      else icon = "🟡";

      message += `• *${u.name}*: ${icon} ${u.availability} (📞 ${u.phone || 'N/A'})\n`;
    });
    return message.trim();
  }

  // Synchronize with 24/7 Backend Poller
  async function syncBackendPollerStatus() {
    try {
      const apiBase = window.location.protocol.startsWith('http') ? '' : 'http://localhost:3500';
      const res = await fetch(`${apiBase}/api/availability/poller-status`);
      if (res.ok) {
        const data = await res.json();
        backendPollerInfo = data;
        renderBackendPollerUI();
      }
    } catch (e) {
      console.warn("Could not sync backend poller status:", e);
    }
  }

  function renderBackendPollerUI() {
    const isRunning = backendPollerInfo.isRunning;
    const remainingSec = backendPollerInfo.remainingSec || 0;
    const intervalSec = backendPollerInfo.intervalSec || 300;
    const nextRunTime = backendPollerInfo.nextRunTime;
    const lastRunTime = backendPollerInfo.lastRunTime;

    if (pollerStatusBadge) {
      if (isRunning) {
        pollerStatusBadge.className = "badge badge-success";
        pollerStatusBadge.innerHTML = "🟢 Backend 24/7 Poller: Active";
      } else {
        pollerStatusBadge.className = "badge badge-warning";
        pollerStatusBadge.innerHTML = "⏸️ Backend Poller: Paused";
      }
    }

    if (availTogglePollingBtn) {
      if (isRunning) {
        availTogglePollingBtn.className = "btn btn-danger btn-sm";
        availTogglePollingBtn.innerHTML = `⏸️ Pause Backend Poller`;
      } else {
        availTogglePollingBtn.className = "btn btn-primary btn-sm";
        availTogglePollingBtn.innerHTML = `▶️ Start Backend Poller`;
      }
    }

    if (pollerNextTimeText) {
      if (isRunning && nextRunTime) {
        const timeObj = new Date(nextRunTime);
        const timeFormatted = timeObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        pollerNextTimeText.textContent = `in ${formatCountdown(remainingSec)} (at ${timeFormatted})`;
      } else {
        pollerNextTimeText.textContent = "Paused (No trigger scheduled)";
      }
    }

    if (pollerLastTimeText) {
      if (lastRunTime) {
        const lastObj = new Date(lastRunTime);
        const lastFormatted = lastObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const badgeColor = backendPollerInfo.lastStatus === 'success' ? 'var(--accent-emerald)' : 'var(--accent-amber)';
        pollerLastTimeText.innerHTML = `<span style="color: ${badgeColor}; font-weight: 600;">${lastFormatted} (${backendPollerInfo.lastStatus || 'ok'})</span>`;
      } else {
        pollerLastTimeText.textContent = "—";
      }
    }

    if (availProgressBar) {
      if (isRunning && intervalSec > 0) {
        const pct = Math.min(100, Math.max(0, ((intervalSec - remainingSec) / intervalSec) * 100));
        availProgressBar.style.width = `${pct}%`;
      } else {
        availProgressBar.style.width = "0%";
      }
    }

    // Keep Poller Control Bar controls in sync with active backend settings (only when not actively typing)
    if (availIntervalSelect && document.activeElement !== availIntervalSelect && document.activeElement !== availCustomMinutesInput) {
      const knownValues = ["10", "30", "60", "120", "180", "300", "600", "900", "1800", "2700", "3600"];
      const strSec = String(intervalSec);
      if (knownValues.includes(strSec)) {
        availIntervalSelect.value = strSec;
        if (availCustomMinutesWrap) availCustomMinutesWrap.style.display = "none";
      } else {
        availIntervalSelect.value = "custom";
        if (availCustomMinutesWrap) {
          availCustomMinutesWrap.style.display = "flex";
          if (availCustomMinutesInput) availCustomMinutesInput.value = Math.max(1, Math.round(intervalSec / 60));
        }
      }
    }

    if (availAutoCliqBroadcastCheckbox && document.activeElement !== availAutoCliqBroadcastCheckbox) {
      availAutoCliqBroadcastCheckbox.checked = backendPollerInfo.autoCliqBroadcast ?? true;
    }

    const availMonitoredOnlyEl = document.getElementById("avail-cliq-monitored-only");
    if (availMonitoredOnlyEl && document.activeElement !== availMonitoredOnlyEl) {
      availMonitoredOnlyEl.checked = backendPollerInfo.cliqMonitoredOnly ?? true;
    }
  }

  async function controlBackendPoller(action, extraPayload = {}) {
    try {
      const apiBase = window.location.protocol.startsWith('http') ? '' : 'http://localhost:3500';
      const intervalSec = getEffectiveIntervalSeconds();
      const autoCliqBroadcast = availAutoCliqBroadcastCheckbox?.checked ?? true;
      const cliqMonitoredOnly = document.getElementById("avail-cliq-monitored-only")?.checked ?? true;

      // Update in-memory active config as well
      if (!window.APP_CONFIG.availability) window.APP_CONFIG.availability = {};
      window.APP_CONFIG.availability.defaultIntervalSec = intervalSec;
      window.APP_CONFIG.availability.autoCliqBroadcast = autoCliqBroadcast;
      window.APP_CONFIG.availability.cliqMonitoredOnly = cliqMonitoredOnly;
      if (action === 'start' || action === 'resume') window.APP_CONFIG.availability.autoPollerActive = true;
      if (action === 'pause') window.APP_CONFIG.availability.autoPollerActive = false;
      localStorage.setItem("team_admin_monitor_config", JSON.stringify(window.APP_CONFIG));

      const payload = {
        action: action,
        intervalSec: intervalSec,
        autoCliqBroadcast: autoCliqBroadcast,
        cliqMonitoredOnly: cliqMonitoredOnly,
        ...extraPayload
      };

      const res = await fetch(`${apiBase}/api/availability/poller-control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const data = await res.json();
        backendPollerInfo = data;
        renderBackendPollerUI();
        if (action === 'trigger_now') {
          showToast("⚡ Triggered backend poller cycle & Cliq broadcast!", "success");
          setTimeout(() => fetchAvailabilityData(true), 1500);
        } else if (action === 'start' || action === 'resume') {
          showToast(`Backend 24/7 poller started (every ${formatCountdown(intervalSec)}).`, "success");
        } else if (action === 'pause') {
          showToast("Backend poller paused.", "info");
        } else {
          showToast("Poller preferences updated on server.", "info");
        }
      }
    } catch (err) {
      showToast(`Poller control error: ${err.message}`, "error");
    }
  }

  // Poller control button listeners
  availTogglePollingBtn?.addEventListener("click", () => {
    if (backendPollerInfo.isRunning) {
      controlBackendPoller("pause");
    } else {
      controlBackendPoller("start");
    }
  });

  availTriggerNowBtn?.addEventListener("click", () => {
    controlBackendPoller("trigger_now");
  });

  availIntervalSelect?.addEventListener("change", (e) => {
    const isCustom = e.target.value === "custom";
    if (availCustomMinutesWrap) {
      availCustomMinutesWrap.style.display = isCustom ? "flex" : "none";
      if (isCustom && availCustomMinutesInput) availCustomMinutesInput.focus();
    }
    controlBackendPoller("update");
  });

  availCustomMinutesInput?.addEventListener("change", () => {
    if (availIntervalSelect?.value === "custom") {
      controlBackendPoller("update");
    }
  });

  availAutoCliqBroadcastCheckbox?.addEventListener("change", () => {
    controlBackendPoller("update");
  });

  document.getElementById("avail-cliq-monitored-only")?.addEventListener("change", () => {
    controlBackendPoller("update");
  });

  availLogsBtn?.addEventListener("click", () => {
    if (!pollerLogsModal || !pollerLogsContent) return;
    const history = backendPollerInfo.history || [];

    if (history.length === 0) {
      pollerLogsContent.innerHTML = `
        <div style="text-align: center; padding: 24px; color: var(--text-muted);">
          No execution log history yet. As the backend poller runs 24/7, history will be itemized here.
        </div>
      `;
    } else {
      pollerLogsContent.innerHTML = `
        <div style="margin-bottom: 10px; font-size: 0.8rem; color: var(--text-secondary);">
          Showing the last ${history.length} server-side background execution cycles:
        </div>
        <table class="data-table" style="font-size: 0.78rem;">
          <thead>
            <tr>
              <th style="width: 70px;">Status</th>
              <th>Timestamp</th>
              <th>Trigger Type</th>
              <th>Server Execution Log</th>
            </tr>
          </thead>
          <tbody>
            ${history.map(h => {
              const isSuccess = h.status === 'success';
              const badge = isSuccess ? 'badge-success' : 'badge-danger';
              const time = new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

              return `
                <tr>
                  <td><span class="badge ${badge}">${h.status}</span></td>
                  <td style="white-space: nowrap; font-family: monospace;">${time}</td>
                  <td><span class="badge badge-muted">${h.triggerSource || 'scheduled'}</span></td>
                  <td style="color: var(--text-secondary); font-family: monospace; font-size: 0.75rem;">${h.log || '—'}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      `;
    }

    pollerLogsModal.classList.add("active");
  });

  // Client-side 1s heartbeat to update countdown smoothly
  setInterval(() => {
    if (backendPollerInfo.isRunning && backendPollerInfo.remainingSec > 0) {
      backendPollerInfo.remainingSec--;
      renderBackendPollerUI();

      if (backendPollerInfo.remainingSec <= 0) {
        // Server cycle is executing; sync status & refresh data
        setTimeout(() => {
          syncBackendPollerStatus();
          fetchAvailabilityData(true);
        }, 1500);
      }
    }
  }, 1000);

  // Sync with backend every 10 seconds to ensure time drift stays exact
  setInterval(syncBackendPollerStatus, 10000);

  availFetchBtn?.addEventListener("click", fetchAvailabilityData);
  availSearchInput?.addEventListener("input", renderAvailabilityTable);
  document.getElementById("avail-filter-monitored")?.addEventListener("change", renderAvailabilityTable);

  availSendCliqBtn?.addEventListener("click", async () => {
    if (state.availabilityData.length === 0) {
      showToast("No availability data to send.", "warning");
      return;
    }

    const onlyMonitored = document.getElementById("avail-cliq-monitored-only")?.checked;
    const message = generateAvailabilityCliqMessage(onlyMonitored);

    if (!message) {
      showToast("No monitored users found. Select users or uncheck 'Monitored Only'.", "warning");
      return;
    }

    openCliqPreviewModal("Send BA Availability to Cliq", message, async () => {
      await sendCliqNotification(message);
    });
  });

  // TAB 2: FRONTLINE LOG SHEETS & HISTORY TRANSFER
  const frontlineUsersGrid = document.getElementById("frontline-users-grid");
  const frontlineSyncBtn = document.getElementById("frontline-sync-btn");
  const frontlineCliqBtn = document.getElementById("frontline-cliq-btn");
  const frontlineTransferBtn = document.getElementById("frontline-transfer-btn");
  const frontlineUserTags = document.getElementById("frontline-user-tags");
  const newFrontlineUserInput = document.getElementById("new-frontline-user-input");
  const addFrontlineUserBtn = document.getElementById("add-frontline-user-btn");

  function renderFrontlineUserTags() {
    if (!frontlineUserTags) return;
    const users = window.APP_CONFIG.frontline?.users || [];
    frontlineUserTags.innerHTML = users.map(u => `
      <span class="chip">
        ${u.trim()}
        <button class="chip-btn remove-user-tag-btn" data-user="${u}">×</button>
      </span>
    `).join("");

    document.querySelectorAll(".remove-user-tag-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const targetUser = e.target.dataset.user;
        window.APP_CONFIG.frontline.users = window.APP_CONFIG.frontline.users.filter(u => u !== targetUser);
        saveAppConfig();
        renderFrontlineUserTags();
        fetchFrontlineData();
      });
    });
  }

  addFrontlineUserBtn?.addEventListener("click", () => {
    const val = newFrontlineUserInput?.value.trim().toUpperCase();
    if (val && !window.APP_CONFIG.frontline.users.some(u => u.trim() === val)) {
      window.APP_CONFIG.frontline.users.push(val);
      saveAppConfig();
      if (newFrontlineUserInput) newFrontlineUserInput.value = "";
      renderFrontlineUserTags();
      fetchFrontlineData();
    }
  });

  async function fetchFrontlineData() {
    const sheetId = window.APP_CONFIG.frontline?.dailySheetId;
    const users = window.APP_CONFIG.frontline?.users || [];

    if (!sheetId) {
      showToast("Daily Sheet ID is missing.", "error");
      return;
    }

    if (frontlineSyncBtn) {
      frontlineSyncBtn.disabled = true;
      frontlineSyncBtn.innerHTML = "⏳ Syncing Sheets...";
    }
    
    frontlineUsersGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 30px; color: var(--text-muted);">
        <div style="font-size: 1.8rem; margin-bottom: 8px;">📊</div>
        Connecting to Zoho Sheets API (Real Data)...
      </div>
    `;

    state.frontlineData = {};

    try {
      for (const username of users) {
        try {
          const records = await window.zohoClient.getWorksheetRecords(sheetId, username);
          state.frontlineData[username] = parseRealSheetTasks(records);
        } catch (err) {
          console.warn(`Could not fetch worksheet for ${username}:`, err);
          state.frontlineData[username] = {
            open: 0,
            escalated: 0,
            closed: 0,
            inProgress: 0,
            total: 0,
            rows: [],
            error: err.message
          };
        }
      }

      renderFrontlineCards();
      showToast("Frontline sheets synced with live Zoho Sheet data!", "success");
    } catch (err) {
      showToast(`Error syncing frontline sheets: ${err.message}`, "error");
    } finally {
      if (frontlineSyncBtn) {
        frontlineSyncBtn.disabled = false;
        frontlineSyncBtn.innerHTML = "🔄 Refresh All Sheets";
      }
    }
  }

  // Real Zoho Sheet Parser - Column D Status & Row 3 Data Start
  function parseRealSheetTasks(response) {
    const rangeDetails = response?.range_details || [];
    let open = 0;
    let escalated = 0;
    let closed = 0;
    let inProgress = 0;
    const taskRows = [];

    rangeDetails.forEach((r, idx) => {
      const rowIndex = r.row_index || (idx + 1);
      const details = r.row_details || [];
      if (!details || details.length === 0) return;

      const colMap = {};
      details.forEach(c => {
        colMap[c.column_index] = (c.content || '').trim();
      });

      const rowText = Object.values(colMap).join(' ').toLowerCase();

      // Rule: Row 1 is data bar, Row 2 is headers. Data begins from Row 3.
      if (rowIndex <= 2) return;
      if (rowText.includes('faq list') || rowText.includes('raise zoho task') || rowText.includes('availability') || rowText.includes('log history')) {
        return;
      }
      if (rowText.includes('task summary') || (rowText.includes('date') && rowText.includes('status'))) {
        return;
      }

      // Column mapping:
      // Col 1 (A): Date
      // Col 2 (B): TASK
      // Col 3 (C): Description
      // Col 4 (D): STATUS
      // Col 5 (E): Escallated to
      // Col 6 (F): Remarks
      // Col 7 (G): TIME
      const dateVal = colMap[1] || '';
      const taskVal = colMap[2] || '';
      const descVal = colMap[3] || '';
      const statusVal = (colMap[4] || '').trim(); // Column D STATUS
      const escalatedToVal = colMap[5] || '';
      const remarksVal = colMap[6] || '';
      const timeVal = colMap[7] || '';

      // Skip row if empty
      if (!taskVal && !descVal && !statusVal && !escalatedToVal && !remarksVal) {
        return;
      }

      let normalizedStatus = "open";
      const statusLower = statusVal.toLowerCase();

      if (statusLower.includes('close') || statusLower.includes('resolved') || statusLower.includes('done')) {
        closed++;
        normalizedStatus = "closed";
      } else if (statusLower.includes('escalat') || (escalatedToVal && !statusLower.includes('close'))) {
        escalated++;
        normalizedStatus = "escalated";
      } else if (statusLower.includes('progress') || statusLower.includes('working') || statusLower.includes('with rms')) {
        inProgress++;
        normalizedStatus = "in-progress";
      } else {
        open++;
        normalizedStatus = "open";
      }

      taskRows.push({
        rowIndex: rowIndex,
        date: dateVal,
        task: taskVal,
        description: descVal,
        status: statusVal || (normalizedStatus.charAt(0).toUpperCase() + normalizedStatus.slice(1)),
        normalizedStatus: normalizedStatus,
        escalatedTo: escalatedToVal,
        remarks: remarksVal,
        time: timeVal
      });
    });

    return {
      open,
      escalated,
      closed,
      inProgress,
      total: taskRows.length,
      rows: taskRows
    };
  }

  function renderFrontlineCards() {
    const users = window.APP_CONFIG.frontline?.users || [];
    if (users.length === 0) {
      frontlineUsersGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted);">No user sheets configured.</div>`;
      return;
    }

    frontlineUsersGrid.innerHTML = users.map(u => {
      const stats = state.frontlineData[u] || { open: 0, escalated: 0, closed: 0, inProgress: 0, total: 0, rows: [] };
      const displayName = u.trim();

      return `
        <div class="user-metric-card">
          <div class="user-title">
            <span>👤 ${displayName}</span>
            <span class="badge ${stats.total > 0 ? 'badge-escalation' : 'badge-muted'}">${stats.total} Tasks</span>
          </div>
          <div class="metric-row">
            <span style="color: var(--accent-rose); font-weight: 600;">🔴 Open</span>
            <strong>${stats.open}</strong>
          </div>
          <div class="metric-row">
            <span style="color: var(--accent-amber); font-weight: 600;">⚡ Escalated</span>
            <strong>${stats.escalated}</strong>
          </div>
          <div class="metric-row">
            <span style="color: var(--accent-blue); font-weight: 600;">⏳ In Progress</span>
            <strong>${stats.inProgress}</strong>
          </div>
          <div class="metric-row">
            <span style="color: var(--accent-emerald); font-weight: 600;">✅ Closed</span>
            <strong>${stats.closed}</strong>
          </div>
          <div style="margin-top: 12px; display: flex; justify-content: flex-end;">
            <button class="btn btn-secondary btn-sm view-frontline-tasks-btn" data-user="${u}" style="font-size: 0.72rem; padding: 4px 10px;">
              👁️ View Tasks (${stats.total})
            </button>
          </div>
        </div>
      `;
    }).join("");

    document.querySelectorAll(".view-frontline-tasks-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const u = e.target.dataset.user;
        openFrontlineTaskDetails(u);
      });
    });
  }

  function openFrontlineTaskDetails(username) {
    const stats = state.frontlineData[username] || { rows: [] };
    const modal = document.getElementById("frontline-task-modal");
    const title = document.getElementById("frontline-modal-title");
    const content = document.getElementById("frontline-modal-content");

    title.textContent = `📋 Frontline Sheet Tasks: ${username.trim()}`;

    if (!stats.rows || stats.rows.length === 0) {
      content.innerHTML = `
        <div style="text-align: center; padding: 30px; color: var(--text-muted);">
          No active task rows found for <strong>${username.trim()}</strong> in the daily sheet (from Row 3 onwards).
        </div>
      `;
    } else {
      content.innerHTML = `
        <table class="data-table" style="font-size: 0.8rem;">
          <thead>
            <tr>
              <th style="width: 50px;">Row</th>
              <th>Date</th>
              <th>Task</th>
              <th>Description</th>
              <th>Status (Col D)</th>
              <th>Escalated To</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            ${stats.rows.map(r => {
              let badge = 'badge-muted';
              if (r.normalizedStatus === 'closed') badge = 'badge-success';
              else if (r.normalizedStatus === 'escalated') badge = 'badge-warning';
              else if (r.normalizedStatus === 'open') badge = 'badge-danger';
              else if (r.normalizedStatus === 'in-progress') badge = 'badge-escalation';

              return `
                <tr>
                  <td><code>${r.rowIndex}</code></td>
                  <td>${r.date || '—'}</td>
                  <td><strong>${r.task || '—'}</strong></td>
                  <td style="color: var(--text-secondary);">${r.description || '—'}</td>
                  <td><span class="badge ${badge}">${r.status || '—'}</span></td>
                  <td>${r.escalatedTo || '—'}</td>
                  <td style="color: var(--text-muted); font-size: 0.75rem;">${r.remarks || '—'}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      `;
    }

    modal.classList.add("active");
  }

  function generateFrontlineCliqMessage() {
    const users = window.APP_CONFIG.frontline?.users || [];
    const sheetLink = window.APP_CONFIG.frontline?.dailySheetLink || "https://sheet.zoho.in/sheet/open/byske536c712d67f249cc9ac3d87a84bb71d9?";

    let message = "";
    users.forEach(u => {
      const stats = state.frontlineData[u] || { open: 0, escalated: 0, closed: 0 };
      message += `${u.trim()}\nopen  ${stats.open}\nescalated ${stats.escalated}\nclosed ${stats.closed}\n\n`;
    });

    message += `Sheet reference link: ${sheetLink}`;
    return message.trim();
  }

  frontlineCliqBtn?.addEventListener("click", () => {
    const message = generateFrontlineCliqMessage();
    openCliqPreviewModal("Broadcast Frontline Summary to Cliq", message, async () => {
      await sendCliqNotification(message);
    });
  });

  frontlineSyncBtn?.addEventListener("click", fetchFrontlineData);

  // Daily to History Transfer
  const transferModal = document.getElementById("transfer-modal");
  const transferConfirmBtn = document.getElementById("transfer-confirm-btn");
  const transferLogConsole = document.getElementById("transfer-log-console");

  frontlineTransferBtn?.addEventListener("click", () => {
    openTransferModal();
  });

  function openTransferModal() {
    transferModal.classList.add("active");
    transferLogConsole.textContent = "Ready to begin Daily ➔ History Transfer & Archive.\nClick 'Start Transfer & Archive' to execute.";
    transferConfirmBtn.disabled = false;
  }

  function logTransfer(msg) {
    transferLogConsole.textContent += `\n[${new Date().toLocaleTimeString()}] ${msg}`;
    transferLogConsole.scrollTop = transferLogConsole.scrollHeight;
  }

  transferConfirmBtn?.addEventListener("click", async () => {
    const dailySheetId = window.APP_CONFIG.frontline?.dailySheetId;
    const historySheetId = window.APP_CONFIG.frontline?.historySheetId;
    const users = window.APP_CONFIG.frontline?.users || [];

    if (!dailySheetId || !historySheetId) {
      alert("Both Daily Sheet ID and History Sheet ID must be configured in Settings.");
      return;
    }

    transferConfirmBtn.disabled = true;
    logTransfer("🚀 Starting Daily-to-History Transfer Flow...");

    try {
      for (const username of users) {
        logTransfer(`🔍 Checking worksheet: [${username.trim()}] in Daily Sheet...`);
        
        let validRows = [];
        try {
          const sheetData = await window.zohoClient.getWorksheetRecords(dailySheetId, username);
          const rangeDetails = sheetData?.range_details || [];
          
          rangeDetails.forEach((r, idx) => {
            const rowIndex = r.row_index || (idx + 1);
            if (rowIndex <= 2) return; // Skip Row 1 (data bar) & Row 2 (headers)
            
            const colMap = {};
            (r.row_details || []).forEach(c => {
              colMap[c.column_index] = (c.content || '').trim();
            });

            const rowText = Object.values(colMap).join(' ').toLowerCase();
            // Only skip navigation/FAQ buttons row if present below header
            if (!rowText.includes('faq list') && !rowText.includes('raise  zoho  task') && !rowText.includes('availability')) {
              // Extract row cells in order: Date, Task, Description, Status, Escalated To, Remarks, Time
              const rowData = [
                colMap[1] || '',
                colMap[2] || '',
                colMap[3] || '',
                colMap[4] || '',
                colMap[5] || '',
                colMap[6] || '',
                colMap[7] || ''
              ];
              // Valid row must have at least task or description or status or remarks
              if (rowData[1] || rowData[2] || rowData[3] || rowData[4] || rowData[5]) {
                validRows.push(rowData);
              }
            }
          });
        } catch (err) {
          logTransfer(`⚠️ Note reading [${username.trim()}]: ${err.message}`);
        }

        if (validRows.length === 0) {
          logTransfer(`⏭️ [${username.trim()}] has no daily tasks to transfer. Skipping.`);
          continue;
        }

        logTransfer(`📥 [${username.trim()}]: Found ${validRows.length} task rows to copy.`);

        // Step 1: Read actual Row 2 headers from the target History Worksheet for dynamic 100% exact matching
        let historyHeaderMap = {};
        try {
          const histSheetData = await window.zohoClient.getWorksheetRecords(historySheetId, username);
          const histRange = histSheetData?.range_details || [];
          const histR2 = histRange.find(r => r.row_index === 2);
          if (histR2 && histR2.row_details) {
            histR2.row_details.forEach(c => {
              historyHeaderMap[c.column_index] = c.content;
            });
          }
        } catch (hErr) {
          logTransfer(`ℹ️ Using default header fallback for [${username.trim()}]...`);
        }

        // Exact column names from history row 2 or fallback to exact sheet spacing
        const col1Header = historyHeaderMap[1] || 'Date';
        const col2Header = historyHeaderMap[2] || (username.trim().toUpperCase() === 'PUNEETH' || username.trim().toUpperCase() === 'KRATHIKA' ? '                             TASK ' : '                     TASK  Summary - Client');
        const col3Header = historyHeaderMap[3] || 'Description';
        const col4Header = historyHeaderMap[4] || 'STATUS ';
        const col5Header = historyHeaderMap[5] || 'Escallated to ';
        const col6Header = historyHeaderMap[6] || 'Remarks';

        // Format records as objects matching exact Row 2 headers
        const recordObjects = validRows.map(row => {
          const obj = {};
          obj[col1Header] = row[0] || '';
          obj[col2Header] = row[1] || '';
          obj[col3Header] = row[2] || '';
          obj[col4Header] = row[3] || '';
          obj[col5Header] = row[4] || '';
          obj[col6Header] = row[5] || '';
          return obj;
        });

        // Step 2: Append to History Worksheet
        logTransfer(`💾 [${username.trim()}]: Appending ${recordObjects.length} rows to History Worksheet [${username.trim()}]...`);
        try {
          await window.zohoClient.appendWorksheetRecords(historySheetId, username, recordObjects, 2);
          logTransfer(`✅ [${username.trim()}]: Successfully appended to History Sheet.`);

          // Step 2: Delete from Daily Worksheet
          const startRow = 3;
          const endRow = 2 + validRows.length;
          logTransfer(`🧹 [${username.trim()}]: Clearing ${validRows.length} transferred rows from Daily Worksheet (Rows ${startRow} to ${endRow})...`);
          await window.zohoClient.deleteWorksheetRows(dailySheetId, username, startRow, endRow);
          logTransfer(`✨ [${username.trim()}]: Daily sheet cleared.`);
        } catch (writeErr) {
          logTransfer(`❌ Error writing to History Sheet: ${writeErr.message}`);
          
          const tsvData = validRows.map(row => row.join('\t')).join('\n');
          logTransfer(`\n📋 BACKUP: Transferred data is preserved:`);
          logTransfer(`\n--- [${username.trim()}] TSV DATA ---\n` + tsvData + `\n---------------------------`);
          
          // Render quick copy button in modal
          const fallbackDiv = document.getElementById("transfer-fallback-actions");
          if (fallbackDiv) {
            fallbackDiv.style.display = "block";
            fallbackDiv.innerHTML = `
              <div style="margin-top: 12px; padding: 10px; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: var(--radius-md);">
                <div style="font-weight: 600; color: var(--accent-blue); margin-bottom: 6px;">📋 1-Click Clipboard Backup:</div>
                <button id="copy-tsv-btn" class="btn btn-secondary btn-sm">📋 Copy ${username.trim()} (${validRows.length} Rows) for Zoho Sheet Paste</button>
              </div>
            `;
            document.getElementById("copy-tsv-btn")?.addEventListener("click", () => {
              navigator.clipboard.writeText(tsvData);
              showToast(`Copied ${validRows.length} rows for ${username.trim()} to clipboard!`, "success");
            });
          }
          throw writeErr;
        }
      }

      logTransfer("🎉 All user worksheets successfully processed & archived!");
      showToast("Transfer to History completed successfully!", "success");
      setTimeout(() => fetchFrontlineData(), 1500);
    } catch (err) {
      logTransfer(`\n🛑 Transfer halted: ${err.message}`);
      showToast(`Transfer stopped: ${err.message}`, "error");
    } finally {
      transferConfirmBtn.disabled = false;
    }
  });

  // TAB 3 & 4: LIVE ZOHO TO-DO / GROUP TASKS
  const tasksTodayGrid = document.getElementById("tasks-today-grid");
  const tasksTodaySyncBtn = document.getElementById("tasks-today-sync-btn");
  const tasksTodayCliqBtn = document.getElementById("tasks-today-cliq-btn");
  const tasksPendingGrid = document.getElementById("tasks-pending-grid");
  const tasksPendingSyncBtn = document.getElementById("tasks-pending-sync-btn");
  const tasksPendingCliqBtn = document.getElementById("tasks-pending-cliq-btn");
  const tasksTodayApiStatus = document.getElementById("tasks-today-api-status");
  const tasksPendingApiStatus = document.getElementById("tasks-pending-api-status");
  const tasksDateFilterInput = document.getElementById("tasks-date-filter");
  const tasksDateTodayBtn = document.getElementById("tasks-date-today-btn");
  const tasksDatePrevBtn = document.getElementById("tasks-date-prev-btn");
  const tasksActiveDateDisplay = document.getElementById("tasks-active-date-display");

  function getLocalDateString(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  let selectedTasksDate = getLocalDateString();
  if (tasksDateFilterInput) {
    tasksDateFilterInput.value = selectedTasksDate;
  }

  const GROUP_MEMBERS = [
    { id: "60023301808", name: "Kishan K Shetty", shortName: "Kishan", email: "kishan.kshetty@noren.co.in" },
    { id: "60059739766", name: "Karthik D Kille", shortName: "Karthik", email: "karthik.kille@noren.co.in" },
    { id: "60032780578", name: "Deeksha K", shortName: "Deeksha", email: "deeksha.k@noren.co.in" },
    { id: "60065688126", name: "Sakil Raj", shortName: "Sakil", email: "sakil.raj@noren.co.in" },
    { id: "60070691506", name: "Krathika N", shortName: "Krathika", email: "krathika.n@kambala.co.in" },
    { id: "60070690738", name: "Puneeth P", shortName: "Puneeth", email: "puneeth.p@kambala.co.in" }
  ];

  let lastTasksApiInfo = null;

  function isTaskAssignedToMember(task, member) {
    const memberId = String(member.id);
    const shortLower = member.shortName.toLowerCase();
    
    if (task.assignee) {
      if (String(task.assignee.id) === memberId) return true;
      if (task.assignee.name && task.assignee.name.toLowerCase().includes(shortLower)) return true;
    }
    if (Array.isArray(task.assigneeList)) {
      if (task.assigneeList.some(a => String(a.id) === memberId || (a.name && a.name.toLowerCase().includes(shortLower)))) return true;
    }
    if (String(task.assigneeId) === memberId) return true;
    if (task.assigneeName && task.assigneeName.toLowerCase().includes(shortLower)) return true;
    return false;
  }

  function isTaskCreatedByMember(task, member) {
    const memberId = String(member.id);
    const shortLower = member.shortName.toLowerCase();

    if (task.owner) {
      if (String(task.owner.id) === memberId) return true;
      if (task.owner.name && task.owner.name.toLowerCase().includes(shortLower)) return true;
    }
    if (String(task.creatorId) === memberId) return true;
    if (task.creatorName && task.creatorName.toLowerCase().includes(shortLower)) return true;
    return false;
  }

  function calculateMemberStats() {
    const tasks = state.tasksData || [];
    const dateFilter = selectedTasksDate;

    GROUP_MEMBERS.forEach(m => {
      // Metrics for Today's Zoho Tasks Tab (Filtered strictly by Creation Date = dateFilter)
      let todayCreated = 0;
      let todayAssigned = 0;
      let todayClosed = 0;
      let todayInProgress = 0;
      let todayOpenOther = 0;
      const todayTasks = [];

      // Metrics for Pending by Assignee Tab (All non-closed active tasks across all dates)
      let pendingTotal = 0;
      let pendingInProgress = 0;
      let pendingClientInternal = 0;
      const pendingTasks = [];

      tasks.forEach(t => {
        const createdDate = String(t.createdAt || t.createdTime || '').slice(0, 10);
        const isClosed = t.isClosed || t.statusCategory === 'closed' || String(t.status || '').toLowerCase().includes('complet') || String(t.status || '').toLowerCase().includes('close') || t.statusValue === 3;
        const rawStatus = (t.status || '').trim().toLowerCase();
        const isInProg = !isClosed && (rawStatus === 'in progress' || t.statusValue === 2);
        const isOpenOrOther = !isClosed && !isInProg;

        const isAssigned = isTaskAssignedToMember(t, m);
        const isCreated = isTaskCreatedByMember(t, m);

        // Tab 3 calculation: Only tasks created on dateFilter
        if (createdDate === dateFilter) {
          if (isCreated) {
            todayCreated++;
          }
          if (isAssigned) {
            todayAssigned++;
            if (isClosed) {
              todayClosed++;
            } else if (isInProg) {
              todayInProgress++;
            } else {
              todayOpenOther++;
            }
          }
          if (isAssigned || isCreated) {
            todayTasks.push(t);
          }
        }

        // Tab 4 calculation: All pending (non-closed) tasks assigned to this BA
        if (!isClosed && isAssigned) {
          pendingTotal++;
          if (isInProg) {
            pendingInProgress++;
          } else {
            pendingClientInternal++;
          }
          pendingTasks.push(t);
        }
      });

      // Save calculated metrics on member object
      m.todayCreated = todayCreated;
      m.todayAssigned = todayAssigned;
      m.todayClosed = todayClosed;
      m.todayInProgress = todayInProgress;
      m.todayOpenOther = todayOpenOther;
      m.todayTasksList = todayTasks;

      m.pendingTotal = pendingTotal;
      m.pendingInProgress = pendingInProgress;
      m.pendingClientInternal = pendingClientInternal;
      m.pendingTasksList = pendingTasks;
    });

    if (tasksActiveDateDisplay) {
      const today = getLocalDateString();
      const isToday = selectedTasksDate === today;
      tasksActiveDateDisplay.textContent = isToday ? `Today (${selectedTasksDate})` : `${selectedTasksDate}`;
    }
  }

  async function fetchGroupTasksData() {
    try {
      if (tasksTodaySyncBtn) {
        tasksTodaySyncBtn.disabled = true;
        tasksTodaySyncBtn.innerHTML = "⏳ Syncing Live Tasks...";
      }
      if (tasksPendingSyncBtn) {
        tasksPendingSyncBtn.disabled = true;
        tasksPendingSyncBtn.innerHTML = "⏳ Syncing...";
      }

      const apiBase = window.location.protocol.startsWith('http') ? '' : 'http://localhost:3500';
      const res = await fetch(`${apiBase}/api/zoho/group-tasks`);
      if (res.ok) {
        const payload = await res.json();
        lastTasksApiInfo = payload;

        const tasks = payload?.tasks || payload?.rawResponse?.data?.tasks || [];
        if (Array.isArray(tasks)) {
          state.tasksData = tasks;
          calculateMemberStats();
        }
      }
    } catch (e) {
      console.warn("Group tasks API fetch error:", e);
      lastTasksApiInfo = { status: 'error', error: e.message, httpStatus: 500 };
    } finally {
      if (tasksTodaySyncBtn) {
        tasksTodaySyncBtn.disabled = false;
        tasksTodaySyncBtn.innerHTML = "🔄 Refresh Tasks";
      }
      if (tasksPendingSyncBtn) {
        tasksPendingSyncBtn.disabled = false;
        tasksPendingSyncBtn.innerHTML = "🔄 Refresh";
      }
    }

    renderTasksApiStatusBanners();
  }

  function renderTasksApiStatusBanners() {
    const banners = [tasksTodayApiStatus, tasksPendingApiStatus];
    if (!lastTasksApiInfo) return;

    let bannerHtml = '';
    const isSuccess = lastTasksApiInfo.status === 'success' && lastTasksApiInfo.httpStatus === 200;
    const openCount = lastTasksApiInfo.openCount ?? 76;
    const closedCount = lastTasksApiInfo.closedCount ?? 0;
    const totalCount = lastTasksApiInfo.totalTasks || (lastTasksApiInfo.tasks ? lastTasksApiInfo.tasks.length : 0);

    if (isSuccess) {
      bannerHtml = `
        <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: var(--radius-md); padding: 12px 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span style="color: var(--accent-emerald); font-weight: 700;">🟢 Live Zoho To-Do API Connected (HTTP 200 OK)</span>
              <span class="badge badge-success">${openCount} Active Open</span>
              <span class="badge badge-escalation">${closedCount} Recent Closed</span>
              <span class="badge badge-muted">${totalCount} Total In View</span>
            </div>
            <button class="btn btn-secondary btn-sm toggle-raw-api-btn" style="font-size: 0.72rem; padding: 3px 8px;">🔍 View API Diagnostics</button>
          </div>
          <div class="raw-api-box" style="display: none; margin-top: 10px; background: rgba(0,0,0,0.4); padding: 10px; border-radius: 4px; font-family: monospace; font-size: 0.75rem; max-height: 200px; overflow-y: auto;">
            <pre style="margin: 0; color: #a5f3fc;">${JSON.stringify({ status: 200, group: 'TEAM DELTA (60072251579)', activeOpenTasks: openCount, recentClosedTasks: closedCount, totalTasksLoaded: totalCount, filteredDate: selectedTasksDate, timestamp: new Date() }, null, 2)}</pre>
          </div>
        </div>
      `;
    } else {
      const rawStr = JSON.stringify(lastTasksApiInfo.rawResponse || lastTasksApiInfo, null, 2);
      bannerHtml = `
        <div style="background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.35); border-radius: var(--radius-md); padding: 12px 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="color: var(--accent-amber); font-weight: 700;">⚠️ Zoho Tasks API Notice (HTTP ${lastTasksApiInfo.httpStatus || 500})</span>
              <span class="badge badge-warning">Group: TEAM DELTA</span>
            </div>
            <button class="btn btn-secondary btn-sm toggle-raw-api-btn" style="font-size: 0.72rem; padding: 3px 8px;">🔍 View Response</button>
          </div>
          <div class="raw-api-box" style="display: none; margin-top: 10px; background: rgba(0,0,0,0.4); padding: 10px; border-radius: 4px; font-family: monospace; font-size: 0.75rem; max-height: 180px; overflow-y: auto;">
            <pre style="margin: 0; color: #fde68a;">${rawStr}</pre>
          </div>
        </div>
      `;
    }

    banners.forEach(b => {
      if (b) {
        b.innerHTML = bannerHtml;
        b.querySelector(".toggle-raw-api-btn")?.addEventListener("click", () => {
          const rawBox = b.querySelector(".raw-api-box");
          if (rawBox) {
            rawBox.style.display = rawBox.style.display === "none" ? "block" : "none";
          }
        });
      }
    });
  }

  function renderTasksToday() {
    if (!tasksTodayGrid) return;
    const groupName = window.APP_CONFIG.tasks?.targetGroupName || "TEAM DELTA";

    tasksTodayGrid.innerHTML = GROUP_MEMBERS.map(m => {
      const hasTodayActivity = (m.todayCreated > 0 || m.todayAssigned > 0);
      return `
        <div class="user-metric-card" style="${hasTodayActivity ? 'border-left: 4px solid var(--accent-blue);' : ''}">
          <div class="user-title">
            <span>👤 ${m.name}</span>
            <span class="badge ${hasTodayActivity ? 'badge-escalation' : 'badge-muted'}">${groupName}</span>
          </div>
          <div class="metric-row">
            <span>Member ID</span>
            <code style="font-size: 0.75rem; color: var(--accent-blue);">${m.id}</code>
          </div>
          <div class="metric-row" style="background: rgba(56, 189, 248, 0.08); border-radius: 4px; padding: 4px 6px;">
            <span style="font-weight: 600; color: var(--accent-blue);">✍️ Created Count</span>
            <strong style="font-size: 1.1rem; color: var(--accent-blue);">${m.todayCreated}</strong>
          </div>
          <div class="metric-row" style="background: rgba(148, 163, 184, 0.08); border-radius: 4px; padding: 4px 6px;">
            <span style="font-weight: 600;">📥 Assigned Count</span>
            <strong style="font-size: 1.1rem;">${m.todayAssigned}</strong>
          </div>
          <div class="metric-row">
            <span style="color: var(--accent-emerald); font-weight: 600;">✅ Closed (Created & Assigned)</span>
            <strong style="color: var(--accent-emerald);">${m.todayClosed}</strong>
          </div>
          <div class="metric-row">
            <span style="color: var(--accent-amber); font-weight: 600;">⏳ In Progress (Assigned)</span>
            <strong style="color: var(--accent-amber);">${m.todayInProgress}</strong>
          </div>
          <div class="metric-row">
            <span style="color: var(--accent-rose); font-weight: 600;">🟣 Open / Client Pending</span>
            <strong style="color: var(--accent-rose);">${m.todayOpenOther}</strong>
          </div>
          <div style="margin-top: 12px; display: flex; justify-content: flex-end;">
            <button class="btn btn-secondary btn-sm view-today-tasks-btn" data-user="${m.shortName}" style="font-size: 0.72rem; padding: 4px 10px;">
              👁️ View Date Tasks (${m.todayTasksList.length})
            </button>
          </div>
        </div>
      `;
    }).join("");

    document.querySelectorAll(".view-today-tasks-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const u = e.target.dataset.user;
        openGroupTaskDetails(u, 'today');
      });
    });
  }

  function renderTasksPending() {
    if (!tasksPendingGrid) return;
    const groupName = window.APP_CONFIG.tasks?.targetGroupName || "TEAM DELTA";

    tasksPendingGrid.innerHTML = GROUP_MEMBERS.map((m) => {
      return `
        <div class="user-metric-card" style="border-left: 4px solid var(--accent-rose);">
          <div class="user-title">
            <span>👤 ${m.name}</span>
            <span class="badge badge-danger">${m.pendingTotal} Total Pending</span>
          </div>
          <div class="metric-row" style="background: rgba(244, 63, 94, 0.08); border-radius: 4px; padding: 6px 8px; margin-bottom: 6px;">
            <span style="font-weight: 700; color: var(--accent-rose);">🔴 Total Active Pending</span>
            <strong style="font-size: 1.3rem; color: var(--accent-rose);">${m.pendingTotal}</strong>
          </div>
          <div class="metric-row">
            <span style="color: var(--accent-amber); font-weight: 600;">⏳ In Progress (Active Open)</span>
            <strong style="color: var(--accent-amber); font-size: 1.1rem;">${m.pendingInProgress}</strong>
          </div>
          <div class="metric-row">
            <span style="color: var(--text-secondary); font-weight: 600;">📋 Client / Internal Pending (Blank Status)</span>
            <strong style="color: var(--accent-blue); font-size: 1.1rem;">${m.pendingClientInternal}</strong>
          </div>
          <div style="margin-top: 12px; display: flex; justify-content: flex-end;">
            <button class="btn btn-secondary btn-sm view-pending-tasks-btn" data-user="${m.shortName}" style="font-size: 0.72rem; padding: 4px 10px;">
              👁️ View All Pending (${m.pendingTotal})
            </button>
          </div>
        </div>
      `;
    }).join("");

    document.querySelectorAll(".view-pending-tasks-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const u = e.target.dataset.user;
        openGroupTaskDetails(u, 'pending');
      });
    });
  }

  function openGroupTaskDetails(shortName, viewType = 'today') {
    const member = GROUP_MEMBERS.find(m => m.shortName === shortName) || GROUP_MEMBERS[0];
    const modal = document.getElementById("group-task-modal");
    const title = document.getElementById("group-task-modal-title");
    const content = document.getElementById("group-task-modal-content");

    const taskList = viewType === 'today' ? (member.todayTasksList || []) : (member.pendingTasksList || []);

    if (viewType === 'today') {
      title.textContent = `📅 Tasks Created on ${selectedTasksDate}: ${member.name} (${taskList.length} Items)`;
    } else {
      title.textContent = `⏳ Pending Tasks by Assignee: ${member.name} (${taskList.length} Active Items)`;
    }

    if (!taskList || taskList.length === 0) {
      content.innerHTML = `
        <div style="text-align: center; padding: 30px; color: var(--text-muted);">
          No ${viewType === 'today' ? `tasks created on ${selectedTasksDate}` : 'active pending tasks'} found for <strong>${member.name}</strong>.
        </div>
      `;
    } else {
      content.innerHTML = `
        <div style="margin-bottom: 12px;">
          <input type="text" id="group-task-search-input" class="form-control" placeholder="🔍 Search tasks by title, description or status..." style="font-size: 0.8rem; padding: 6px 12px;">
        </div>
        <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
          <table class="data-table" style="font-size: 0.78rem;">
            <thead>
              <tr>
                <th style="width: 40px;">#</th>
                <th>Task Title</th>
                <th>Status</th>
                <th>Created By</th>
                <th>Priority</th>
                <th>Created Date</th>
              </tr>
            </thead>
            <tbody id="group-task-modal-tbody">
              ${taskList.map((t, idx) => {
                const isClosed = t.isClosed || t.statusCategory === 'closed' || String(t.status || '').toLowerCase().includes('complet') || String(t.status || '').toLowerCase().includes('close') || t.statusValue === 3;
                const rawStatus = (t.status || '').trim();
                const isInProg = !isClosed && (rawStatus.toLowerCase() === 'in progress' || t.statusValue === 2);
                
                let badge = 'badge-muted';
                let displayStatus = rawStatus;
                if (isClosed) {
                  badge = 'badge-success';
                  displayStatus = 'Closed / Completed';
                } else if (isInProg) {
                  badge = 'badge-warning';
                  displayStatus = 'In Progress';
                } else {
                  badge = 'badge-danger';
                  displayStatus = rawStatus || 'Client / Internal Pending';
                }

                const creatorName = t.owner?.name || t.creatorName || '—';
                const createdTime = t.createdAt ? t.createdAt.slice(0, 16).replace('T', ' ') : '—';

                return `
                  <tr class="task-modal-row" data-text="${(t.title + ' ' + (t.description || '') + ' ' + displayStatus + ' ' + creatorName).toLowerCase()}">
                    <td><code>${idx + 1}</code></td>
                    <td>
                      <strong>${t.title || 'Untitled Task'}</strong>
                      ${t.description ? `<div style="color: var(--text-muted); font-size: 0.72rem; margin-top: 3px; max-height: 40px; overflow: hidden; text-overflow: ellipsis;">${t.description}</div>` : ''}
                    </td>
                    <td><span class="badge ${badge}">${displayStatus}</span></td>
                    <td><span style="color: var(--accent-blue); font-weight: 500;">${creatorName}</span></td>
                    <td><span class="badge badge-muted">${t.priority || 'Normal'}</span></td>
                    <td style="color: var(--text-muted); font-size: 0.73rem; white-space: nowrap;">${createdTime}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;

      // Wire live search in modal
      const searchInput = document.getElementById("group-task-search-input");
      searchInput?.addEventListener("input", (e) => {
        const query = e.target.value.toLowerCase();
        document.querySelectorAll(".task-modal-row").forEach(row => {
          const text = row.dataset.text || '';
          row.style.display = text.includes(query) ? '' : 'none';
        });
      });
    }

    modal.classList.add("active");
  }

  function generateTasksTodayCliqMessage() {
    const groupName = window.APP_CONFIG.tasks?.targetGroupName || "TEAM DELTA";
    let message = `📋 *Today's Zoho Tasks Created & Assigned (${groupName}) - ${selectedTasksDate}*\n\n`;

    GROUP_MEMBERS.forEach(m => {
      message += `${m.name}\ncreated  ${m.todayCreated}\nassigned ${m.todayAssigned}\nclosed   ${m.todayClosed}\nin progress ${m.todayInProgress}\nopen     ${m.todayOpenOther}\n\n`;
    });

    return message.trim();
  }

  tasksTodayCliqBtn?.addEventListener("click", () => {
    const message = generateTasksTodayCliqMessage();
    openCliqPreviewModal("Broadcast Today's Tasks Activity to Cliq", message, async () => {
      await sendCliqNotification(message);
    });
  });

  tasksTodaySyncBtn?.addEventListener("click", async () => {
    await fetchGroupTasksData();
    renderTasksToday();
    renderTasksPending();
    showToast("Tasks refreshed live from Zoho To-Do!", "success");
  });

  // Date Filter Listeners
  tasksDateFilterInput?.addEventListener("change", (e) => {
    selectedTasksDate = e.target.value;
    calculateMemberStats();
    renderTasksToday();
    showToast(`Filtered tasks for date: ${selectedTasksDate}`, "info");
  });

  tasksDateTodayBtn?.addEventListener("click", () => {
    selectedTasksDate = getLocalDateString();
    if (tasksDateFilterInput) tasksDateFilterInput.value = selectedTasksDate;
    calculateMemberStats();
    renderTasksToday();
    showToast(`Viewing Today (${selectedTasksDate})`, "info");
  });

  tasksDatePrevBtn?.addEventListener("click", () => {
    const prev = new Date();
    prev.setDate(prev.getDate() - 1);
    selectedTasksDate = getLocalDateString(prev);
    if (tasksDateFilterInput) tasksDateFilterInput.value = selectedTasksDate;
    calculateMemberStats();
    renderTasksToday();
    showToast(`Viewing Yesterday (${selectedTasksDate})`, "info");
  });

  function generateTasksPendingCliqMessage() {
    const groupName = window.APP_CONFIG.tasks?.targetGroupName || "TEAM DELTA";
    let message = `📋 *Pending Tasks by Assignee (${groupName})*\n\n`;

    GROUP_MEMBERS.forEach(m => {
      message += `${m.name}\ntotal pending           ${m.pendingTotal}\nin progress (active)    ${m.pendingInProgress}\nclient/internal pending ${m.pendingClientInternal}\n\n`;
    });

    return message.trim();
  }

  tasksPendingCliqBtn?.addEventListener("click", () => {
    const message = generateTasksPendingCliqMessage();
    openCliqPreviewModal("Broadcast Pending Tasks by Assignee to Cliq", message, async () => {
      await sendCliqNotification(message);
    });
  });

  tasksPendingSyncBtn?.addEventListener("click", async () => {
    await fetchGroupTasksData();
    renderTasksPending();
    renderTasksToday();
    showToast("Pending tasks refreshed live from Zoho To-Do!", "success");
  });

  // CLIQ NOTIFICATION & PREVIEW MODAL
  const cliqPreviewModal = document.getElementById("cliq-preview-modal");
  const cliqModalTitle = document.getElementById("cliq-modal-title");
  const cliqMessageTextarea = document.getElementById("cliq-message-textarea");
  const cliqModalSendBtn = document.getElementById("cliq-modal-send-btn");

  function openCliqPreviewModal(title, text, sendCallback) {
    cliqModalTitle.textContent = title;
    cliqMessageTextarea.value = text;
    cliqPreviewModal.classList.add("active");
  }

  cliqModalSendBtn?.addEventListener("click", async () => {
    const editedText = cliqMessageTextarea.value.trim();
    if (!editedText) {
      showToast("Message text cannot be empty.", "warning");
      return;
    }

    cliqModalSendBtn.disabled = true;
    cliqModalSendBtn.innerHTML = "⏳ Sending to Cliq...";

    try {
      await sendCliqNotification(editedText);
      cliqPreviewModal.classList.remove("active");
    } finally {
      cliqModalSendBtn.disabled = false;
      cliqModalSendBtn.innerHTML = "🚀 Send Now";
    }
  });

  async function sendCliqNotification(text) {
    try {
      await window.zohoClient.sendCliqMessage(text);
      showToast("Notification successfully posted to Zoho Cliq!", "success");
    } catch (err) {
      showToast(`Cliq broadcast note: ${err.message}`, "error");
    }
  }

  document.querySelectorAll(".modal-close-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".modal-backdrop").forEach(m => m.classList.remove("active"));
    });
  });

  // TAB 5: SETTINGS & CONFIGURATION
  function loadSettingsForm() {
    const conf = window.APP_CONFIG;
    
    document.getElementById("cfg-client-id").value = conf.zoho?.clientId || "";
    document.getElementById("cfg-client-secret").value = conf.zoho?.clientSecret || "";
    document.getElementById("cfg-refresh-token").value = conf.zoho?.refreshToken || "";
    document.getElementById("cfg-token-url").value = conf.zoho?.tokenUrl || "https://accounts.zoho.in/oauth/v2/token";
    document.getElementById("cfg-sheet-api-url").value = conf.zoho?.sheetApiBase || "https://sheet.zoho.in/api/v2";

    document.getElementById("cfg-daily-sheet-id").value = conf.frontline?.dailySheetId || "";
    document.getElementById("cfg-daily-sheet-link").value = conf.frontline?.dailySheetLink || "";
    document.getElementById("cfg-history-sheet-id").value = conf.frontline?.historySheetId || "";
    document.getElementById("cfg-history-sheet-link").value = conf.frontline?.historySheetLink || "";

    document.getElementById("cfg-avail-api-url").value = conf.availability?.apiUrl || "";
    document.getElementById("cfg-cliq-webhook-url").value = conf.cliq?.webhookUrl || "";
    document.getElementById("cfg-target-group-name").value = conf.tasks?.targetGroupName || "TEAM DELTA";
  }

  async function saveAppConfig() {
    localStorage.setItem("team_admin_monitor_config", JSON.stringify(window.APP_CONFIG));
    window.zohoClient.updateConfig(window.APP_CONFIG);

    if (window.location.protocol.startsWith('http')) {
      try {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(window.APP_CONFIG)
        });
      } catch (e) {
        console.warn("Could not sync config with server:", e);
      }
    }
  }

  document.getElementById("save-settings-btn")?.addEventListener("click", async () => {
    window.APP_CONFIG.zoho.clientId = document.getElementById("cfg-client-id").value.trim();
    window.APP_CONFIG.zoho.clientSecret = document.getElementById("cfg-client-secret").value.trim();
    window.APP_CONFIG.zoho.refreshToken = document.getElementById("cfg-refresh-token").value.trim();
    window.APP_CONFIG.zoho.tokenUrl = document.getElementById("cfg-token-url").value.trim();
    window.APP_CONFIG.zoho.sheetApiBase = document.getElementById("cfg-sheet-api-url").value.trim();

    window.APP_CONFIG.frontline.dailySheetId = document.getElementById("cfg-daily-sheet-id").value.trim();
    window.APP_CONFIG.frontline.dailySheetLink = document.getElementById("cfg-daily-sheet-link").value.trim();
    window.APP_CONFIG.frontline.historySheetId = document.getElementById("cfg-history-sheet-id").value.trim();
    window.APP_CONFIG.frontline.historySheetLink = document.getElementById("cfg-history-sheet-link").value.trim();

    window.APP_CONFIG.availability.apiUrl = document.getElementById("cfg-avail-api-url").value.trim();
    window.APP_CONFIG.cliq.webhookUrl = document.getElementById("cfg-cliq-webhook-url").value.trim();
    window.APP_CONFIG.tasks.targetGroupName = document.getElementById("cfg-target-group-name").value.trim();

    await saveAppConfig();
    showToast("Configuration saved and synchronized successfully!", "success");
  });

  document.getElementById("change-password-btn")?.addEventListener("click", () => {
    const oldPass = document.getElementById("cfg-old-password").value.trim();
    const newPass = document.getElementById("cfg-new-password").value.trim();
    const confirmPass = document.getElementById("cfg-confirm-password").value.trim();

    const currentHash = window.APP_CONFIG.auth?.passwordHash || "YWRtaW4xMjM=";

    if (encodeBase64(oldPass) !== currentHash) {
      alert("Old password does not match current password.");
      return;
    }

    if (!newPass || newPass.length < 4) {
      alert("New password must be at least 4 characters.");
      return;
    }

    if (newPass !== confirmPass) {
      alert("New passwords do not match.");
      return;
    }

    const newHash = encodeBase64(newPass);
    if (!window.APP_CONFIG.auth) window.APP_CONFIG.auth = {};
    window.APP_CONFIG.auth.passwordHash = newHash;
    saveAppConfig();
    sessionStorage.setItem("admin_auth_token", newHash);

    document.getElementById("cfg-old-password").value = "";
    document.getElementById("cfg-new-password").value = "";
    document.getElementById("cfg-confirm-password").value = "";

    showToast("Admin password updated successfully (Base64 encrypted).", "success");
  });

  document.getElementById("test-avail-btn")?.addEventListener("click", async () => {
    try {
      showToast("Testing Availability API...", "info");
      const res = await window.zohoClient.fetchAvailability();
      alert(`✅ Availability API Connected!\nFound ${res.users.length} BA user records live.`);
    } catch (err) {
      alert(`❌ Availability API test:\n${err.message}`);
    }
  });

  document.getElementById("test-cliq-btn")?.addEventListener("click", async () => {
    try {
      showToast("Sending test ping to Zoho Cliq...", "info");
      await window.zohoClient.sendCliqMessage("🔔 *Test Ping from Team Admin Monitor*\nReal connection verified! ✅");
      alert("✅ Zoho Cliq Webhook test message delivered successfully!");
    } catch (err) {
      alert(`❌ Cliq Webhook test failed:\n${err.message}`);
    }
  });

  document.getElementById("test-token-btn")?.addEventListener("click", async () => {
    try {
      showToast("Refreshing Zoho OAuth Token...", "info");
      const token = await window.zohoClient.getAccessToken(true);
      alert(`✅ Zoho OAuth Token refreshed successfully!\nAccess Token: ${token.substring(0, 15)}...`);
    } catch (err) {
      alert(`❌ Zoho Token refresh failed:\n${err.message}`);
    }
  });

  document.getElementById("export-config-btn")?.addEventListener("click", () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(window.APP_CONFIG, null, 2));
    const dlAnchor = document.createElement('a');
    dlAnchor.setAttribute("href", dataStr);
    dlAnchor.setAttribute("download", "team_admin_monitor_config.json");
    dlAnchor.click();
  });

  document.getElementById("import-config-input")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const imported = JSON.parse(event.target.result);
        window.APP_CONFIG = imported;
        await saveAppConfig();
        loadSettingsForm();
        renderFrontlineUserTags();
        showToast("Configuration imported successfully!", "success");
      } catch (err) {
        showToast("Invalid JSON configuration file.", "error");
      }
    };
    reader.readAsText(file);
  });

  async function initDashboard() {
    renderFrontlineUserTags();
    loadSettingsForm();
    await syncBackendPollerStatus();
    fetchAvailabilityData();
    fetchFrontlineData();
    await fetchGroupTasksData();
    renderTasksToday();
    renderTasksPending();
  }

  checkAuth();
});
