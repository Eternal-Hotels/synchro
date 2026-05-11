"use strict";

const state = {
  user: null,
  keys: [],
  users: [],
  activeTab: "keys",
  explorer: {
    slug: "",
    name: "",
    currentPath: "",
    breadcrumbs: [],
    entries: []
  },
  reportViewer: {
    slug: "",
    path: "",
    report: null
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
const keyCreatePanel = document.getElementById("key-create-panel");
const keyNameInput = document.getElementById("key-name");
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

document.getElementById("login-button").addEventListener("click", login);
document.getElementById("logout-button").addEventListener("click", logout);
document.getElementById("refresh-button").addEventListener("click", refreshAll);
document.getElementById("create-key-button").addEventListener("click", createKey);
document.getElementById("create-user-button").addEventListener("click", createUser);
newRoleSelect.addEventListener("change", syncScopeVisibility);
tabKeys.addEventListener("click", () => switchTab("keys"));
tabUsers.addEventListener("click", () => switchTab("users"));
explorerCloseButton.addEventListener("click", closeExplorer);
reportCloseButton.addEventListener("click", closeReportViewer);
reportDownloadJsonButton.addEventListener("click", downloadParsedReportJson);
reportDownloadCsvButton.addEventListener("click", downloadParsedReportCsv);
explorerUpButton.addEventListener("click", () => {
  const nextPath = state.explorer.currentPath ? parentPath(state.explorer.currentPath) : "";
  loadExplorer(state.explorer.slug, state.explorer.name, nextPath);
});
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
  setAppStatus("");
}

function showLoggedIn() {
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  userPill.style.display = "inline-flex";
  userLabel.textContent = state.user.username + " - " + friendlyRole(state.user.role);
  keyCreatePanel.classList.toggle("hidden", !state.user.permissions.manageKeys);
  tabUsers.classList.toggle("hidden", !state.user.permissions.manageUsers);
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
  const showUsers = state.activeTab === "users" && state.user.permissions.manageUsers;
  keysView.classList.toggle("hidden", showUsers);
  usersView.classList.toggle("hidden", !showUsers);
  tabKeys.classList.toggle("active", !showUsers);
  tabUsers.classList.toggle("active", showUsers);
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
      body: JSON.stringify({ name: keyNameInput.value.trim() })
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
        '<button class="secondary" data-action="rotate" data-slug="' + escapeHtml(key.slug) + '">Rotate Key</button>' +
        '<button class="danger" data-action="delete-key" data-slug="' + escapeHtml(key.slug) + '">Delete Key</button>')
      : "";
    const explorerSummary = key.rootEntryCount
      ? escapeHtml(String(key.rootEntryCount)) + " top-level item(s) ready to browse"
      : "No synced items at the endpoint root yet.";
    const lastUsedLine = key.lastUsedAt
      ? "<div>Last used: " + escapeHtml(key.lastUsedAt) + "</div>"
      : "<div>Last used: <code>Never</code></div>";
    const rotatedLine = key.rotatedAt
      ? "<div>Last rotated: " + escapeHtml(key.rotatedAt) + " (" + escapeHtml(String(key.rotationCount)) + " rotation(s))</div>"
      : "<div>Last rotated: <code>Never</code></div>";

    return "<article class=\"card\">" +
      "<div class=\"card-head\">" +
      "<div><h2>" + escapeHtml(key.name) + "</h2>" + badge + "</div>" +
      "<div class=\"toolbar-row\">" + actions + "</div>" +
      "</div>" +
      "<div class=\"meta\">" +
      "<div>Endpoint: <code>/api/upload/" + escapeHtml(key.slug) + "</code></div>" +
      "<div>API key: <code>Stored as a secure hash and never shown again after creation/rotation</code></div>" +
      "<div>Created: " + escapeHtml(key.createdAt) + "</div>" +
      lastUsedLine +
      rotatedLine +
      "<div>Storage folder: <code>storage/" + escapeHtml(key.slug) + "</code></div>" +
      "</div>" +
      "<div class=\"files\">" +
      "<div class=\"file-row\"><div><strong>File Explorer</strong><br><small>" + explorerSummary + "</small></div><div><button class=\"explorer-link\" data-explorer-slug=\"" + escapeHtml(key.slug) + "\" data-explorer-name=\"" + escapeHtml(key.name) + "\">Open Explorer</button></div></div>" +
      "</div>" +
      "</article>";
  }).join("");

  keyListEl.querySelectorAll("button[data-action]").forEach((button) => {
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

  keyListEl.querySelectorAll("button[data-explorer-slug]").forEach((button) => {
    button.addEventListener("click", () => {
      loadExplorer(button.dataset.explorerSlug, button.dataset.explorerName || button.dataset.explorerSlug, "");
    });
  });
}

async function loadExplorer(slug, name, currentPath) {
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
    const canParseReport = entry.kind === "file" && /\.(html?|pdf)$/i.test(entry.name);
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
    await loadExplorer(state.explorer.slug, state.explorer.name, state.explorer.currentPath);
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
    "<section class=\"report-meta\">" + metadataCards + "</section>" +
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
    currentPath: "",
    breadcrumbs: [],
    entries: []
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

function syncReportDownloadButtons() {
  const hasReport = Boolean(state.reportViewer.report);
  reportDownloadJsonButton.disabled = !hasReport;
  reportDownloadCsvButton.disabled = !hasReport;
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

function buildReportDownloadName(extension) {
  const baseName = state.reportViewer.path
    ? state.reportViewer.path.split("/").filter(Boolean).pop() || "report"
    : "report";
  const withoutExtension = baseName.replace(/\.[^.]+$/, "") || "report";
  return withoutExtension + "-parsed." + extension;
}

function buildParsedReportCsv(report) {
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

function parentPath(value) {
  const parts = String(value || "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
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

function friendlyRole(role) {
  return role === "api_manager" ? "API Manager" : "Viewer";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
