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

document.getElementById("login-button").addEventListener("click", login);
document.getElementById("logout-button").addEventListener("click", logout);
document.getElementById("refresh-button").addEventListener("click", refreshAll);
document.getElementById("create-key-button").addEventListener("click", createKey);
document.getElementById("create-user-button").addEventListener("click", createUser);
newRoleSelect.addEventListener("change", syncScopeVisibility);
tabKeys.addEventListener("click", () => switchTab("keys"));
tabUsers.addEventListener("click", () => switchTab("users"));
explorerCloseButton.addEventListener("click", closeExplorer);
explorerUpButton.addEventListener("click", () => {
  const nextPath = state.explorer.currentPath ? parentPath(state.explorer.currentPath) : "";
  loadExplorer(state.explorer.slug, state.explorer.name, nextPath);
});
explorerModal.addEventListener("click", (event) => {
  if (event.target === explorerModal) {
    closeExplorer();
  }
});
window.addEventListener("load", bootstrap);

async function bootstrap() {
  // Ask the server whether the browser already has a valid session cookie.
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
  // Send credentials to the server and, on success, update the UI state.
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
  // The cookie is HTTP-only, so the browser asks the server to clear it.
  await fetch("/api/session/logout", { method: "POST" });
  state.user = null;
  state.keys = [];
  state.users = [];
  showLoggedOut();
}

function showLoggedOut() {
  // Logged-out mode hides the admin application and shows the sign-in form.
  authView.classList.remove("hidden");
  appView.classList.add("hidden");
  userPill.style.display = "none";
  closeExplorer();
  setAppStatus("");
}

function showLoggedIn() {
  // Logged-in mode reveals the app and adjusts visible controls based on permissions.
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  userPill.style.display = "inline-flex";
  userLabel.textContent = state.user.username + " â€¢ " + friendlyRole(state.user.role);
  keyCreatePanel.classList.toggle("hidden", !state.user.permissions.manageKeys);
  tabUsers.classList.toggle("hidden", !state.user.permissions.manageUsers);
  if (!state.user.permissions.manageUsers && state.activeTab === "users") {
    switchTab("keys");
  } else {
    renderTabState();
  }
}

function switchTab(tab) {
  // We keep both tabs in memory and just switch which one is visible.
  state.activeTab = tab;
  renderTabState();
}

function renderTabState() {
  // Only managers can open the Users tab.
  const showUsers = state.activeTab === "users" && state.user.permissions.manageUsers;
  keysView.classList.toggle("hidden", showUsers);
  usersView.classList.toggle("hidden", !showUsers);
  tabKeys.classList.toggle("active", !showUsers);
  tabUsers.classList.toggle("active", showUsers);
}

async function refreshAll() {
  // Reload the endpoint list for everyone, and the user list only for managers.
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
  // The server, not the browser, is responsible for generating secure API keys.
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
  // Viewer accounts carry endpoint scopes; manager accounts do not need them.
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
  // This helper centralizes the common "call API, handle errors, refresh state" pattern.
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
  // Each endpoint card summarizes one upload target and its on-disk storage folder.
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
      ? escapeHtml(String(key.rootEntryCount)) + ' top-level item(s) ready to browse'
      : 'No synced items at the endpoint root yet.';
    const lastUsedLine = key.lastUsedAt
      ? '<div>Last used: ' + escapeHtml(key.lastUsedAt) + '</div>'
      : '<div>Last used: <code>Never</code></div>';
    const rotatedLine = key.rotatedAt
      ? '<div>Last rotated: ' + escapeHtml(key.rotatedAt) + ' (' + escapeHtml(String(key.rotationCount)) + ' rotation(s))</div>'
      : '<div>Last rotated: <code>Never</code></div>';

    return '<article class="card">' +
      '<div class="card-head">' +
      '<div><h2>' + escapeHtml(key.name) + '</h2>' + badge + '</div>' +
      '<div class="toolbar-row">' + actions + '</div>' +
      '</div>' +
      '<div class="meta">' +
      '<div>Endpoint: <code>/api/upload/' + escapeHtml(key.slug) + '</code></div>' +
      '<div>API key: <code>Stored as a secure hash and never shown again after creation/rotation</code></div>' +
      '<div>Created: ' + escapeHtml(key.createdAt) + '</div>' +
      lastUsedLine +
      rotatedLine +
      '<div>Storage folder: <code>storage/' + escapeHtml(key.slug) + '</code></div>' +
      '</div>' +
      '<div class="files">' +
      '<div class="file-row"><div><strong>File Explorer</strong><br><small>' + explorerSummary + '</small></div><div><button class="explorer-link" data-explorer-slug="' + escapeHtml(key.slug) + '" data-explorer-name="' + escapeHtml(key.name) + '">Open Explorer</button></div></div>' +
      '</div>' +
      '</article>';
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
        const confirmed = window.confirm('Rotate the API key for "' + slug + '"? The current key will stop working immediately.');
        if (confirmed) {
          await rotateKey(slug);
        }
      } else if (action === "delete-key") {
        const confirmed = window.confirm('Delete key "' + slug + '"? Stored files stay on disk.');
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
  // The explorer requests one folder listing at a time from the server.
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
  // Rebuild the file browser from the latest directory-listing payload.
  explorerUpButton.disabled = !state.explorer.currentPath;
  explorerCrumbs.innerHTML = state.explorer.breadcrumbs.map((crumb) => (
    '<button class="crumb" data-crumb-path="' + escapeHtml(crumb.path) + '">' + escapeHtml(crumb.name) + '</button>'
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
    const primaryAction = entry.kind === "directory"
      ? '<button class="secondary" data-open-path="' + escapeHtml(entry.path) + '">Open Folder</button>'
      : '<a href="' + entry.downloadUrl + '">Download</a>';
    const secondaryMeta = entry.kind === "directory"
      ? escapeHtml(entry.createdAt)
      : escapeHtml(entry.sizeLabel) + ' | ' + escapeHtml(entry.createdAt);
    return '<div class="explorer-row">' +
      '<div class="explorer-row-title">' +
      '<div><strong>' + escapeHtml(entry.name) + '</strong></div>' +
      '<div class="explorer-kind">' + escapeHtml(entry.kind) + '</div>' +
      '<div class="explorer-path">' + escapeHtml(entry.path) + '</div>' +
      '<div class="explorer-path">' + secondaryMeta + '</div>' +
      '</div>' +
      '<div class="explorer-actions">' + primaryAction + '</div>' +
      '</div>';
  }).join("");

  explorerList.querySelectorAll("button[data-open-path]").forEach((button) => {
    button.addEventListener("click", () => {
      loadExplorer(state.explorer.slug, state.explorer.name, button.dataset.openPath);
    });
  });
}

function closeExplorer() {
  // Resetting state here makes a future open start from a clean slate.
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

function setExplorerStatus(message, isError = false) {
  // Reuse one status line for loading, informational, and error messages.
  explorerStatus.textContent = message;
  explorerStatus.style.color = isError ? "#b42318" : "#6f6658";
}

function parentPath(value) {
  // Given "a/b/c", return "a/b" so the Up button knows where to go next.
  const parts = String(value || "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function renderUsers() {
  // The browser receives only safe user fields; password hashes never leave the server.
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
  // Rebuild the new-user scope chooser from the currently known endpoint list.
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
  // Viewer accounts can be re-scoped by checking and unchecking endpoint boxes.
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
  // Hide viewer-only controls when the chosen role is not "viewer".
  const isViewer = newRoleSelect.value === "viewer";
  scopeField.classList.toggle("hidden", !isViewer);
}

function selectedScopes() {
  // Collect the values from the checked boxes into a plain array.
  return Array.from(endpointScopeList.querySelectorAll('input[type="checkbox"]:checked')).map((checkbox) => checkbox.value);
}

function setAuthStatus(message, isError = false) {
  // Status messages double as lightweight error display.
  authStatus.textContent = message;
  authStatus.style.color = isError ? "#b42318" : "#6f6658";
}

function setAppStatus(message, isError = false) {
  // The app status bar mirrors the auth status pattern for the main workspace.
  appStatus.textContent = message;
  appStatus.style.color = isError ? "#b42318" : "#6f6658";
}

function friendlyRole(role) {
  // Convert stored role IDs into labels people can read quickly.
  return role === "api_manager" ? "API Manager" : "Viewer";
}

function escapeHtml(value) {
  // Any user-provided string that is inserted into HTML should be escaped first.
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

