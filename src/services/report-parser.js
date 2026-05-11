"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

function parseHtmlReportFile(filePath, options = {}) {
  const html = readHtmlFile(filePath);
  const rows = extractRowBlocks(html);
  const metadata = extractReportMetadata(html, filePath);
  const sections = extractGenericSections(rows, options);

  return {
    sourceFile: filePath,
    reportTitle: metadata.reportTitle,
    reportType: inferReportType(metadata.reportTitle),
    storeNumber: metadata.storeNumber,
    periodLabel: metadata.periodLabel,
    openPeriod: metadata.openPeriod,
    closePeriod: metadata.closePeriod,
    scopeLabel: metadata.scopeLabel,
    sections
  };
}

function parsePdfReportFile(filePath) {
  const scriptPath = path.resolve(__dirname, "..", "pdf_report_parser.py");
  const stdout = childProcess.execFileSync("python", [scriptPath, filePath], {
    cwd: path.resolve(__dirname, "..", ".."),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

function parseReportFile(filePath, options = {}) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") {
    return parsePdfReportFile(filePath);
  }
  if (extension === ".html" || extension === ".htm") {
    return parseHtmlReportFile(filePath, options);
  }
  throw new Error(`Unsupported report type: ${extension || "unknown"}`);
}

function parseCategoryReportFile(filePath) {
  const parsedReport = parseHtmlReportFile(filePath, { maxRowsPerSection: Number.POSITIVE_INFINITY });
  const categorySection = parsedReport.sections.find((section) => {
    const normalizedHeaders = section.headers.map(normalizeLabel);
    return normalizedHeaders.includes("cat#") && normalizedHeaders.includes("description");
  });

  if (!categorySection) {
    throw new Error("Could not find the category table in the HTML report.");
  }

  return categorySection.rows
    .filter((row) => /^\d+$/.test(String(row["Cat#"] || row.Col1 || "").trim()))
    .map((row) => ({
      sourceFile: filePath,
      reportTitle: parsedReport.reportTitle,
      storeNumber: parsedReport.storeNumber,
      periodLabel: parsedReport.periodLabel,
      openPeriod: parsedReport.openPeriod,
      closePeriod: parsedReport.closePeriod,
      scopeLabel: parsedReport.scopeLabel,
      categoryNumber: row["Cat#"] || row.Col1 || "",
      description: row.Description || row.Col2 || "",
      customerCount: row["Cust#"] || row.Col3 || "",
      items: row.Items || row.Col4 || "",
      percentOfSales: row["% of Sales"] || row.Col5 || "",
      netSales: row["Net Sales"] || row.Col6 || ""
    }));
}

function collectCategoryReportFiles(inputPath) {
  const resolvedPath = path.resolve(inputPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Input path not found: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (stats.isFile()) {
    return [resolvedPath];
  }

  return walkDirectoryForCategoryReports(resolvedPath);
}

function walkDirectoryForCategoryReports(directoryPath) {
  const matches = [];
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      matches.push(...walkDirectoryForCategoryReports(fullPath));
      continue;
    }

    if (/^category\.html?$/i.test(entry.name)) {
      matches.push(fullPath);
    }
  }

  matches.sort((a, b) => a.localeCompare(b));
  return matches;
}

function buildCategoryCsv(records) {
  const headers = [
    "sourceFile",
    "reportTitle",
    "storeNumber",
    "periodLabel",
    "openPeriod",
    "closePeriod",
    "scopeLabel",
    "categoryNumber",
    "description",
    "customerCount",
    "items",
    "percentOfSales",
    "netSales"
  ];

  const lines = [headers.join(",")];
  for (const record of records) {
    lines.push(headers.map((header) => escapeCsvValue(record[header] || "")).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function readHtmlFile(filePath) {
  const buffer = fs.readFileSync(filePath);

  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return buffer.slice(2).toString("utf16le");
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return swap16(buffer.slice(2)).toString("utf16le");
    }
  }

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.slice(3).toString("utf8");
  }

  return buffer.toString("utf8");
}

function swap16(buffer) {
  const clone = Buffer.from(buffer);
  clone.swap16();
  return clone;
}

function extractReportMetadata(html, filePath) {
  return {
    reportTitle: firstMatch(html, /<title>([\s\S]*?)<\/title>/i),
    storeNumber: firstMatch(html, /Store Number:\s*([^<\r\n]+)/i),
    periodLabel: extractPeriodLabel(html),
    openPeriod: extractLabeledValue(html, "Open Period"),
    closePeriod: extractLabeledValue(html, "Close Period"),
    scopeLabel: extractScopeLabel(html),
    filePath
  };
}

function extractGenericSections(rows, options = {}) {
  const maxRowsPerSection = Number.isFinite(options.maxRowsPerSection)
    ? options.maxRowsPerSection
    : 500;
  const sections = [];
  let parsingStarted = false;
  let pendingTitle = "";
  let currentSection = null;
  let lastHeaders = null;
  let tableCounter = 1;

  for (const row of rows) {
    const compactCells = row.cells.filter(Boolean);
    if (!compactCells.length) {
      continue;
    }

    const firstCellLabel = normalizeLabel(compactCells[0]);

    if (firstCellLabel === "period information") {
      currentSection = null;
      pendingTitle = "";
      continue;
    }

    if (!parsingStarted) {
      if (firstCellLabel === "close period") {
        parsingStarted = true;
      }
      continue;
    }

    if (isSectionTitleRow(row, compactCells)) {
      if (!shouldIgnoreTitle(compactCells[0])) {
        pendingTitle = compactCells[0];
      }
      currentSection = null;
      continue;
    }

    if (isHeaderRow(row, compactCells)) {
      lastHeaders = compactCells;
      currentSection = {
        title: pendingTitle || `Table ${tableCounter}`,
        headers: compactCells,
        rows: [],
        totalRows: 0,
        truncated: false
      };
      sections.push(currentSection);
      tableCounter += 1;
      pendingTitle = "";
      continue;
    }

    if (!currentSection) {
      const inferredHeaders = lastHeaders && lastHeaders.length === compactCells.length
        ? lastHeaders
        : compactCells.map((_, index) => `Col${index + 1}`);
      currentSection = {
        title: pendingTitle || `Table ${tableCounter}`,
        headers: inferredHeaders,
        rows: [],
        totalRows: 0,
        truncated: false
      };
      sections.push(currentSection);
      tableCounter += 1;
      pendingTitle = "";
    }

    currentSection.totalRows += 1;
    if (currentSection.rows.length < maxRowsPerSection) {
      currentSection.rows.push(rowToObject(currentSection.headers, compactCells));
    } else {
      currentSection.truncated = true;
    }
  }

  return sections.filter((section) => section.headers.length || section.rows.length);
}

function rowToObject(headers, cells) {
  const record = {};
  for (let index = 0; index < headers.length; index += 1) {
    record[headers[index]] = cells[index] || "";
  }
  return record;
}

function extractRowBlocks(html) {
  const rowHtmlBlocks = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  return rowHtmlBlocks.map((rowHtml) => ({
    html: rowHtml,
    cells: extractCells(rowHtml)
  }));
}

function extractCells(rowHtml) {
  const cellMatches = rowHtml.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
  return cellMatches.map((cellHtml) => decodeHtmlEntities(stripTags(cellHtml)).replace(/\s+/g, " ").trim());
}

function isHeaderRow(row, compactCells) {
  if (compactCells.length < 2) {
    return false;
  }

  if (/\b(bgcolor\s*=\s*"?#?3366cc"?|font color\s*=\s*"?#?ffffff"?)/i.test(row.html)) {
    return true;
  }

  return compactCells.every((cell) => !looksNumeric(cell)) && !compactCells.some(isLikelyDetailLine);
}

function isSectionTitleRow(row, compactCells) {
  if (compactCells.length !== 1) {
    return false;
  }

  if (isLikelyDetailLine(compactCells[0])) {
    return false;
  }

  return /<b>[\s\S]*?<\/b>/i.test(row.html) || /\bsize\s*=\s*"3"/i.test(row.html);
}

function isLikelyDetailLine(value) {
  const normalized = normalizeLabel(value);
  return normalized.startsWith("receipt #") || normalized === "totals" || looksNumeric(value);
}

function shouldIgnoreTitle(value) {
  const normalized = normalizeLabel(value);
  return normalized === "period information" || normalized === "totals" || normalized === "all dcrs";
}

function looksNumeric(value) {
  return /^\(?-?[\d,]+(?:\.\d+)?%?\)?$/.test(String(value).trim());
}

function inferReportType(title) {
  const normalized = normalizeLabel(title);
  if (!normalized) {
    return "report";
  }
  if (normalized.includes("category")) {
    return "category";
  }
  if (normalized.includes("department")) {
    return "department";
  }
  if (normalized.includes("summary")) {
    return "summary";
  }
  if (normalized.includes("tax")) {
    return "tax";
  }
  if (normalized.includes("dispenser")) {
    return "fuel_dispenser";
  }
  if (normalized.includes("tank monitor")) {
    return "tank_monitor";
  }
  if (normalized.includes("plu")) {
    return "plu";
  }
  return normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "report";
}

function extractPeriodLabel(html) {
  const periodMatch = html.match(/<td\b[^>]*>\s*Period\s*<\/td>[\s\S]*?<td\b[^>]*>([\s\S]*?)<\/td>/i);
  if (!periodMatch) {
    return "";
  }
  return decodeHtmlEntities(stripTags(periodMatch[1])).replace(/\s+/g, " ").trim();
}

function extractLabeledValue(html, label) {
  const escapedLabel = escapeRegExp(label);
  const match = html.match(new RegExp(`<td\\b[^>]*>\\s*${escapedLabel}\\s*<\\/td>[\\s\\S]*?<td\\b[^>]*>([\\s\\S]*?)<\\/td>`, "i"));
  if (!match) {
    return "";
  }
  return decodeHtmlEntities(stripTags(match[1])).replace(/\s+/g, " ").trim();
}

function extractScopeLabel(html) {
  const bodyMatch = html.match(/<\/table><br><table[\s\S]*?<font\b[^>]*><b>([\s\S]*?)<\/b><\/font>/i);
  if (!bodyMatch) {
    return "";
  }
  return decodeHtmlEntities(stripTags(bodyMatch[1])).replace(/\s+/g, " ").trim();
}

function firstMatch(html, regex) {
  const match = html.match(regex);
  return match ? decodeHtmlEntities(stripTags(match[1])).replace(/\s+/g, " ").trim() : "";
}

function stripTags(value) {
  return String(value).replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeLabel(value) {
  return String(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeCsvValue(value) {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  parseReportFile,
  parseHtmlReportFile,
  parsePdfReportFile,
  parseCategoryReportFile,
  collectCategoryReportFiles,
  buildCategoryCsv
};
