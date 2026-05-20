"use strict";

const authGate = document.getElementById("auth-gate");
const authView = document.getElementById("auth-view");
const authStatus = document.getElementById("auth-status");
const authorizedUserButton = document.getElementById("authorized-user-button");
const loginButton = document.getElementById("login-button");
const loginUsernameInput = document.getElementById("login-username");
const loginPasswordInput = document.getElementById("login-password");

window.addEventListener("load", bootstrap);

if (authorizedUserButton) {
  authorizedUserButton.addEventListener("click", revealLoginPanel);
}

if (loginButton) {
  loginButton.addEventListener("click", login);
}

[loginUsernameInput, loginPasswordInput].forEach((input) => {
  if (!input) {
    return;
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      login();
    }
  });
});

function loginUrl(path) {
  return new URL(String(path || "").replace(/^\/+/, ""), window.location.origin + "/").toString();
}

async function readJsonResponse(response, requestPath) {
  const rawText = await response.text();
  if (!rawText) {
    return {};
  }

  try {
    return JSON.parse(rawText);
  } catch (_error) {
    console.error("Unexpected non-JSON API response during sign-in.", {
      requestPath,
      responseUrl: response.url,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      bodyPreview: rawText.slice(0, 300)
    });
    throw new Error("Could not process the sign-in response.");
  }
}

async function fetchJson(path, options) {
  const response = await fetch(loginUrl(path), options);
  const payload = await readJsonResponse(response, path);
  return { response, payload };
}

async function bootstrap() {
  try {
    const { response } = await fetchJson("/api/session/me");
    if (response.ok) {
      redirectToApp();
    }
  } catch (_error) {
    setAuthStatus("");
  }
}

function revealLoginPanel() {
  if (authGate) {
    authGate.classList.add("hidden");
  }

  if (authView) {
    authView.classList.remove("hidden");
  }

  if (loginUsernameInput) {
    loginUsernameInput.focus();
  }
}

async function login() {
  setAuthStatus("Signing in...");

  try {
    const { response, payload } = await fetchJson("/api/session/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: loginUsernameInput ? loginUsernameInput.value.trim() : "",
        password: loginPasswordInput ? loginPasswordInput.value : ""
      })
    });

    if (!response.ok) {
      throw new Error(payload.error || "Sign-in failed.");
    }

    if (loginPasswordInput) {
      loginPasswordInput.value = "";
    }

    redirectToApp();
  } catch (error) {
    setAuthStatus(error.message, true);
  }
}

function redirectToApp() {
  window.location.replace(loginUrl("/"));
}

function setAuthStatus(message, isError = false) {
  if (!authStatus) {
    return;
  }

  authStatus.textContent = message || "";
  authStatus.style.color = isError ? "var(--danger)" : "var(--muted)";
}