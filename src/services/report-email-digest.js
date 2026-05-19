"use strict";

const fs = require("fs");
const path = require("path");
const { STORAGE_DIR } = require("../config");
const { parseMonthlyGilbarcoReport, parseReportFile } = require("./report-parser");

const O365_SENDER = "auditor@eternalhotels.com";
const DEFAULT_DIGEST_TIME = "07:00";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const DEFAULT_GRAPH_REQUEST_TIMEOUT_MS = 15000;
const GRAPH_REQUEST_TIMEOUT_MS = resolveGraphRequestTimeoutMs(process.env.SYNCHRO_GRAPH_REQUEST_TIMEOUT_MS);

function startReportEmailDigestScheduler(storage, logger = console) {
  let timer = null;

  async function runDueDigest() {
    const now = new Date();
    const settings = await storage.getAppSettings();
    const digestTime = normalizeDigestTime(settings.reportDigestTime);
    const todayWindowStart = startOfWindow(now, digestTime);
    if (!settings.reportDigestEnabled) {
      return;
    }

    const recipients = parseRecipients(settings.reportDigestRecipients);
    if (!recipients.length) {
      logger.warn("Report digest is enabled but no recipient emails are configured.");
      return;
    }

    if (now < todayWindowStart) {
      return;
    }

    const lastSentAt = parseIsoDate(settings.reportDigestLastSentAt);
    if (lastSentAt && lastSentAt >= todayWindowStart) {
      return;
    }

    const since = lastSentAt ? lastSentAt.toISOString() : previousWindowStart(now, digestTime).toISOString();
    const until = now.toISOString();
    const uploads = await storage.listReportUploadsSince(since, until);

    if (uploads.length > 0) {
      await sendDigestEmail(recipients, uploads, since, until);
      logger.log(`Sent report digest with ${uploads.length} new report(s) to ${recipients.join(", ")}.`);
    } else {
      logger.log("No new reports found for digest window. Marking window as synced.");
    }

    await runDueGilbarcoMonthEnd({
      storage,
      recipients,
      now,
      logger
    });

    await storage.updateAppSettings({
      reportDigestLastSentAt: until
    });
  }

  async function tick() {
    try {
      await runDueDigest();
    } catch (error) {
      logger.error("Report digest scheduler failed.", error);
    } finally {
      scheduleNext();
    }
  }

  async function scheduleNext() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    let digestTime = DEFAULT_DIGEST_TIME;
    try {
      const settings = await storage.getAppSettings();
      digestTime = normalizeDigestTime(settings.reportDigestTime);
    } catch (_error) {
      digestTime = DEFAULT_DIGEST_TIME;
    }

    const nextRun = nextWindowStart(new Date(), digestTime);
    const delayMs = Math.max(1000, nextRun.getTime() - Date.now());
    timer = setTimeout(() => {
      tick();
    }, delayMs);
  }

  tick();

  return {
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

async function sendReportDigestTest(storage, logger = console) {
  const settings = await storage.getAppSettings();
  const recipients = parseRecipients(settings.reportDigestRecipients);
  if (!recipients.length) {
    throw new Error("Configure at least one digest recipient before sending a test digest.");
  }

  const testWindow = buildManualTestWindow(new Date());
  const since = testWindow.since;
  const until = testWindow.until;
  const uploads = await storage.listReportUploadsSince(since, until);

  await sendDigestEmail(recipients, uploads, since, until, {
    isTest: true
  });

  logger.log(`Sent test report digest with ${uploads.length} report(s) to ${recipients.join(", ")}.`);

  return {
    recipients,
    since,
    until,
    reportCount: uploads.length
  };
}

async function sendParsedCsvEmail(storage, payload = {}, logger = console) {
  const requestedRecipient = String(payload.recipient || "").trim().toLowerCase();
  if (!requestedRecipient) {
    throw new Error("Choose one recipient email before emailing a CSV export.");
  }
  if (!isValidEmailAddress(requestedRecipient)) {
    throw new Error("Recipient email address is invalid.");
  }
  const recipients = [requestedRecipient];

  const csvContent = String(payload.csvContent || "");
  if (!csvContent.trim()) {
    throw new Error("CSV content is empty.");
  }

  const accessToken = await getGraphAccessToken();
  const safeFilename = String(payload.filename || "parsed-report.csv")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "parsed-report.csv";
  const filename = safeFilename.toLowerCase().endsWith(".csv") ? safeFilename : `${safeFilename}.csv`;
  const subject = String(payload.subject || `Synchro Parsed Report CSV: ${filename}`).trim();
  const toRecipients = recipients.map((address) => ({
    emailAddress: {
      address
    }
  }));

  await graphPostJson(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(O365_SENDER)}/sendMail`,
    accessToken,
    {
      message: {
        subject,
        body: {
          contentType: "Text",
          content: "Attached is the requested Synchro CSV export from the report viewer."
        },
        toRecipients,
        attachments: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: filename,
            contentType: "text/csv",
            contentBytes: Buffer.from(csvContent, "utf8").toString("base64")
          }
        ]
      },
      saveToSentItems: true
    }
  );

  logger.log(`Sent parsed CSV email (${filename}) to ${recipients.join(", ")}.`);
  return {
    recipients,
    filename,
    bytes: Buffer.byteLength(csvContent, "utf8")
  };
}

async function runDueGilbarcoMonthEnd({ storage, recipients, now, logger = console }) {
  const targetMonth = previousMonthKey(now);
  const settings = await storage.getAppSettings();
  if (settings.reportMonthEndLastSentMonth === targetMonth) {
    return;
  }

  const endpointKeys = await storage.listKeysByPaymentSystem("gilbarco_passport");
  if (!endpointKeys.length) {
    await storage.updateAppSettings({
      reportMonthEndLastSentMonth: targetMonth
    });
    logger.log(`No Gilbarco endpoints found for month-end report ${targetMonth}.`);
    return;
  }

  const compiledReports = [];
  const skipped = [];

  for (const endpoint of endpointKeys) {
    const endpointRoot = path.join(STORAGE_DIR, endpoint.slug);
    if (!fs.existsSync(endpointRoot)) {
      skipped.push(`${endpoint.slug} (storage folder missing)`);
      continue;
    }

    try {
      const report = parseMonthlyGilbarcoReport(endpointRoot, targetMonth);
      const csvContent = buildReportCsv(report);
      if (!csvContent.trim()) {
        skipped.push(`${endpoint.slug} (no parseable data)`);
        continue;
      }

      compiledReports.push({
        endpointSlug: endpoint.slug,
        endpointName: endpoint.name,
        month: targetMonth,
        csvContent
      });
    } catch (error) {
      const message = error && error.message ? error.message : "compile failed";
      skipped.push(`${endpoint.slug} (${message})`);
    }
  }

  if (!compiledReports.length && skipped.length) {
    logger.warn(`Gilbarco month-end report ${targetMonth} was not sent. ${skipped.join("; ")}`);
    return;
  }

  await sendGilbarcoMonthEndEmail(recipients, targetMonth, compiledReports, skipped);
  await storage.updateAppSettings({
    reportMonthEndLastSentMonth: targetMonth
  });

  logger.log(
    `Sent Gilbarco month-end report for ${targetMonth} with ${compiledReports.length} attachment(s) to ${recipients.join(", ")}.`
  );
}

function buildManualTestWindow(now) {
  const windowEnd = new Date(now);
  windowEnd.setHours(23, 0, 0, 0);

  const windowStart = new Date(windowEnd);
  windowStart.setDate(windowStart.getDate() - 1);

  return {
    since: windowStart.toISOString(),
    until: windowEnd.toISOString()
  };
}

function startOfWindow(now, digestTime = DEFAULT_DIGEST_TIME) {
  const { hours, minutes } = parseDigestTime(digestTime);
  const windowDate = new Date(now);
  windowDate.setHours(hours, minutes, 0, 0);
  return windowDate;
}

function previousWindowStart(now, digestTime = DEFAULT_DIGEST_TIME) {
  const today = startOfWindow(now, digestTime);
  if (now >= today) {
    const previous = new Date(today);
    previous.setDate(previous.getDate() - 1);
    return previous;
  }

  const previous = new Date(today);
  previous.setDate(previous.getDate() - 1);
  return previous;
}

function nextWindowStart(now, digestTime = DEFAULT_DIGEST_TIME) {
  const today = startOfWindow(now, digestTime);
  if (now < today) {
    return today;
  }

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow;
}

function parseIsoDate(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function parseRecipients(recipientsText) {
  return String(recipientsText || "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isValidEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function normalizeDigestTime(rawValue) {
  const value = String(rawValue || "").trim() || DEFAULT_DIGEST_TIME;
  return /^\d{2}:\d{2}$/.test(value) ? value : DEFAULT_DIGEST_TIME;
}

function parseDigestTime(rawValue) {
  const normalized = normalizeDigestTime(rawValue);
  const match = normalized.match(/^(\d{2}):(\d{2})$/);
  const hours = match ? Number(match[1]) : 7;
  const minutes = match ? Number(match[2]) : 0;
  return {
    hours: hours >= 0 && hours <= 23 ? hours : 7,
    minutes: minutes >= 0 && minutes <= 59 ? minutes : 0
  };
}

function previousMonthKey(now) {
  const current = new Date(now);
  current.setDate(1);
  current.setHours(0, 0, 0, 0);
  current.setMonth(current.getMonth() - 1);
  return `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(monthKey) {
  const match = String(monthKey || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    return String(monthKey || "");
  }

  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];

  return `${monthNames[Number(match[2]) - 1] || match[2]} ${match[1]}`;
}

function safeAttachmentBase(value) {
  return String(value || "gilbarco")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "gilbarco";
}

function resolveGraphRequestTimeoutMs(rawValue) {
  const parsed = Number.parseInt(String(rawValue || "").trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 1000) {
    return parsed;
  }
  return DEFAULT_GRAPH_REQUEST_TIMEOUT_MS;
}

function createStatusError(statusCode, message, cause) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = GRAPH_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw createStatusError(504, `Graph request timed out after ${timeoutMs} ms.`, error);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendDigestEmail(recipients, uploads, sinceIso, untilIso, options = {}) {
  const isTest = Boolean(options && options.isTest);
  const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024; // 3 MB raw (base64 inflates ~33%, stays under Graph 4 MB limit)

  const accessToken = await getGraphAccessToken();

  const subjectPrefix = isTest ? "[TEST] " : "";
  const subject = `${subjectPrefix}Synchro Report Digest (${uploads.length} new report${uploads.length === 1 ? "" : "s"})`;

  const attachments = [];
  const skipped = [];
  let totalAttachmentBytes = 0;

  for (const upload of uploads) {
    const fullPath = path.join(STORAGE_DIR, upload.endpointSlug, upload.relativePath);
    const safeBase = path.basename(upload.relativePath).replace(/[^A-Za-z0-9._-]+/g, "_");
    const safeSlug = upload.endpointSlug.replace(/[^A-Za-z0-9._-]+/g, "_");
    // For Verifone, the relative path contains a YYYY-MM-DD date folder (e.g. "3/2026-03-31.045/index.html")
    const dateMatch = upload.relativePath.match(/(\d{4}-\d{2}-\d{2})/);
    const dateSuffix = dateMatch ? `-${dateMatch[1]}` : "";
    const csvFilename = safeBase.replace(/\.[^.]+$/, "") + `-${safeSlug}${dateSuffix}.csv`;

    let csvContent = "";
    try {
      const report = parseReportFile(fullPath);
      csvContent = buildReportCsv(report);
    } catch (_err) {
      skipped.push(`${upload.endpointSlug}/${upload.relativePath} (parse error)`);
      continue;
    }

    if (!csvContent.trim()) {
      skipped.push(`${upload.endpointSlug}/${upload.relativePath} (no parseable data)`);
      continue;
    }

    const csvBytes = Buffer.byteLength(csvContent, "utf8");
    if (totalAttachmentBytes + csvBytes > MAX_ATTACHMENT_BYTES) {
      skipped.push(`${upload.endpointSlug}/${upload.relativePath} (size limit reached)`);
      continue;
    }

    totalAttachmentBytes += csvBytes;
    attachments.push({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: csvFilename,
      contentType: "text/csv",
      contentBytes: Buffer.from(csvContent, "utf8").toString("base64")
    });
  }

  const bodyLines = [
    isTest ? "Synchro report digest (manual test)" : "Synchro report digest",
    "",
    ...(isTest
      ? [
          "This was sent from the Admin Settings test action.",
          "It does not change the scheduler's last-sent timestamp.",
          ""
        ]
      : []),
    `Window start: ${sinceIso}`,
    `Window end: ${untilIso}`,
    `Total reports in window: ${uploads.length}`,
    `Attached as CSV: ${attachments.length}`,
    ""
  ];

  if (skipped.length) {
    bodyLines.push("Not attached (parse error, no data, or size limit):");
    skipped.forEach((item) => bodyLines.push(`  - ${item}`));
  }

  const toRecipients = recipients.map((address) => ({
    emailAddress: {
      address
    }
  }));

  await graphPostJson(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(O365_SENDER)}/sendMail`,
    accessToken,
    {
      message: {
        subject,
        body: {
          contentType: "Text",
          content: bodyLines.join("\n")
        },
        toRecipients,
        ...(attachments.length ? { attachments } : {})
      },
      saveToSentItems: true
    }
  );
}

async function sendGilbarcoMonthEndEmail(recipients, monthKey, compiledReports, skipped = []) {
  const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
  const accessToken = await getGraphAccessToken();
  const attachments = [];
  const attachmentSkipped = skipped.slice();
  let totalAttachmentBytes = 0;

  for (const report of compiledReports) {
    const csvBytes = Buffer.byteLength(report.csvContent, "utf8");
    if (totalAttachmentBytes + csvBytes > MAX_ATTACHMENT_BYTES) {
      attachmentSkipped.push(`${report.endpointSlug} (size limit reached)`);
      continue;
    }

    totalAttachmentBytes += csvBytes;
    attachments.push({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: `${safeAttachmentBase(report.endpointName || report.endpointSlug)}-${report.month}-month-end.csv`,
      contentType: "text/csv",
      contentBytes: Buffer.from(report.csvContent, "utf8").toString("base64")
    });
  }

  const bodyLines = [
    `Synchro Gilbarco month-end report for ${formatMonthLabel(monthKey)}`,
    "",
    `Compiled endpoints: ${compiledReports.length}`,
    `Attached reports: ${attachments.length}`,
    ""
  ];

  if (attachmentSkipped.length) {
    bodyLines.push("Not attached:");
    attachmentSkipped.forEach((item) => bodyLines.push(`  - ${item}`));
  }

  const toRecipients = recipients.map((address) => ({
    emailAddress: {
      address
    }
  }));

  await graphPostJson(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(O365_SENDER)}/sendMail`,
    accessToken,
    {
      message: {
        subject: `Synchro Gilbarco Month-End Report (${formatMonthLabel(monthKey)})`,
        body: {
          contentType: "Text",
          content: bodyLines.join("\n")
        },
        toRecipients,
        ...(attachments.length ? { attachments } : {})
      },
      saveToSentItems: true
    }
  );
}

async function getGraphAccessToken() {
  const tenantId = String(process.env.SYNCHRO_GRAPH_TENANT_ID || "").trim();
  const clientId = String(process.env.SYNCHRO_GRAPH_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.SYNCHRO_GRAPH_CLIENT_SECRET || "").trim();

  const looksLikePlaceholder = (value) => {
    const normalized = String(value || "").toLowerCase();
    return normalized.includes("your-") || normalized.includes("placeholder") || normalized.includes("changeme");
  };

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Missing Graph app auth settings. Set SYNCHRO_GRAPH_TENANT_ID, SYNCHRO_GRAPH_CLIENT_ID, and SYNCHRO_GRAPH_CLIENT_SECRET."
    );
  }

  if (looksLikePlaceholder(tenantId) || looksLikePlaceholder(clientId) || looksLikePlaceholder(clientSecret)) {
    throw new Error(
      "Graph app auth settings still contain placeholder values. Update SYNCHRO_GRAPH_TENANT_ID, SYNCHRO_GRAPH_CLIENT_ID, and SYNCHRO_GRAPH_CLIENT_SECRET in .env."
    );
  }

  const form = new URLSearchParams();
  form.set("client_id", clientId);
  form.set("client_secret", clientSecret);
  form.set("scope", GRAPH_SCOPE);
  form.set("grant_type", "client_credentials");

  const tokenResponse = await fetchWithTimeout(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    }
  );

  const tokenJson = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenJson.access_token) {
    const graphMessage =
      (tokenJson && (tokenJson.error_description || tokenJson.error)) ||
      "No error details returned by token endpoint.";
    throw new Error(`Could not get Graph access token (${tokenResponse.status}): ${graphMessage}`);
  }

  return tokenJson.access_token;
}

async function graphPostJson(url, accessToken, body) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (response.ok) {
    return;
  }

  const responseText = await response.text().catch(() => "");
  throw new Error(`Graph sendMail failed (${response.status}): ${responseText || "No response body"}`);
}

// ---------------------------------------------------------------------------
// Server-side CSV builders (mirrors admin-client.js browser equivalents)
// ---------------------------------------------------------------------------

function escapeCsv(value) {
  const text = String(value == null ? "" : value);
  if (/[",\n\r]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function matchesHeaders(actualHeaders, expectedHeaders) {
  if (actualHeaders.length !== expectedHeaders.length) {
    return false;
  }
  const normalize = (v) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
  return expectedHeaders.every((h, i) => normalize(actualHeaders[i]) === normalize(h));
}

function buildGilbarcoCsv(report) {
  const fuelSection = report.sections.find((s) =>
    matchesHeaders(s.headers, ["Grade", "Grade Name", "Volume", "Sales", "% of Total Fuel Sales"])
  );
  const categorySection = report.sections.find((s) =>
    matchesHeaders(s.headers, [
      "Department", "Gross Sales", "Item Count", "Refund Count",
      "Net Count", "Refund $", "Discount $", "Net Sales", "% of Sales"
    ])
  );
  const pluSection = report.sections.find((s) =>
    matchesHeaders(s.headers, [
      "PLU No.", "Pkg. Qty", "Description", "Department",
      "Count", "Price", "Sales", "% of Dept", "% of Total"
    ])
  );

  if (!fuelSection && !categorySection && !pluSection) {
    return "";
  }

  const headers = [
    "section", "code", "name", "description", "department",
    "volume", "count", "price", "sales", "gross sales",
    "item count", "refund count", "net count", "refund $", "discount $",
    "net sales", "% of sales", "% of dept", "% of total fuel sales", "% of total"
  ];
  const lines = [headers.map(escapeCsv).join(",")];

  (fuelSection ? fuelSection.rows : []).forEach((row) => {
    lines.push([
      "fuel", row.Grade || "", row["Grade Name"] || "", "", "",
      row.Volume || "", "", "", row.Sales || "", "", "", "", "", "", "",
      "", "", "", row["% of Total Fuel Sales"] || "", ""
    ].map(escapeCsv).join(","));
  });

  (categorySection ? categorySection.rows : []).forEach((row) => {
    lines.push([
      "category", "", "", "", row.Department || "",
      "", "", "", "", row["Gross Sales"] || "",
      row["Item Count"] || "", row["Refund Count"] || "", row["Net Count"] || "",
      row["Refund $"] || "", row["Discount $"] || "", row["Net Sales"] || "",
      row["% of Sales"] || "", "", "", ""
    ].map(escapeCsv).join(","));
  });

  (pluSection ? pluSection.rows : []).forEach((row) => {
    lines.push([
      "plu", row["PLU No."] || "", "", row.Description || "", row.Department || "",
      "", row.Count || "", row.Price || "", row.Sales || "", "", "", "", "", "", "",
      "", "", row["% of Dept"] || "", "", row["% of Total"] || ""
    ].map(escapeCsv).join(","));
  });

  return lines.join("\n") + "\n";
}

function buildVerifoneCsv(report) {
  const departmentSection = report.sections.find((s) =>
    matchesHeaders(s.headers, [
      "Dept#", "Description", "Cust#", "Items",
      "% of Sales", "Gross", "Refunds", "Discounts", "Net Sales"
    ])
  );
  const pluSection = report.sections.find((s) =>
    matchesHeaders(s.headers, [
      "PLU Number", "Description", "Price", "Cust", "Items",
      "Tot Sales", "%Sales", "Reason Code", "Promotion ID"
    ])
  );
  const summarySections = report.sections.filter((s) =>
    matchesHeaders(s.headers, ["Category", "Count", "Amount"])
  );
  const dispenserRows = collectVerifoneDispenserRows(report.sections);

  if (!departmentSection && !pluSection && !summarySections.length && !dispenserRows.length) {
    return "";
  }

  const headers = [
    "section", "department", "plu", "description", "position", "category", "customers", "items",
    "% of sale", "gross", "refunds", "discounts", "net sales",
    "price", "reason code", "promotion id", "count", "volume", "amount"
  ];
  const lines = [headers.map(escapeCsv).join(",")];

  (departmentSection ? departmentSection.rows : [])
    .filter((row) => /^\d+$/.test(String(row["Dept#"] || "").trim()))
    .forEach((row) => {
      lines.push([
        "department", row["Dept#"] || "", "", row.Description || "", "", "",
        row["Cust#"] || "", row.Items || "", row["% of Sales"] || "",
        row.Gross || "", row.Refunds || "", row.Discounts || "", row["Net Sales"] || "",
        "", "", "", "", "", ""
      ].map(escapeCsv).join(","));
    });

  dispenserRows.forEach((row) => {
    lines.push([
      "dispenser", "", "", row.Product || "", row.Position || "", "",
      "", "", "",
      "", "", "", "",
      "", "", "", row["# of Sales"] || "", row.Volume || "", row.Amount || ""
    ].map(escapeCsv).join(","));
  });

  summarySections.forEach((summarySection, index) => {
    const sectionLabel = summarySections.length > 1
      ? `summary_${index + 1}`
      : "summary";
    summarySection.rows.forEach((row) => {
      lines.push([
        sectionLabel, "", "", "", "", row.Category || "",
        "", "", "",
        "", "", "", "",
        "", "", "", row.Count || "", "", row.Amount || ""
      ].map(escapeCsv).join(","));
    });
  });

  (pluSection ? pluSection.rows : []).forEach((row) => {
    lines.push([
      "plu", "", row["PLU Number"] || "", row.Description || "", "", "",
      row.Cust || "", row.Items || "", row["%Sales"] || "",
      "", "", "", row["Tot Sales"] || "", row.Price || "",
      row["Reason Code"] || "", row["Promotion ID"] || "", "", "", ""
    ].map(escapeCsv).join(","));
  });

  return lines.join("\n") + "\n";
}

function collectVerifoneDispenserRows(sections) {
  const startIndex = sections.findIndex((section) =>
    matchesHeaders(section.headers, ["Product", "# of Sales", "Volume", "Amount", "Fueling Position 1"])
  );

  if (startIndex === -1) {
    return [];
  }

  const rows = [];
  for (let index = startIndex; index < sections.length; index += 1) {
    const section = sections[index];
    const title = String(section.title || "").trim();

    if (index === startIndex) {
      const positionLabel = String(section.headers[4] || "").trim() || "Fueling Position 1";
      section.rows.forEach((row) => {
        rows.push({
          Position: positionLabel,
          Product: row.Product || "",
          "# of Sales": row["# of Sales"] || "",
          Volume: row.Volume || "",
          Amount: row.Amount || ""
        });
      });
      continue;
    }

    if (!/^fueling position \d+$/i.test(title) && !/^product totals$/i.test(title)) {
      break;
    }

    section.rows.forEach((row) => {
      rows.push({
        Position: title,
        Product: row.Col1 || "",
        "# of Sales": row.Col2 || "",
        Volume: row.Col3 || "",
        Amount: row.Col4 || ""
      });
    });
  }

  return rows;
}

function buildGenericCsv(report) {
  const section = report.sections.find((s) => s.rows && s.rows.length);
  if (!section) {
    return "";
  }
  const headers = section.headers && section.headers.length
    ? section.headers
    : Object.keys(section.rows[0] || {});
  const lines = [headers.map(escapeCsv).join(",")];
  section.rows.forEach((row) => {
    lines.push(headers.map((h) => escapeCsv(row[h] == null ? "" : row[h])).join(","));
  });
  return lines.join("\n") + "\n";
}

function buildReportCsv(report) {
  return buildVerifoneCsv(report) || buildGilbarcoCsv(report) || buildGenericCsv(report);
}

// ---------------------------------------------------------------------------

module.exports = {
  startReportEmailDigestScheduler,
  sendReportDigestTest,
  sendParsedCsvEmail
};
