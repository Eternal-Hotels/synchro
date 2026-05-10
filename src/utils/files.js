"use strict";

// "fs" is Node's built-in file system module.
// It can create/read/write/delete files and directories.
const fs = require("fs");

// "path" gives us cross-platform path manipulation.
// path.join, path.posix.normalize, path.basename, etc.
const path = require("path");

// Create a directory (folder) at targetPath if it doesn't already exist.
// Called before any file write to make sure the destination folder is there.
function ensureDirectory(targetPath) {
  // fs.existsSync returns true if the path exists (as a file or folder).
  if (!fs.existsSync(targetPath)) {
    // fs.mkdirSync creates the directory synchronously (blocking).
    // { recursive: true } means "also create all missing parent directories."
    // Without it, trying to create "a/b/c" when "a/b" doesn't exist would fail.
    fs.mkdirSync(targetPath, { recursive: true });
  }
}

// Convert a human-readable name into a URL-safe identifier (called a "slug").
// E.g.: "Warehouse Laptop #3!" → "warehouse-laptop-3"
// Slugs are used as folder names on disk AND in URL paths like /api/upload/warehouse-laptop-3.
function slugify(value) {
  return String(value)
    // Convert to lowercase so "Foo" and "foo" become the same slug.
    .toLowerCase()
    // Replace any character that is NOT a lowercase letter or digit with a hyphen.
    // The + means "replace runs of bad characters all at once" (e.g. "  " → "-").
    .replace(/[^a-z0-9]+/g, "-")
    // Remove leading and trailing hyphens (e.g. "-foo-" → "foo").
    .replace(/^-+|-+$/g, "")
    // Limit to 48 characters so folder names stay reasonable.
    .slice(0, 48);
}

// Build a slug that does not collide with any existing endpoint slug.
// E.g. if "warehouse-laptop" already exists, this returns "warehouse-laptop-2".
function buildUniqueSlug(name, keys) {
  // Start with the base slug derived from the name.
  const base = slugify(name) || "endpoint";
  let candidate = base;
  let counter = 2;

  // Build a Set of all existing slugs for fast O(1) membership checks.
  const existing = new Set(keys.map((item) => item.slug));

  // Keep incrementing the counter until we find a slug that isn't taken.
  while (existing.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }

  return candidate;
}

// Take a raw user-supplied file path and return a safe, normalized version.
// This is one of the most security-critical functions in the whole project.
// It blocks "path traversal" attacks — attempts to escape the intended directory
// using sequences like "../../../etc/passwd".
function sanitizeRelativePath(value) {
  // Normalize Windows backslashes to forward slashes.
  const raw = String(value || "").replace(/\\/g, "/");

  // path.posix.normalize collapses "." and ".." and double slashes.
  // E.g. "a/./b/../c" → "a/c"
  const normalized = path.posix.normalize(raw);

  // Reject blank, ".", or anything that still starts with ".." after normalization.
  // If normalized is ".." or "../something", it must be rejected outright.
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    return "";
  }

  // Split the path into individual segments and filter each one.
  const safeParts = normalized
    .split("/")           // ["a", "b", "file.html"]
    .filter(Boolean)      // Remove empty strings from leading/trailing slashes.
    // Replace any character that isn't a letter, digit, dot, underscore, or hyphen with _.
    // This blocks characters that could be special to the shell or OS.
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_"))
    .filter(Boolean);     // Remove any segment that became empty after sanitization.

  // Rejoin with forward slashes to get the final safe relative path.
  return safeParts.join("/");
}

// Given a relative path like "a/b/c", return its parent "a/b".
// Given "" (the root), return "".
// Used by the file explorer's "Up" button.
function parentRelativePath(relativePath) {
  if (!relativePath) {
    return "";
  }
  // path.posix.dirname("a/b/c") → "a/b"
  // path.posix.dirname("a") → "." — we normalize that to ""
  const parent = path.posix.dirname(relativePath);
  return parent === "." ? "" : parent;
}

// Build an array of { name, path } objects for a breadcrumb trail.
// E.g. "a/b/c" → [{name:"Root", path:""}, {name:"a", path:"a"}, {name:"b", path:"a/b"}, {name:"c", path:"a/b/c"}]
// The browser uses this to render clickable path segments.
function buildBreadcrumbs(relativePath) {
  // Always include "Root" as the first crumb (clicking it navigates to the top).
  const breadcrumbs = [{ name: "Root", path: "" }];
  if (!relativePath) {
    return breadcrumbs;
  }

  // Break the path into individual folder names.
  const parts = relativePath.split("/").filter(Boolean);
  let current = "";

  // Accumulate the path segment by segment so each crumb knows the full path to that point.
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    breadcrumbs.push({ name: part, path: current });
  }
  return breadcrumbs;
}

// Export all the functions that other modules need.
module.exports = {
  ensureDirectory,
  slugify,
  buildUniqueSlug,
  sanitizeRelativePath,
  parentRelativePath,
  buildBreadcrumbs
};
