"use strict";

const state = {
  user: null,
  keys: [],
  users: [],
  activeTab: "keys",
  explorer: {
    slug: "",
    name: "",
    paymentSystem: "",
    tree: null,
    expandedYears: new Set(),
    expandedMonths: new Set()
  },
  reportViewer: {
    slug: "",
    path: "",
    report: null
  },
  monthlyViewer: {
    slug: "",
    name: "",
    months: [],
    available: false,
    manualMode: false,
    pdfFiles: [],
    selectedPdfs: new Set()
  },
  endpointInfo: {
    slug: ""
  },
  settings: {
    reportDigestEnabled: false,
    reportDigestTime: "07:00",
    reportDigestRecipients: "",
    reportDigestLastSentAt: ""
  }
};

const authView = document.getElementById("auth-view");
const appView = document.getElementById("app-view");
const userPill = document.getElementById("user-pill");
const userLabel = document.getElementById("user-label");
const authStatus = document.getElementById("auth-status");
const appStatus = document.getElementById("app-status");
const keyListEl = document.getElementById("key-list");
const userListEl = document.getElementById("user-list");
const settingsView = document.getElementById("settings-view");
const tabSettings = document.getElementById("tab-settings");
const settingsStatus = document.getElementById("settings-status");
const settingDigestEnabledInput = document.getElementById("setting-digest-enabled");
const settingDigestTimeInput = document.getElementById("setting-digest-time");
const settingRecipientEmailsInput = document.getElementById("setting-recipient-emails");
const testDigestButton = document.getElementById("test-digest-button");
const keyCreatePanel = document.getElementById("key-create-panel");
const keyNameInput = document.getElementById("key-name");
const keyPaymentSystemInput = document.getElementById("key-payment-system");
const newRoleSelect = document.getElementById("new-role");
const scopeField = document.getElementById("scope-field");
const endpointScopeList = document.getElementById("endpoint-scope-list");
const keysView = document.getElementById("keys-view");
const usersView = document.getElementById("users-view");
const tabKeys = document.getElementById("tab-keys");
const tabUsers = document.getElementById("tab-users");
const explorerModal = document.getElementById("explorer-modal");
const explorerTitle = document.getElementById("explorer-title");
const explorerSubtitle = document.getElementById("explorer-subtitle");
const explorerStatus = document.getElementById("explorer-status");
const explorerList = document.getElementById("explorer-list");
const explorerCrumbs = document.getElementById("explorer-crumbs");
const explorerUpButton = document.getElementById("explorer-up");
const explorerCloseButton = document.getElementById("explorer-close");
const reportModal = document.getElementById("report-modal");
const reportTitle = document.getElementById("report-title");
const reportSubtitle = document.getElementById("report-subtitle");
const reportStatus = document.getElementById("report-status");
const reportBody = document.getElementById("report-body");
const reportCloseButton = document.getElementById("report-close");
const reportDownloadJsonButton = document.getElementById("report-download-json");
const reportDownloadCsvButton = document.getElementById("report-download-csv");
const reportEmailCsvButton = document.getElementById("report-email-csv");
const monthlyModal = document.getElementById("monthly-modal");
const monthlyTitle = document.getElementById("monthly-title");
const monthlySubtitle = document.getElementById("monthly-subtitle");
const monthlyStatus = document.getElementById("monthly-status");
const monthlyList = document.getElementById("monthly-list");
const monthlyCloseButton = document.getElementById("monthly-close");
const endpointInfoModal = document.getElementById("endpoint-info-modal");
const endpointInfoTitle = document.getElementById("endpoint-info-title");
const endpointInfoSubtitle = document.getElementById("endpoint-info-subtitle");
const endpointInfoStatus = document.getElementById("endpoint-info-status");
const endpointInfoBody = document.getElementById("endpoint-info-body");
const endpointInfoCloseButton = document.getElementById("endpoint-info-close");

document.getElementById("save-settings-button").addEventListener("click", saveSettings);
testDigestButton.addEventListener("click", sendTestDigest);


document.getElementById("login-button").addEventListener("click", login);
document.getElementById("logout-button").addEventListener("click", logout);
document.getElementById("refresh-button").addEventListener("click", refreshAll);
document.getElementById("create-key-button").addEventListener("click", createKey);
document.getElementById("create-user-button").addEventListener("click", createUser);
newRoleSelect.addEventListener("change", syncScopeVisibility);
tabKeys.addEventListener("click", () => switchTab("keys"));
tabUsers.addEventListener("click", () => switchTab("users"));
tabSettings.addEventListener("click", () => switchTab("settings"));
explorerCloseButton.addEventListener("click", closeExplorer);
if (explorerUpButton) {
  explorerUpButton.style.display = "none";
}
reportCloseButton.addEventListener("click", closeReportViewer);
reportDownloadJsonButton.addEventListener("click", downloadParsedReportJson);
reportDownloadCsvButton.addEventListener("click", downloadParsedReportCsv);
reportEmailCsvButton.addEventListener("click", emailParsedReportCsv);
monthlyCloseButton.addEventListener("click", closeMonthlyViewer);
endpointInfoCloseButton.addEventListener("click", closeEndpointInfo);
explorerModal.addEventListener("click", (event) => {
  if (event.target === explorerModal) {
    closeExplorer();
  }
});
reportModal.addEventListener("click", (event) => {
  if (event.target === reportModal) {
    closeReportViewer();
  }
});
monthlyModal.addEventListener("click", (event) => {
  if (event.target === monthlyModal) {
    closeMonthlyViewer();
  }
});
endpointInfoModal.addEventListener("click", (event) => {
  if (event.target === endpointInfoModal) {
    closeEndpointInfo();
  }
});
window.addEventListener("load", bootstrap);

async function bootstrap() {
  try {
    const response = await fetch("/api/session/me");
    if (!response.ok) {
      showLoggedOut();
      return;
    }
    const payload = await response.json();
    state.user = payload.user;
    showLoggedIn();
    await refreshAll();
  } catch {
    showLoggedOut();
  }
}

async function login() {
  setAuthStatus("Signing in...");
  try {
    const response = await fetch("/api/session/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("login-username").value.trim(),
        password: document.getElementById("login-password").value
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Sign-in failed.");
    }
    state.user = payload.user;
    document.getElementById("login-password").value = "";
    showLoggedIn();
    setAuthStatus("");
    await refreshAll();
  } catch (error) {
    setAuthStatus(error.message, true);
  }
}

async function logout() {
  await fetch("/api/session/logout", { method: "POST" });
  state.user = null;
  state.keys = [];
  state.users = [];
  showLoggedOut();
}

function showLoggedOut() {
  authView.classList.remove("hidden");
  appView.classList.add("hidden");
  userPill.style.display = "none";
  closeExplorer();
  closeReportViewer();
  closeMonthlyViewer();
  closeEndpointInfo();
  setAppStatus("");
}

function showLoggedIn() {
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  userPill.style.display = "inline-flex";
  userLabel.textContent = state.user.username + " - " + friendlyRole(state.user.role);
  keyCreatePanel.classList.toggle("hidden", !state.user.permissions.manageKeys);
  tabUsers.classList.toggle("hidden", !state.user.permissions.manageUsers);
  tabSettings.classList.toggle("hidden", !state.user.permissions.manageUsers);
  if (!state.user.permissions.manageUsers && state.activeTab === "users") {
    switchTab("keys");
  } else {
    renderTabState();
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  renderTabState();
}

function renderTabState() {
  const showKeys = state.activeTab === "keys";
  const showUsers = state.activeTab === "users" && state.user.permissions.manageUsers;
  const showSettings = state.activeTab === "settings" && state.user.permissions.manageUsers;

  keysView.classList.toggle("hidden", !showKeys);
  usersView.classList.toggle("hidden", !showUsers);
  settingsView.classList.toggle("hidden", !showSettings);

  tabKeys.classList.toggle("active", showKeys);
  tabUsers.classList.toggle("active", showUsers);
  tabSettings.classList.toggle("active", showSettings);
}


async function refreshAll() {
  if (!state.user) {
    return;
  }

  setAppStatus("Refreshing data...");
  try {
    const keysResponse = await fetch("/api/admin/keys");
    const keyPayload = await keysResponse.json();
    if (!keysResponse.ok) {
      throw new Error(keyPayload.error || "Could not load endpoints.");
    }
    state.keys = Array.isArray(keyPayload) ? keyPayload : keyPayload.value || [];
    renderKeys();
    renderScopeChecklist();

    if (state.user.permissions.manageUsers) {
      const usersResponse = await fetch("/api/admin/users");
      const userPayload = await usersResponse.json();
      if (!usersResponse.ok) {
        throw new Error(userPayload.error || "Could not load users.");
      }
      state.users = userPayload;
      renderUsers();

      const settingsResponse = await fetch("/api/admin/settings");
      const settingsPayload = await settingsResponse.json();
      if (!settingsResponse.ok) {
        throw new Error(settingsPayload.error || "Could not load settings.");
      }
      state.settings = {
        reportDigestEnabled: Boolean(settingsPayload.reportDigestEnabled),
        reportDigestTime: String(settingsPayload.reportDigestTime || "07:00"),
        reportDigestRecipients: String(settingsPayload.reportDigestRecipients || ""),
        reportDigestLastSentAt: String(settingsPayload.reportDigestLastSentAt || "")
      };
      renderSettings();
    } else {
      state.users = [];
      userListEl.innerHTML = "";
    }

    setAppStatus("Data loaded.");
  } catch (error) {
    setAppStatus(error.message, true);
  }
}

async function createKey() {
  try {
    setAppStatus("Creating endpoint key...");
    const response = await fetch("/api/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: keyNameInput.value.trim(),
        paymentSystem: keyPaymentSystemInput.value
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not create key.");
    }
    keyNameInput.value = "";
    window.alert(
      "Copy this API key now. It will not be shown again.\n\n" +
      "Endpoint: " + payload.slug + "\n" +
      "API key: " + payload.apiKey
    );
    setAppStatus("Endpoint key created.");
    await refreshAll();
  } catch (error) {
    setAppStatus(error.message, true);
  }
}

async function rotateKey(slug) {
  try {
    setAppStatus("Rotating endpoint key...");
    const response = await fetch("/api/admin/keys/" + slug + "/rotate", {
      method: "POST"
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not rotate key.");
    }
    window.alert(
      "Copy this new API key now. The previous key is no longer valid.\n\n" +
      "Endpoint: " + payload.slug + "\n" +
      "API key: " + payload.apiKey
    );
    setAppStatus("Endpoint key rotated.");
    await refreshAll();
  } catch (error) {
    setAppStatus(error.message, true);
  }
}

async function createUser() {
  try {
    setAppStatus("Creating user...");
    const role = document.getElementById("new-role").value;
    const endpointScopes = role === "viewer" ? selectedScopes() : [];
    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("new-username").value.trim(),
        password: document.getElementById("new-password").value,
        role,
        endpointScopes
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not create user.");
    }
    document.getElementById("new-username").value = "";
    document.getElementById("new-password").value = "";
    renderScopeChecklist();
    setAppStatus("User created.");
    await refreshAll();
  } catch (error) {
    setAppStatus(error.message, true);
  }
}

async function mutate(url, options, successMessage) {
  try {
    setAppStatus("Updating...");
    const response = await fetch(url, options);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Request failed.");
    }
    setAppStatus(successMessage);
    await refreshAll();
  } catch (error) {
    setAppStatus(error.message, true);
  }
}

function renderKeys() {
  if (!state.keys.length) {
    keyListEl.innerHTML = '<div class="card"><div class="empty">No endpoint keys exist yet.</div></div>';
    closeEndpointInfo();
    return;
  }

  keyListEl.innerHTML = state.keys.map((key) => {
    const badge = key.revoked
      ? '<span class="badge revoked">Revoked</span>'
      : '<span class="badge">Active</span>';
    const actions = state.user.permissions.manageKeys
      ? ((key.revoked
          ? '<button class="secondary" data-action="restore" data-slug="' + escapeHtml(key.slug) + '">Restore</button>'
          : '<button class="warn" data-action="revoke" data-slug="' + escapeHtml(key.slug) + '">Revoke</button>') +
        '<button class="secondary" data-action="rotate" data-slug="' + escapeHtml(key.slug) + '">Rotate</button>' +
        '<button class="danger" data-action="delete-key" data-slug="' + escapeHtml(key.slug) + '">Delete</button>')
      : "";

    return "<article class=\"card\">" +
      "<div class=\"card-head\">" +
      "<div class=\"endpoint-summary\"><h2>" + escapeHtml(key.name) + "</h2>" + badge + "</div>" +
      "<div class=\"toolbar-row endpoint-actions\">" + actions +
      "<button class=\"secondary\" data-info-slug=\"" + escapeHtml(key.slug) + "\">Info</button>" +
      "</div>" +
      "</article>";
  }).join("");

  bindKeyManagementActions(keyListEl);
  keyListEl.querySelectorAll("button[data-info-slug]").forEach((button) => {
    button.addEventListener("click", () => {
      openEndpointInfo(button.dataset.infoSlug);
    });
  });

  if (state.endpointInfo.slug) {
    const activeKey = findKeyBySlug(state.endpointInfo.slug);
    if (activeKey) {
      renderEndpointInfo(activeKey);
    } else {
      closeEndpointInfo();
    }
  }
}

function bindKeyManagementActions(container) {
  container.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const slug = button.dataset.slug;
      const action = button.dataset.action;
      if (action === "revoke") {
        await mutate("/api/admin/keys/" + slug + "/revoke", { method: "POST" }, "Endpoint revoked.");
      } else if (action === "restore") {
        await mutate("/api/admin/keys/" + slug + "/restore", { method: "POST" }, "Endpoint restored.");
      } else if (action === "rotate") {
        const confirmed = window.confirm("Rotate the API key for \"" + slug + "\"? The current key will stop working immediately.");
        if (confirmed) {
          await rotateKey(slug);
        }
      } else if (action === "delete-key") {
        const confirmed = window.confirm("Delete key \"" + slug + "\"? Stored files stay on disk.");
        if (confirmed) {
          await mutate("/api/admin/keys/" + slug, { method: "DELETE" }, "Key deleted. Stored files were kept.");
        }
      }
    });
  });
}

function openEndpointInfo(slug) {
  const key = findKeyBySlug(slug);
  if (!key) {
    setAppStatus("That endpoint could not be found.", true);
    return;
  }

  state.endpointInfo.slug = slug;
  endpointInfoModal.classList.add("open");
  endpointInfoModal.setAttribute("aria-hidden", "false");
  renderEndpointInfo(key);
}

function renderEndpointInfo(key) {
  const paymentSystemLabel = friendlyPaymentSystem(key.paymentSystem);
  const isGilbarco = isGilbarcoPaymentSystem(key.paymentSystem);
  const explorerSummary = key.rootEntryCount
    ? escapeHtml(String(key.rootEntryCount)) + " top-level item(s) stored at this endpoint"
    : "No synced items at the endpoint root yet.";
  const lastUsedLine = key.lastUsedAt
    ? "<div>Last used: " + escapeHtml(key.lastUsedAt) + "</div>"
    : "<div>Last used: <code>Never</code></div>";
  const rotatedLine = key.rotatedAt
    ? "<div>Last rotated: " + escapeHtml(key.rotatedAt) + " (" + escapeHtml(String(key.rotationCount)) + " rotation(s))</div>"
    : "<div>Last rotated: <code>Never</code></div>";

  const currentMonthBlurb = isGilbarco
    ? "Combine every Gilbarco StoreClose PDF uploaded so far this month into a single report."
    : "Combine every Verifone daily report (DR-*.html) uploaded so far this month into a single report.";

  endpointInfoTitle.textContent = key.name + " Info";
  endpointInfoSubtitle.textContent = "Endpoint details, storage tools, and report options.";
  endpointInfoBody.innerHTML =
    "<section class=\"report-section endpoint-info-grid\">" +
    "<div class=\"endpoint-info-meta\">" +
    "<div>Endpoint API: <code>/api/upload/" + escapeHtml(key.slug) + "</code></div>" +
    "<div>Created: " + escapeHtml(key.createdAt) + "</div>" +
    lastUsedLine +
    rotatedLine +
    "<div>Payment system: <code>" + escapeHtml(paymentSystemLabel) + "</code></div>" +
    "<div>Storage folder: <code>storage/" + escapeHtml(key.slug) + "</code></div>" +
    "</div>" +
    "</section>" +
    "<section class=\"files\">" +
    (state.user.permissions.manageKeys
      ? "<div class=\"file-row\"><div><strong>Payment System</strong><br><small>Choose how this endpoint's monthly reports are handled.</small></div><div><select data-payment-system-slug=\"" + escapeHtml(key.slug) + "\">" +
        "<option value=\"gilbarco_passport\"" + (isGilbarco ? " selected" : "") + ">Gilbarco Passport</option>" +
        "<option value=\"verifone_commander\"" + (!isGilbarco ? " selected" : "") + ">Verifone Commander</option>" +
        "</select></div></div>"
      : "") +
    (state.user.permissions.manageKeys && !isGilbarco
      ? "<div class=\"file-row\"><div><strong>Agent Credentials</strong><br><small>Saved in the web API so Synchro Companion can fetch the current Verifone Commander username and password for this endpoint.</small></div><div class=\"endpoint-agent-controls\">" +
        "<input type=\"text\" placeholder=\"Commander username\" data-verifone-username=\"" + escapeHtml(key.slug) + "\" value=\"" + escapeHtml(key.verifoneUsername || "") + "\">" +
        "<input type=\"password\" placeholder=\"Commander password\" data-verifone-password=\"" + escapeHtml(key.slug) + "\" value=\"" + escapeHtml(key.verifonePassword || "") + "\">" +
        "<button class=\"secondary\" data-agent-config-save=\"" + escapeHtml(key.slug) + "\">Save Credentials</button>" +
        "</div></div>"
      : "") +
    "<div class=\"file-row\"><div><strong>Report Explorer</strong><br><small>" + explorerSummary + " Browse reports grouped by year and month.</small></div><div><button class=\"explorer-link\" data-explorer-slug=\"" + escapeHtml(key.slug) + "\" data-explorer-name=\"" + escapeHtml(key.name) + "\" data-explorer-payment=\"" + escapeHtml(key.paymentSystem) + "\">Open Report Explorer</button></div></div>" +
    "<div class=\"file-row\"><div><strong>Current Month Report</strong><br><small>" + escapeHtml(currentMonthBlurb) + "</small></div><div><button class=\"explorer-link\" data-current-month-slug=\"" + escapeHtml(key.slug) + "\" data-current-month-name=\"" + escapeHtml(key.name) + "\" data-current-month-payment=\"" + escapeHtml(key.paymentSystem) + "\">Generate Current Month Report</button></div></div>" +
    "</section>";

  bindEndpointInfoActions();
  setEndpointInfoStatus("");
}

function bindEndpointInfoActions() {
  endpointInfoBody.querySelectorAll("select[data-payment-system-slug]").forEach((select) => {
    select.addEventListener("change", async () => {
      await updatePaymentSystem(select.dataset.paymentSystemSlug, select.value);
    });
  });

  endpointInfoBody.querySelectorAll("button[data-agent-config-save]").forEach((button) => {
    button.addEventListener("click", async () => {
      const slug = button.dataset.agentConfigSave;
      const usernameInput = endpointInfoBody.querySelector('input[data-verifone-username="' + cssEscape(slug) + '"]');
      const passwordInput = endpointInfoBody.querySelector('input[data-verifone-password="' + cssEscape(slug) + '"]');
      await updateAgentConfig(
        slug,
        usernameInput ? usernameInput.value : "",
        passwordInput ? passwordInput.value : ""
      );
    });
  });

  endpointInfoBody.querySelectorAll("button[data-explorer-slug]").forEach((button) => {
    button.addEventListener("click", () => {
      closeEndpointInfo();
      loadReportTree(
        button.dataset.explorerSlug,
        button.dataset.explorerName || button.dataset.explorerSlug,
        button.dataset.explorerPayment || ""
      );
    });
  });

  endpointInfoBody.querySelectorAll("button[data-current-month-slug]").forEach((button) => {
    button.addEventListener("click", () => {
      closeEndpointInfo();
      loadCurrentMonthReport(
        button.dataset.currentMonthSlug,
        button.dataset.currentMonthName || button.dataset.currentMonthSlug,
        button.dataset.currentMonthPayment || ""
      );
    });
  });
}

function closeEndpointInfo() {
  endpointInfoModal.classList.remove("open");
  endpointInfoModal.setAttribute("aria-hidden", "true");
  state.endpointInfo = {
    slug: ""
  };
  endpointInfoBody.innerHTML = "";
  setEndpointInfoStatus("");
}

function setEndpointInfoStatus(message, isError) {
  endpointInfoStatus.textContent = message || "";
  endpointInfoStatus.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function findKeyBySlug(slug) {
  return state.keys.find((key) => key.slug === slug) || null;
}

async function loadMonthlyReportMonths(slug, name) {
  state.monthlyViewer.slug = slug;
  state.monthlyViewer.name = name;
  state.monthlyViewer.months = [];
  state.monthlyViewer.pdfFiles = [];
  state.monthlyViewer.selectedPdfs = new Set();
  state.monthlyViewer.available = false;
  state.monthlyViewer.manualMode = false;
  monthlyModal.classList.add("open");
  monthlyModal.setAttribute("aria-hidden", "false");
  monthlyTitle.textContent = name + " Monthly Reports";
  monthlySubtitle.textContent = "Loading detected Gilbarco months...";
  monthlyList.innerHTML = "";
  setMonthlyStatus("Loading months...");

  try {
    const response = await fetch("/api/admin/keys/" + encodeURIComponent(slug) + "/monthly-report-months");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not load monthly reports.");
    }
    if (payload && payload.manual) {
      state.monthlyViewer.months = [];
      state.monthlyViewer.available = false;
      monthlySubtitle.textContent = payload.message || "This endpoint uses manual monthly report handling.";
      monthlyList.innerHTML = '<div class="empty">' + escapeHtml(payload.message || "Manual monthly reports are configured for this endpoint.") + "</div>";
      setMonthlyStatus("");
      return;
    }
    state.monthlyViewer.months = Array.isArray(payload.months) ? payload.months : [];
    state.monthlyViewer.available = state.monthlyViewer.months.length > 0;
    
    // Also load available PDFs for manual selection
    try {
      const pdfResponse = await fetch("/api/admin/keys/" + encodeURIComponent(slug) + "/manual-report-pdfs");
      const pdfPayload = await pdfResponse.json();
      if (pdfResponse.ok && Array.isArray(pdfPayload.pdfFiles)) {
        state.monthlyViewer.pdfFiles = pdfPayload.pdfFiles;
      }
    } catch (error) {
      // PDF listing failed, but that's okay - we'll just not show manual selection
    }
    
        let subtitleText = "";
        if (state.monthlyViewer.available && state.monthlyViewer.pdfFiles.length) {
          subtitleText = "Choose a month to build one combined report, or select PDFs manually.";
        } else if (state.monthlyViewer.available) {
          subtitleText = "Choose a month to build one combined report.";
        } else if (state.monthlyViewer.pdfFiles.length) {
          subtitleText = "Use manual selection to build a report from available PDFs.";
        } else {
          subtitleText = "No Gilbarco PDF months or files were detected for this endpoint.";
        }
        monthlySubtitle.textContent = subtitleText;
    renderMonthlyViewer();
        let statusText = "";
        if (!state.monthlyViewer.available && !state.monthlyViewer.pdfFiles.length) {
          statusText = "No monthly Gilbarco reports or PDF files are available yet.";
        }
        setMonthlyStatus(statusText);
  } catch (error) {
    setMonthlyStatus(error.message, true);
  }
}

async function buildManualReport() {
  const selectedFiles = Array.from(state.monthlyViewer.selectedPdfs);
  if (!selectedFiles.length) {
    setMonthlyStatus("Select at least one PDF file.", true);
    return;
  }

  try {
    setMonthlyStatus("Building report from " + selectedFiles.length + " PDF(s)...");
    const response = await fetch(
      "/api/admin/keys/" + encodeURIComponent(state.monthlyViewer.slug) + "/manual-report",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdfFiles: selectedFiles })
      }
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not build manual report.");
    }

    closeMonthlyViewer();
    state.reportViewer.slug = state.monthlyViewer.slug;
    state.reportViewer.path = "manual-" + Date.now();
    state.reportViewer.report = payload;
    reportModal.classList.add("open");
    reportModal.setAttribute("aria-hidden", "false");
    reportTitle.textContent = payload.reportTitle || "Manual Selection Report";
    reportSubtitle.textContent = "Combined from " + selectedFiles.length + " PDF file(s)";
    syncReportDownloadButtons();
    renderParsedReport();
    setReportStatus(payload.sections.length ? "" : "No tabular report sections were detected.");
  } catch (error) {
    setMonthlyStatus(error.message, true);
  }
}

async function updatePaymentSystem(slug, paymentSystem) {
  try {
    setAppStatus("Updating payment system...");
    const response = await fetch("/api/admin/keys/" + encodeURIComponent(slug) + "/payment-system", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentSystem })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not update payment system.");
    }
    setAppStatus("Payment system updated for " + payload.slug + ".");
    await refreshAll();
  } catch (error) {
    setAppStatus(error.message, true);
    await refreshAll();
  }
}

async function updateAgentConfig(slug, verifoneUsername, verifonePassword) {
  try {
    setAppStatus("Saving Verifone Commander credentials...");
    const response = await fetch("/api/admin/keys/" + encodeURIComponent(slug) + "/agent-config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verifoneUsername,
        verifonePassword
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not save Verifone Commander credentials.");
    }
    setAppStatus("Verifone Commander credentials updated for " + payload.slug + ".");
    await refreshAll();
  } catch (error) {
    setAppStatus(error.message, true);
  }
}

function renderMonthlyViewer() {
  if (!state.monthlyViewer.months.length && !state.monthlyViewer.pdfFiles.length) {
    monthlyList.innerHTML = '<div class="empty">No month buckets or PDF files were found for this endpoint.</div>';
    return;
  }

  if (state.monthlyViewer.manualMode) {
    renderMonthlyViewerManual();
    return;
  }

  renderMonthlyViewerAuto();
}

function renderMonthlyViewerAuto() {
  const monthsHtml = state.monthlyViewer.months.length
    ? state.monthlyViewer.months.map((entry) => (
    "<div class=\"monthly-row\">" +
    "<div><strong>" + escapeHtml(entry.label || entry.month) + "</strong><br><span class=\"explorer-path\">" +
    escapeHtml(String(entry.reportCount || 0)) + " daily report(s)</span></div>" +
    "<div><button class=\"secondary\" data-build-month=\"" + escapeHtml(entry.month) + "\" data-build-month-label=\"" + escapeHtml(entry.label || entry.month) + "\">Build Report</button></div>" +
    "</div>"
      )).join("")
    : "";

  const manualButtonHtml = state.monthlyViewer.pdfFiles.length
    ? "<div class=\"monthly-row\"><div><strong>Manual Selection</strong><br><span class=\"explorer-path\">Choose specific PDFs to combine.</span></div><div><button class=\"secondary\" data-action=\"switch-manual\">Manual Selection</button></div></div>"
    : "";

  if (!monthsHtml && !manualButtonHtml) {
    monthlyList.innerHTML = '<div class="empty">No month buckets or PDF files were found for this endpoint.</div>';
    return;
  }

  const noMonthsMessage = !monthsHtml && manualButtonHtml
    ? "<div class=\"empty\" style=\"margin-bottom: 16px;\">No auto-detected months found. Use manual selection below to choose specific PDFs.</div>"
    : "";

  monthlyList.innerHTML = noMonthsMessage + monthsHtml + manualButtonHtml;

  monthlyList.querySelectorAll("button[data-build-month]").forEach((button) => {
    button.addEventListener("click", () => {
      loadMonthlyReport(state.monthlyViewer.slug, button.dataset.buildMonth, button.dataset.buildMonthLabel || button.dataset.buildMonth);
    });
  });

  monthlyList.querySelectorAll("button[data-action]").forEach((button) => {
    if (button.dataset.action === "switch-manual") {
      button.addEventListener("click", () => {
        state.monthlyViewer.manualMode = true;
        state.monthlyViewer.selectedPdfs = new Set();
        renderMonthlyViewerManual();
      });
    }
  });
}

function renderMonthlyViewerManual() {
  if (!state.monthlyViewer.pdfFiles.length) {
    monthlyList.innerHTML = '<div class="empty">No PDF files available for manual selection.</div>';
    return;
  }

  const backButtonHtml = state.monthlyViewer.months.length
    ? "<div class=\"monthly-row\"><button class=\"secondary\" data-action=\"switch-auto\">← Back to Auto-detected Months</button></div>"
    : "";

  const pdfListHtml = state.monthlyViewer.pdfFiles.map((pdfFile) => {
    const isSelected = state.monthlyViewer.selectedPdfs.has(pdfFile);
    return "<label class=\"checkbox-item\">" +
      "<input type=\"checkbox\" value=\"" + escapeHtml(pdfFile) + "\"" + (isSelected ? " checked" : "") + " data-pdf-file> " +
      "<span>" + escapeHtml(pdfFile) + "</span>" +
      "</label>";
  }).join("");

  const buildButtonHtml = state.monthlyViewer.selectedPdfs.size > 0
    ? "<div class=\"monthly-row\" style=\"padding: 14px 0;\"><button class=\"primary\" data-action=\"build-manual\" style=\"width: 100%;\">Build Report from " + state.monthlyViewer.selectedPdfs.size + " Selected PDF(s)</button></div>"
    : "<div class=\"monthly-row\" style=\"padding: 14px 0;\"><p class=\"explorer-path\">Select at least one PDF to build a report.</p></div>";

  monthlyList.innerHTML = backButtonHtml +
    "<div style=\"padding: 14px; border-bottom: 1px solid rgba(141, 118, 78, 0.16);\">" +
    "<strong>Select PDF Files</strong>" +
    "<div class=\"checkbox-list\" style=\"margin-top: 12px;\">" + pdfListHtml + "</div>" +
    "</div>" + buildButtonHtml;

  monthlyList.querySelectorAll("input[data-pdf-file]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const pdfFile = checkbox.value;
      if (checkbox.checked) {
        state.monthlyViewer.selectedPdfs.add(pdfFile);
      } else {
        state.monthlyViewer.selectedPdfs.delete(pdfFile);
      }
      renderMonthlyViewerManual();
    });
  });

  monthlyList.querySelectorAll("button[data-action]").forEach((button) => {
    if (button.dataset.action === "switch-auto") {
      button.addEventListener("click", () => {
        state.monthlyViewer.manualMode = false;
        state.monthlyViewer.selectedPdfs = new Set();
        renderMonthlyViewerAuto();
      });
    } else if (button.dataset.action === "build-manual") {
      button.addEventListener("click", () => {
        buildManualReport();
      });
    }
  });
}

async function loadMonthlyReport(slug, month, monthLabel) {
  try {
    setMonthlyStatus("Building " + monthLabel + " report...");
    const response = await fetch(
      "/api/admin/keys/" + encodeURIComponent(slug) + "/monthly-report?month=" + encodeURIComponent(month)
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not build monthly report.");
    }

    closeMonthlyViewer();
    state.reportViewer.slug = slug;
    state.reportViewer.path = "monthly-" + month;
    state.reportViewer.report = payload;
    reportModal.classList.add("open");
    reportModal.setAttribute("aria-hidden", "false");
    reportTitle.textContent = payload.reportTitle || (monthLabel + " Monthly Report");
    reportSubtitle.textContent = monthLabel + " combined report";
    syncReportDownloadButtons();
    renderParsedReport();
    setReportStatus(payload.sections.length ? "" : "No tabular report sections were detected.");
  } catch (error) {
    setMonthlyStatus(error.message, true);
  }
}

async function loadReportTree(slug, name, paymentSystem) {
  state.explorer.slug = slug;
  state.explorer.name = name;
  state.explorer.paymentSystem = paymentSystem || "";
  state.explorer.tree = null;
  state.explorer.expandedYears = new Set();
  state.explorer.expandedMonths = new Set();
  explorerModal.classList.add("open");
  explorerModal.setAttribute("aria-hidden", "false");
  explorerTitle.textContent = name + " Report Explorer";
  explorerSubtitle.textContent = "Loading reports...";
  setExplorerStatus("Loading report tree...");
  explorerList.innerHTML = "";
  explorerCrumbs.innerHTML = "";

  try {
    const response = await fetch("/api/admin/keys/" + encodeURIComponent(slug) + "/report-tree");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not load report tree.");
    }
    state.explorer.tree = payload;
    state.explorer.paymentSystem = payload.paymentSystem || state.explorer.paymentSystem;

    // Auto-expand the most recent year so the newest data is visible.
    if (Array.isArray(payload.years) && payload.years.length) {
      state.explorer.expandedYears.add(payload.years[0].year);
      const firstMonth = payload.years[0].months && payload.years[0].months[0];
      if (firstMonth) {
        state.explorer.expandedMonths.add(firstMonth.month);
      }
    }

    const isGilbarco = payload.paymentSystem === "gilbarco_passport";
    explorerSubtitle.textContent = isGilbarco
      ? "Gilbarco Passport reports grouped by year and month."
      : "Verifone Commander reports grouped by year and month.";
    renderReportTree();
    const totalReports = (payload.years || []).reduce((sum, year) => (
      sum + year.months.reduce((monthSum, month) => monthSum + month.reportCount, 0)
    ), 0);
    setExplorerStatus(totalReports
      ? ""
      : "No dated reports have been detected yet for this endpoint.");
  } catch (error) {
    setExplorerStatus(error.message, true);
  }
}

function renderReportTree() {
  const tree = state.explorer.tree;
  if (!tree) {
    explorerList.innerHTML = '<div class="empty">No report data is available.</div>';
    return;
  }

  explorerCrumbs.innerHTML = '<button class="crumb" data-tree-action="expand-all">Expand All</button>'
    + '<button class="crumb" data-tree-action="collapse-all">Collapse All</button>';

  const years = Array.isArray(tree.years) ? tree.years : [];
  if (!years.length) {
    explorerList.innerHTML = '<div class="empty">No dated reports have been detected yet for this endpoint.</div>';
    bindReportTreeActions();
    return;
  }

  const canDeleteEntry = Boolean(state.user && state.user.permissions && state.user.permissions.manageKeys);
  const isGilbarco = tree.paymentSystem === "gilbarco_passport";

  const html = years.map((year) => {
    const yearOpen = state.explorer.expandedYears.has(year.year);
    const monthCount = year.months.length;
    const monthsHtml = year.months.map((month) => {
      const monthOpen = state.explorer.expandedMonths.has(month.month);
      const reportsHtml = month.reports.map((report) => {
        const isEom = report.isEom;
        const eomBadge = isEom ? ' <span class="explorer-kind">EOM</span>' : "";
        const meta = report.kind === "directory"
          ? escapeHtml(report.day || "")
          : (escapeHtml(report.sizeLabel || "") + (report.day ? " | " + escapeHtml(report.day) : ""));
        const downloadAction = report.downloadUrl
          ? '<a href="' + report.downloadUrl + '">Download</a>'
          : "";
        const parseAction = report.canParseReport
          ? '<button class="secondary" data-parse-path="' + escapeHtml(report.path) + '" data-parse-name="' + escapeHtml(report.name) + '">View Parsed</button>'
          : "";
        const deleteAction = canDeleteEntry
          ? '<button class="danger" data-delete-path="' + escapeHtml(report.path) + '" data-delete-kind="' + escapeHtml(report.kind) + '" data-delete-name="' + escapeHtml(report.name) + '">Delete</button>'
          : "";
        return '<div class="explorer-row">'
          + '<div class="explorer-row-title">'
          + '<div><strong>' + escapeHtml(report.name) + '</strong>' + eomBadge + '</div>'
          + '<div class="explorer-kind">' + escapeHtml(report.kind) + (report.reportKind ? ' - ' + escapeHtml(report.reportKind) : '') + '</div>'
          + '<div class="explorer-path">' + escapeHtml(report.path) + '</div>'
          + '<div class="explorer-path">' + meta + '</div>'
          + '</div>'
          + '<div class="explorer-actions">' + parseAction + downloadAction + deleteAction + '</div>'
          + '</div>';
      }).join("");

      const monthActions = [];
      if (isGilbarco && month.canCompile) {
        monthActions.push('<button class="secondary" data-compile-month="' + escapeHtml(month.month) + '" data-compile-label="' + escapeHtml(month.label) + '">Compile Monthly Report</button>');
      }
      if (!isGilbarco && month.eomReport) {
        monthActions.push('<button class="secondary" data-open-eom-path="' + escapeHtml(month.eomReport.path) + '" data-open-eom-name="' + escapeHtml(month.eomReport.name) + '">Open End-of-Month Report</button>');
      }
      const actionsHtml = monthActions.length
        ? '<div class="monthly-row" style="margin-top:10px;"><div><strong>' + escapeHtml(month.label) + '</strong><br><span class="explorer-path">'
          + escapeHtml(String(month.reportCount)) + ' report(s)'
          + (month.eomReport ? ' &middot; EOM: ' + escapeHtml(month.eomReport.name) : '')
          + '</span></div><div class="explorer-actions">' + monthActions.join("") + '</div></div>'
        : "";

      return '<details class="report-tree-month"' + (monthOpen ? ' open' : '') + ' data-month-key="' + escapeHtml(month.month) + '">'
        + '<summary><strong>' + escapeHtml(month.label) + '</strong> &middot; '
        + escapeHtml(String(month.reportCount)) + ' report(s)'
        + (month.eomReport ? ' &middot; EOM available' : '')
        + '</summary>'
        + '<div class="explorer-list" style="padding-top:10px;">' + (reportsHtml || '<div class="empty">No reports in this month.</div>') + '</div>'
        + actionsHtml
        + '</details>';
    }).join("");

    return '<details class="report-tree-year"' + (yearOpen ? ' open' : '') + ' data-year-key="' + escapeHtml(year.year) + '" style="border:1px solid rgba(141,118,78,0.16); border-radius:2px; padding:12px 16px; background:rgba(255,255,255,0.6);">'
      + '<summary style="font-size:1.1rem; cursor:pointer;"><strong>' + escapeHtml(year.label) + '</strong> &middot; '
      + escapeHtml(String(monthCount)) + ' month(s)</summary>'
      + '<div style="display:grid; gap:10px; margin-top:12px;">' + monthsHtml + '</div>'
      + '</details>';
  }).join("");

  explorerList.innerHTML = html;
  bindReportTreeActions();
}

function bindReportTreeActions() {
  explorerList.querySelectorAll("details[data-year-key]").forEach((node) => {
    node.addEventListener("toggle", () => {
      const key = node.dataset.yearKey;
      if (node.open) {
        state.explorer.expandedYears.add(key);
      } else {
        state.explorer.expandedYears.delete(key);
      }
    });
  });

  explorerList.querySelectorAll("details[data-month-key]").forEach((node) => {
    node.addEventListener("toggle", () => {
      const key = node.dataset.monthKey;
      if (node.open) {
        state.explorer.expandedMonths.add(key);
      } else {
        state.explorer.expandedMonths.delete(key);
      }
    });
  });

  explorerCrumbs.querySelectorAll("button[data-tree-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.treeAction;
      const tree = state.explorer.tree;
      if (!tree) return;
      if (action === "expand-all") {
        (tree.years || []).forEach((year) => {
          state.explorer.expandedYears.add(year.year);
          year.months.forEach((month) => state.explorer.expandedMonths.add(month.month));
        });
      } else if (action === "collapse-all") {
        state.explorer.expandedYears = new Set();
        state.explorer.expandedMonths = new Set();
      }
      renderReportTree();
    });
  });

  explorerList.querySelectorAll("button[data-parse-path]").forEach((button) => {
    button.addEventListener("click", () => {
      loadParsedReport(state.explorer.slug, button.dataset.parsePath, button.dataset.parseName || "Report");
    });
  });

  explorerList.querySelectorAll("button[data-open-eom-path]").forEach((button) => {
    button.addEventListener("click", () => {
      loadParsedReport(state.explorer.slug, button.dataset.openEomPath, button.dataset.openEomName || "End of Month Report");
    });
  });

  explorerList.querySelectorAll("button[data-compile-month]").forEach((button) => {
    button.addEventListener("click", () => {
      const month = button.dataset.compileMonth;
      const label = button.dataset.compileLabel || month;
      loadMonthlyReport(state.explorer.slug, month, label);
    });
  });

  explorerList.querySelectorAll("button[data-delete-path]").forEach((button) => {
    button.addEventListener("click", async () => {
      const entryPath = button.dataset.deletePath;
      const entryKind = button.dataset.deleteKind || "file";
      const entryName = button.dataset.deleteName || entryPath;
      const warning = entryKind === "directory"
        ? "Delete folder \"" + entryName + "\" and everything inside it?"
        : "Delete file \"" + entryName + "\" from the server?";
      if (!window.confirm(warning)) {
        return;
      }
      await deleteExplorerEntry(entryPath, entryKind);
      // Refresh the tree to reflect the deletion.
      loadReportTree(state.explorer.slug, state.explorer.name, state.explorer.paymentSystem);
    });
  });
}

async function loadCurrentMonthReport(slug, name, paymentSystem) {
  state.reportViewer.slug = slug;
  state.reportViewer.path = "current-month-" + Date.now();
  state.reportViewer.report = null;
  reportModal.classList.add("open");
  reportModal.setAttribute("aria-hidden", "false");
  reportTitle.textContent = name + " - Current Month Report";
  reportSubtitle.textContent = "Building current month report...";
  reportBody.innerHTML = "";
  setReportStatus("Building current month report...");

  try {
    const response = await fetch("/api/admin/keys/" + encodeURIComponent(slug) + "/current-month-report");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not build current month report.");
    }
    state.reportViewer.report = payload;
    reportTitle.textContent = payload.reportTitle || (name + " - Current Month Report");
    reportSubtitle.textContent = payload.periodLabel
      ? "Current month combined report (" + payload.periodLabel + ")"
      : "Current month combined report";
    syncReportDownloadButtons();
    renderParsedReport();
    setReportStatus(payload.sections && payload.sections.length ? "" : "No tabular sections were detected.");
  } catch (error) {
    setReportStatus(error.message, true);
  }
}

async function loadExplorer(slug, name) {
  // Backward-compatible alias: redirects callers to the new Report Explorer.
  return loadReportTree(slug, name, "");
}

async function loadExplorerLegacy(slug, name, currentPath) {
  state.explorer.slug = slug;
  state.explorer.name = name;
  explorerModal.classList.add("open");
  explorerModal.setAttribute("aria-hidden", "false");
  explorerTitle.textContent = name + " Explorer";
  explorerSubtitle.textContent = "Loading folder contents...";
  setExplorerStatus("Loading folder...");
  explorerList.innerHTML = "";
  explorerCrumbs.innerHTML = "";

  try {
    const query = currentPath ? "?path=" + encodeURIComponent(currentPath) : "";
    const response = await fetch("/api/admin/keys/" + encodeURIComponent(slug) + "/browse" + query);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not load folder.");
    }
    state.explorer.currentPath = payload.currentPath;
    state.explorer.breadcrumbs = payload.breadcrumbs;
    state.explorer.entries = payload.entries;
    explorerSubtitle.textContent = payload.currentPath
      ? "Browsing " + payload.currentPath
      : "Browsing endpoint root";
    renderExplorer();
    setExplorerStatus(payload.entries.length ? "" : "This folder is empty.");
  } catch (error) {
    setExplorerStatus(error.message, true);
  }
}

function renderExplorer() {
  explorerUpButton.disabled = !state.explorer.currentPath;
  explorerCrumbs.innerHTML = state.explorer.breadcrumbs.map((crumb) => (
    "<button class=\"crumb\" data-crumb-path=\"" + escapeHtml(crumb.path) + "\">" + escapeHtml(crumb.name) + "</button>"
  )).join("");

  explorerCrumbs.querySelectorAll("button[data-crumb-path]").forEach((button) => {
    button.addEventListener("click", () => {
      loadExplorer(state.explorer.slug, state.explorer.name, button.dataset.crumbPath || "");
    });
  });

  if (!state.explorer.entries.length) {
    explorerList.innerHTML = '<div class="empty">No files or folders here yet.</div>';
    return;
  }

  explorerList.innerHTML = state.explorer.entries.map((entry) => {
    const canParseReport = Boolean(entry.canParseReport);
    const canDeleteEntry = Boolean(state.user && state.user.permissions && state.user.permissions.manageKeys);
    const primaryAction = entry.kind === "directory"
      ? "<button class=\"secondary\" data-open-path=\"" + escapeHtml(entry.path) + "\">Open Folder</button>"
      : "<a href=\"" + entry.downloadUrl + "\">Download</a>";
    const parseAction = canParseReport
      ? "<button class=\"secondary\" data-parse-path=\"" + escapeHtml(entry.path) + "\" data-parse-name=\"" + escapeHtml(entry.name) + "\">View Parsed</button>"
      : "";
    const deleteAction = canDeleteEntry
      ? "<button class=\"danger\" data-delete-path=\"" + escapeHtml(entry.path) + "\" data-delete-kind=\"" + escapeHtml(entry.kind) + "\" data-delete-name=\"" + escapeHtml(entry.name) + "\">Delete</button>"
      : "";
    const secondaryMeta = entry.kind === "directory"
      ? escapeHtml(entry.createdAt)
      : escapeHtml(entry.sizeLabel) + " | " + escapeHtml(entry.createdAt);
    return "<div class=\"explorer-row\">" +
      "<div class=\"explorer-row-title\">" +
      "<div><strong>" + escapeHtml(entry.name) + "</strong></div>" +
      "<div class=\"explorer-kind\">" + escapeHtml(entry.kind) + "</div>" +
      "<div class=\"explorer-path\">" + escapeHtml(entry.path) + "</div>" +
      "<div class=\"explorer-path\">" + secondaryMeta + "</div>" +
      "</div>" +
      "<div class=\"explorer-actions\">" + parseAction + primaryAction + deleteAction + "</div>" +
      "</div>";
  }).join("");

  explorerList.querySelectorAll("button[data-open-path]").forEach((button) => {
    button.addEventListener("click", () => {
      loadExplorer(state.explorer.slug, state.explorer.name, button.dataset.openPath);
    });
  });

  explorerList.querySelectorAll("button[data-parse-path]").forEach((button) => {
    button.addEventListener("click", () => {
      loadParsedReport(state.explorer.slug, button.dataset.parsePath, button.dataset.parseName || "Report");
    });
  });

  explorerList.querySelectorAll("button[data-delete-path]").forEach((button) => {
    button.addEventListener("click", async () => {
      const entryPath = button.dataset.deletePath;
      const entryKind = button.dataset.deleteKind || "file";
      const entryName = button.dataset.deleteName || entryPath;
      const warning = entryKind === "directory"
        ? "Delete folder \"" + entryName + "\" and everything inside it?"
        : "Delete file \"" + entryName + "\" from the server?";
      const confirmed = window.confirm(warning);
      if (!confirmed) {
        return;
      }
      await deleteExplorerEntry(entryPath, entryKind);
    });
  });
}

async function deleteExplorerEntry(entryPath, entryKind) {
  try {
    setExplorerStatus("Deleting " + entryKind + "...");
    const response = await fetch(
      "/api/admin/keys/" + encodeURIComponent(state.explorer.slug) + "/file-delete?path=" + encodeURIComponent(entryPath),
      { method: "DELETE" }
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not delete entry.");
    }
    setExplorerStatus("Deleted " + payload.kind + " " + payload.path + ".");
    await refreshAll();
    await loadReportTree(state.explorer.slug, state.explorer.name, state.explorer.paymentSystem);
  } catch (error) {
    setExplorerStatus(error.message, true);
  }
}

async function loadParsedReport(slug, reportPath, reportName) {
  state.reportViewer.slug = slug;
  state.reportViewer.path = reportPath;
  state.reportViewer.report = null;
  reportModal.classList.add("open");
  reportModal.setAttribute("aria-hidden", "false");
  reportTitle.textContent = reportName;
  reportSubtitle.textContent = "Parsing report...";
  reportBody.innerHTML = "";
  syncReportDownloadButtons();
  setReportStatus("Loading parsed report...");

  try {
    const response = await fetch("/api/admin/keys/" + encodeURIComponent(slug) + "/report?path=" + encodeURIComponent(reportPath));
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not parse report.");
    }
    state.reportViewer.report = payload;
    reportTitle.textContent = payload.reportTitle || reportName;
    reportSubtitle.textContent = reportPath;
    syncReportDownloadButtons();
    renderParsedReport();
    setReportStatus(payload.sections.length ? "" : "No tabular report sections were detected.");
  } catch (error) {
    syncReportDownloadButtons();
    setReportStatus(error.message, true);
  }
}

function renderParsedReport() {
  const report = state.reportViewer.report;
  if (!report) {
    reportBody.innerHTML = "";
    return;
  }

  const metadataCards = [
    renderMetaCard("Type", report.reportType || "report"),
    renderMetaCard("Store", report.storeNumber || "Unknown"),
    renderMetaCard("Period", report.periodLabel || "Unknown"),
    renderMetaCard("Open", report.openPeriod || "Unknown"),
    renderMetaCard("Close", report.closePeriod || "Unknown"),
    renderMetaCard("Scope", report.scopeLabel || "Not labeled")
  ].join("");
  const reportStats = [];
  if (report.month) {
    reportStats.push(renderMetaCard("Month", report.month));
  }
  if (report.sourceReportCount) {
    reportStats.push(renderMetaCard("Daily Reports", String(report.sourceReportCount)));
  }

  const sectionMarkup = report.sections.map((section) => {
    const rowSummary = section.truncated
      ? "Showing " + section.rows.length + " of " + section.totalRows + " row(s)"
      : section.totalRows + " row(s)";
    const headers = section.headers.length
      ? section.headers
      : Object.keys(section.rows[0] || {});
    const tableHead = headers.map((header) => "<th>" + escapeHtml(header) + "</th>").join("");
    const tableRows = section.rows.length
      ? section.rows.map((row) => (
          "<tr>" + headers.map((header) => "<td>" + escapeHtml(row[header] || "") + "</td>").join("") + "</tr>"
        )).join("")
      : "<tr><td colspan=\"" + headers.length + "\" class=\"empty\">No rows found in this section.</td></tr>";

    return "<section class=\"report-section\">" +
      "<div class=\"report-section-head\">" +
      "<strong>" + escapeHtml(section.title || "Report Section") + "</strong>" +
      "<span class=\"explorer-path\">" + escapeHtml(rowSummary) + "</span>" +
      "</div>" +
      "<div class=\"report-table-wrap\">" +
      "<table class=\"report-table\">" +
      "<thead><tr>" + tableHead + "</tr></thead>" +
      "<tbody>" + tableRows + "</tbody>" +
      "</table>" +
      "</div>" +
      "</section>";
  }).join("");

  reportBody.innerHTML =
    "<section class=\"report-meta\">" + metadataCards + reportStats.join("") + "</section>" +
    (sectionMarkup || "<div class=\"report-section\"><div class=\"empty\">No parsed sections are available for this report.</div></div>");
}

function renderMetaCard(label, value) {
  return "<div class=\"report-meta-card\"><strong>" + escapeHtml(label) + "</strong><div>" + escapeHtml(value) + "</div></div>";
}

function closeExplorer() {
  explorerModal.classList.remove("open");
  explorerModal.setAttribute("aria-hidden", "true");
  state.explorer = {
    slug: "",
    name: "",
    paymentSystem: "",
    tree: null,
    expandedYears: new Set(),
    expandedMonths: new Set()
  };
  explorerList.innerHTML = "";
  explorerCrumbs.innerHTML = "";
  setExplorerStatus("");
}

function closeReportViewer() {
  reportModal.classList.remove("open");
  reportModal.setAttribute("aria-hidden", "true");
  state.reportViewer = {
    slug: "",
    path: "",
    report: null
  };
  reportBody.innerHTML = "";
  syncReportDownloadButtons();
  setReportStatus("");
}

function closeMonthlyViewer() {
  monthlyModal.classList.remove("open");
  monthlyModal.setAttribute("aria-hidden", "true");
  state.monthlyViewer = {
    slug: "",
    name: "",
    months: [],
    available: false
  };
  monthlyList.innerHTML = "";
  setMonthlyStatus("");
}

function syncReportDownloadButtons() {
  const hasReport = Boolean(state.reportViewer.report);
  reportDownloadJsonButton.disabled = !hasReport;
  reportDownloadCsvButton.disabled = !hasReport;
  reportEmailCsvButton.disabled = !hasReport;
}

function downloadParsedReportJson() {
  if (!state.reportViewer.report) {
    setReportStatus("Load a parsed report before downloading.", true);
    return;
  }

  const filename = buildReportDownloadName("json");
  downloadTextFile(
    filename,
    JSON.stringify(state.reportViewer.report, null, 2),
    "application/json;charset=utf-8"
  );
}

function downloadParsedReportCsv() {
  if (!state.reportViewer.report) {
    setReportStatus("Load a parsed report before downloading.", true);
    return;
  }

  const filename = buildReportDownloadName("csv");
  downloadTextFile(
    filename,
    buildParsedReportCsv(state.reportViewer.report),
    "text/csv;charset=utf-8"
  );
}

async function emailParsedReportCsv() {
  if (!state.reportViewer.report) {
    setReportStatus("Load a parsed report before emailing CSV.", true);
    return;
  }

  const recipientChoice = window.prompt(
    "Send this CSV to which email?",
    ""
  );
  if (recipientChoice === null) {
    setReportStatus("CSV email canceled.");
    return;
  }

  const recipient = recipientChoice.trim().toLowerCase();
  if (!recipient) {
    setReportStatus("Enter one recipient email before sending.", true);
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    setReportStatus("Enter a valid recipient email before sending.", true);
    return;
  }

  try {
    setReportStatus("Emailing CSV export to " + recipient + "...");
    reportEmailCsvButton.disabled = true;

    const filename = buildReportDownloadName("csv");
    const csvContent = buildParsedReportCsv(state.reportViewer.report);
    const response = await fetch("/api/admin/report-email-csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename,
        subject: `Synchro CSV Export - ${filename}`,
        csvContent,
        recipient
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not email CSV export.");
    }

    const deliveredRecipient = Array.isArray(payload.recipients) && payload.recipients.length
      ? payload.recipients[0]
      : recipient;
    setReportStatus("CSV emailed to " + deliveredRecipient + ".");
  } catch (error) {
    setReportStatus(error.message, true);
  } finally {
    reportEmailCsvButton.disabled = false;
    syncReportDownloadButtons();
  }
}

function buildReportDownloadName(extension) {
  const baseName = state.reportViewer.path
    ? state.reportViewer.path.split("/").filter(Boolean).pop() || "report"
    : "report";
  const withoutExtension = baseName.replace(/\.[^.]+$/, "") || "report";
  return withoutExtension + "-parsed." + extension;
}

function buildParsedReportCsv(report) {
  const verifoneCsv = buildVerifoneCombinedCsv(report);
  if (verifoneCsv) {
    return verifoneCsv;
  }

  const gilbarcoCsv = buildGilbarcoCombinedCsv(report);
  if (gilbarcoCsv) {
    return gilbarcoCsv;
  }

  const preferredSection = findPreferredCsvSection(report);
  if (!preferredSection) {
    return "value\n";
  }

  const headerLine = preferredSection.columns.map((column) => escapeCsv(column.header)).join(",");
  const lines = [headerLine];

  preferredSection.rows.forEach((row) => {
    lines.push(
      preferredSection.columns
        .map((column) => escapeCsv(column.getValue(row)))
        .join(",")
    );
  });

  return lines.join("\n") + "\n";
}

function buildVerifoneCombinedCsv(report) {
  const departmentSection = report.sections.find((section) => matchesHeaders(section.headers, [
    "Dept#",
    "Description",
    "Cust#",
    "Items",
    "% of Sales",
    "Gross",
    "Refunds",
    "Discounts",
    "Net Sales"
  ]));
  const pluSection = report.sections.find((section) => matchesHeaders(section.headers, [
    "PLU Number",
    "Description",
    "Price",
    "Cust",
    "Items",
    "Tot Sales",
    "%Sales",
    "Reason Code",
    "Promotion ID"
  ]));

  if (!departmentSection && !pluSection) {
    return "";
  }

  const headers = [
    "section",
    "department",
    "plu",
    "description",
    "customers",
    "items",
    "% of sale",
    "gross",
    "refunds",
    "discounts",
    "net sales",
    "price",
    "reason code",
    "promotion id"
  ];
  const lines = [headers.map(escapeCsv).join(",")];

  if (departmentSection) {
    departmentSection.rows
      .filter((row) => /^\d+$/.test(String(row["Dept#"] || "").trim()))
      .forEach((row) => {
        lines.push([
          "department",
          row["Dept#"] || "",
          "",
          row.Description || "",
          row["Cust#"] || "",
          row.Items || "",
          row["% of Sales"] || "",
          row.Gross || "",
          row.Refunds || "",
          row.Discounts || "",
          row["Net Sales"] || "",
          "",
          "",
          ""
        ].map(escapeCsv).join(","));
      });
  }

  if (pluSection) {
    pluSection.rows.forEach((row) => {
      lines.push([
        "plu",
        "",
        row["PLU Number"] || "",
        row.Description || "",
        row.Cust || "",
        row.Items || "",
        row["%Sales"] || "",
        "",
        "",
        "",
        row["Tot Sales"] || "",
        row.Price || "",
        row["Reason Code"] || "",
        row["Promotion ID"] || ""
      ].map(escapeCsv).join(","));
    });
  }

  return lines.join("\n") + "\n";
}

function buildGilbarcoCombinedCsv(report) {
  const fuelSection = report.sections.find((section) => matchesHeaders(section.headers, [
    "Grade",
    "Grade Name",
    "Volume",
    "Sales",
    "% of Total Fuel Sales"
  ]));
  const categorySection = report.sections.find((section) => matchesHeaders(section.headers, [
    "Department",
    "Gross Sales",
    "Item Count",
    "Refund Count",
    "Net Count",
    "Refund $",
    "Discount $",
    "Net Sales",
    "% of Sales"
  ]));
  const pluSection = report.sections.find((section) => matchesHeaders(section.headers, [
    "PLU No.",
    "Pkg. Qty",
    "Description",
    "Department",
    "Count",
    "Price",
    "Sales",
    "% of Dept",
    "% of Total"
  ]));

  if (!fuelSection && !categorySection && !pluSection) {
    return "";
  }

  const headers = [
    "section",
    "code",
    "name",
    "description",
    "department",
    "volume",
    "count",
    "price",
    "sales",
    "gross sales",
    "item count",
    "refund count",
    "net count",
    "refund $",
    "discount $",
    "net sales",
    "% of sales",
    "% of dept",
    "% of total fuel sales",
    "% of total"
  ];
  const lines = [headers.map(escapeCsv).join(",")];

  if (fuelSection) {
    fuelSection.rows.forEach((row) => {
      lines.push([
        "fuel",
        row.Grade || "",
        row["Grade Name"] || "",
        "",
        "",
        row.Volume || "",
        "",
        "",
        row.Sales || "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        row["% of Total Fuel Sales"] || "",
        ""
      ].map(escapeCsv).join(","));
    });
  }

  if (categorySection) {
    categorySection.rows.forEach((row) => {
      lines.push([
        "category",
        "",
        "",
        "",
        row.Department || "",
        "",
        "",
        "",
        "",
        row["Gross Sales"] || "",
        row["Item Count"] || "",
        row["Refund Count"] || "",
        row["Net Count"] || "",
        row["Refund $"] || "",
        row["Discount $"] || "",
        row["Net Sales"] || "",
        row["% of Sales"] || "",
        "",
        "",
        ""
      ].map(escapeCsv).join(","));
    });
  }

  if (pluSection) {
    pluSection.rows.forEach((row) => {
      lines.push([
        "plu",
        row["PLU No."] || "",
        "",
        row.Description || "",
        row.Department || "",
        "",
        row.Count || "",
        row.Price || "",
        row.Sales || "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        row["% of Dept"] || "",
        "",
        row["% of Total"] || ""
      ].map(escapeCsv).join(","));
    });
  }

  return lines.join("\n") + "\n";
}

function findPreferredCsvSection(report) {
  const departmentSection = report.sections.find((section) => matchesHeaders(section.headers, [
    "Dept#",
    "Description",
    "Cust#",
    "Items",
    "% of Sales",
    "Gross",
    "Refunds",
    "Discounts",
    "Net Sales"
  ]));
  if (departmentSection) {
    return {
      rows: departmentSection.rows.filter((row) => /^\d+$/.test(String(row["Dept#"] || "").trim())),
      columns: [
        { header: "department", getValue: (row) => row["Dept#"] || "" },
        { header: "description", getValue: (row) => row.Description || "" },
        { header: "customers", getValue: (row) => row["Cust#"] || "" },
        { header: "items", getValue: (row) => row.Items || "" },
        { header: "% of sale", getValue: (row) => row["% of Sales"] || "" },
        { header: "gross", getValue: (row) => row.Gross || "" },
        { header: "refunds", getValue: (row) => row.Refunds || "" },
        { header: "discounts", getValue: (row) => row.Discounts || "" },
        { header: "net sales", getValue: (row) => row["Net Sales"] || "" }
      ]
    };
  }

  const gilbarcoCategorySection = report.sections.find((section) => matchesHeaders(section.headers, [
    "Department",
    "Gross Sales",
    "Item Count",
    "Refund Count",
    "Net Count",
    "Refund $",
    "Discount $",
    "Net Sales",
    "% of Sales"
  ]));
  if (gilbarcoCategorySection) {
    const gilbarcoFuelSection = report.sections.find((section) => matchesHeaders(section.headers, [
      "Grade",
      "Grade Name",
      "Volume",
      "Sales",
      "% of Total Fuel Sales"
    ]));
    const fuelRows = gilbarcoFuelSection
      ? gilbarcoFuelSection.rows.map((row) => ({
          Department: [row.Grade || "", row["Grade Name"] || ""].filter(Boolean).join(" "),
          "Gross Sales": row.Sales || "",
          "Item Count": row.Volume || "",
          "Refund Count": "",
          "Net Count": "",
          "Refund $": "",
          "Discount $": "",
          "Net Sales": row.Sales || "",
          "% of Sales": row["% of Total Fuel Sales"] || ""
        }))
      : [];
    return {
      rows: fuelRows.concat(gilbarcoCategorySection.rows),
      columns: [
        { header: "department", getValue: (row) => row.Department || "" },
        { header: "gross sales", getValue: (row) => row["Gross Sales"] || "" },
        { header: "item count", getValue: (row) => row["Item Count"] || "" },
        { header: "refund count", getValue: (row) => row["Refund Count"] || "" },
        { header: "net count", getValue: (row) => row["Net Count"] || "" },
        { header: "refund $", getValue: (row) => row["Refund $"] || "" },
        { header: "discount $", getValue: (row) => row["Discount $"] || "" },
        { header: "net sales", getValue: (row) => row["Net Sales"] || "" },
        { header: "% of sales", getValue: (row) => row["% of Sales"] || "" }
      ]
    };
  }

  const categorySection = report.sections.find((section) => matchesHeaders(section.headers, [
    "Cat#",
    "Description",
    "Cust#",
    "Items",
    "% of Sales",
    "Net Sales"
  ]));
  if (categorySection) {
    return {
      rows: categorySection.rows.filter((row) => /^\d+$/.test(String(row["Cat#"] || "").trim())),
      columns: [
        { header: "category", getValue: (row) => row["Cat#"] || "" },
        { header: "description", getValue: (row) => row.Description || "" },
        { header: "customers", getValue: (row) => row["Cust#"] || "" },
        { header: "items", getValue: (row) => row.Items || "" },
        { header: "% of sale", getValue: (row) => row["% of Sales"] || "" },
        { header: "net sales", getValue: (row) => row["Net Sales"] || "" }
      ]
    };
  }

  const firstSection = report.sections.find((section) => section.rows.length);
  if (!firstSection) {
    return null;
  }

  const headers = firstSection.headers.length ? firstSection.headers : Object.keys(firstSection.rows[0] || {});
  return {
    rows: firstSection.rows,
    columns: headers.map((header) => ({
      header,
      getValue: (row) => row[header] || ""
    }))
  };
}

function matchesHeaders(actualHeaders, expectedHeaders) {
  if (actualHeaders.length !== expectedHeaders.length) {
    return false;
  }

  return expectedHeaders.every((header, index) => normalizeHeader(actualHeaders[index]) === normalizeHeader(header));
}

function normalizeHeader(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeCsv(value) {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return "\"" + text.replace(/"/g, "\"\"") + "\"";
  }
  return text;
}

function downloadTextFile(filename, contents, contentType) {
  const blob = new Blob([contents], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function setExplorerStatus(message, isError = false) {
  explorerStatus.textContent = message;
  explorerStatus.style.color = isError ? "#b42318" : "#6f6658";
}

function setReportStatus(message, isError = false) {
  reportStatus.textContent = message;
  reportStatus.style.color = isError ? "#b42318" : "#6f6658";
}

function setMonthlyStatus(message, isError = false) {
  monthlyStatus.textContent = message;
  monthlyStatus.style.color = isError ? "#b42318" : "#6f6658";
}

function renderSettings() {
  settingDigestEnabledInput.checked = Boolean(state.settings.reportDigestEnabled);
  settingDigestTimeInput.value = state.settings.reportDigestTime || "07:00";
  settingRecipientEmailsInput.value = state.settings.reportDigestRecipients || "";

  if (state.settings.reportDigestLastSentAt) {
    setSettingsStatus(
      "Daily digest time: " + formatDigestTimeLabel(state.settings.reportDigestTime) +
      ". Last digest sent at " + state.settings.reportDigestLastSentAt + "."
    );
  } else {
    setSettingsStatus("Daily digest time: " + formatDigestTimeLabel(state.settings.reportDigestTime) + ". No digest has been sent yet.");
  }
}

async function saveSettings() {
  try {
    setSettingsStatus("Saving settings...");
    const response = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportDigestEnabled: settingDigestEnabledInput.checked,
        reportDigestTime: settingDigestTimeInput.value,
        reportDigestRecipients: settingRecipientEmailsInput.value
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not save settings.");
    }

    state.settings = {
      reportDigestEnabled: Boolean(payload.reportDigestEnabled),
      reportDigestTime: String(payload.reportDigestTime || "07:00"),
      reportDigestRecipients: String(payload.reportDigestRecipients || ""),
      reportDigestLastSentAt: String(payload.reportDigestLastSentAt || "")
    };
    renderSettings();
    setSettingsStatus("Settings saved.");
  } catch (error) {
    setSettingsStatus(error.message, true);
  }
}

async function sendTestDigest() {
  try {
    setSettingsStatus("Sending test digest...");
    testDigestButton.disabled = true;
    const response = await fetch("/api/admin/settings/test-digest", {
      method: "POST"
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not send test digest.");
    }

    const recipientCount = Array.isArray(payload.recipients) ? payload.recipients.length : 0;
    const reportCount = Number(payload.reportCount || 0);
    setSettingsStatus(
      "Test digest sent to " + recipientCount + " recipient(s) with " + reportCount + " report(s) from the current window."
    );
  } catch (error) {
    setSettingsStatus(error.message, true);
  } finally {
    testDigestButton.disabled = false;
  }
}

function parentPath(value) {
  const parts = String(value || "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/(["\\])/g, "\\$1");
}

function renderUsers() {
  if (!state.users.length) {
    userListEl.innerHTML = '<div class="card"><div class="empty">No users found.</div></div>';
    return;
  }

  userListEl.innerHTML = state.users.map((user) => {
    const statusBadge = user.disabled
      ? '<span class="badge disabled">Disabled</span>'
      : '<span class="badge">Active</span>';
    const scopes = user.role === "viewer"
      ? renderUserScopeEditor(user)
      : '<div class="empty">All endpoints available through manager access.</div>';

    return '<article class="card">' +
      '<div class="card-head">' +
      '<div><h3>' + escapeHtml(user.username) + '</h3>' + statusBadge + '<span class="badge">' + escapeHtml(friendlyRole(user.role)) + '</span></div>' +
      '<div class="toolbar-row">' +
      (user.role === "viewer"
        ? '<button class="secondary" data-user-action="save-scopes" data-user-id="' + escapeHtml(user.id) + '">Save Access</button>'
        : '') +
      (user.disabled
        ? '<button class="secondary" data-user-action="enable" data-user-id="' + escapeHtml(user.id) + '">Enable</button>'
        : '<button class="warn" data-user-action="disable" data-user-id="' + escapeHtml(user.id) + '">Disable</button>') +
      '<button class="danger" data-user-action="delete" data-user-id="' + escapeHtml(user.id) + '" data-username="' + escapeHtml(user.username) + '">Delete</button>' +
      '</div>' +
      '</div>' +
      '<div class="meta">' +
      '<div>Created: ' + escapeHtml(user.createdAt) + '</div>' +
      '<div>Permissions: ' + escapeHtml(user.permissions.manageKeys ? "Can manage API keys and users" : "Can view assigned endpoint uploads only") + '</div>' +
      '</div>' +
      '<div class="permissions">' + scopes + '</div>' +
      '</article>';
  }).join("");

  userListEl.querySelectorAll("button[data-user-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.userId;
      const action = button.dataset.userAction;
      if (action === "save-scopes") {
        const selected = Array.from(userListEl.querySelectorAll('input[data-scope-user-id="' + id + '"]:checked')).map((checkbox) => checkbox.value);
        await mutate("/api/admin/users/" + id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpointScopes: selected })
        }, "Viewer endpoint access updated.");
      } else if (action === "disable") {
        await mutate("/api/admin/users/" + id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabled: true })
        }, "User disabled.");
      } else if (action === "enable") {
        await mutate("/api/admin/users/" + id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabled: false })
        }, "User enabled.");
      } else if (action === "delete") {
        const username = button.dataset.username;
        const confirmed = window.confirm('Delete user "' + username + '"?');
        if (confirmed) {
          await mutate("/api/admin/users/" + id, { method: "DELETE" }, "User deleted.");
        }
      }
    });
  });
}

function renderScopeChecklist() {
  const checkboxes = state.keys.length
    ? state.keys.map((key) => (
        '<label class="checkbox-item"><input type="checkbox" value="' + escapeHtml(key.slug) + '"> <span>' +
        escapeHtml(key.name) + ' (<code>' + escapeHtml(key.slug) + '</code>)</span></label>'
      )).join("")
    : '<div class="empty">Create at least one endpoint before assigning viewer access.</div>';
  endpointScopeList.innerHTML = checkboxes;
  syncScopeVisibility();
}

function renderUserScopeEditor(user) {
  if (!state.keys.length) {
    return '<div class="empty">No endpoints available to assign.</div>';
  }

  return '<div class="checkbox-list">' + state.keys.map((key) => {
    const checked = user.endpointScopes.includes(key.slug) ? ' checked' : '';
    return '<label class="checkbox-item"><input type="checkbox" data-scope-user-id="' + escapeHtml(user.id) + '" value="' + escapeHtml(key.slug) + '"' + checked + '> <span>' +
      escapeHtml(key.name) + ' (<code>' + escapeHtml(key.slug) + '</code>)</span></label>';
  }).join("") + '</div>';
}

function syncScopeVisibility() {
  const isViewer = newRoleSelect.value === "viewer";
  scopeField.classList.toggle("hidden", !isViewer);
}

function selectedScopes() {
  return Array.from(endpointScopeList.querySelectorAll('input[type="checkbox"]:checked')).map((checkbox) => checkbox.value);
}

function setAuthStatus(message, isError = false) {
  authStatus.textContent = message;
  authStatus.style.color = isError ? "#b42318" : "#6f6658";
}

function setAppStatus(message, isError = false) {
  appStatus.textContent = message;
  appStatus.style.color = isError ? "#b42318" : "#6f6658";
}

function setSettingsStatus(message, isError = false) {
  settingsStatus.textContent = message;
  settingsStatus.style.color = isError ? "#b42318" : "#6f6658";
}

function formatDigestTimeLabel(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return "7:00 AM (server local time)";
  }

  const hours24 = Number(match[1]);
  const minutes = match[2];
  const suffix = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12;
  return hours12 + ":" + minutes + " " + suffix + " (server local time)";
}

function friendlyRole(role) {
  return role === "api_manager" ? "API Manager" : "Viewer";
}

function friendlyPaymentSystem(paymentSystem) {
  if (paymentSystem === "verifone_commander") {
    return "Verifone Commander";
  }
  return "Gilbarco Passport";
}

function isGilbarcoPaymentSystem(paymentSystem) {
  return paymentSystem !== "verifone_commander";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
