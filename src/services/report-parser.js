"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

function parseHtmlReportFile(filePath, options = {}) {
  const html = readHtmlFile(filePath);
  const rows = extractRowBlocks(html);
  const metadata = extractReportMetadata(html, filePath, rows);
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

function listGilbarcoReportMonths(rootPath) {
  const monthlyBuckets = new Map();

  collectFilesRecursively(rootPath).forEach((filePath) => {
    if (path.extname(filePath).toLowerCase() !== ".pdf") {
      return;
    }

    const monthKey = inferMonthKeyFromGilbarcoFilename(path.basename(filePath));
    if (!monthKey) {
      return;
    }

    if (!monthlyBuckets.has(monthKey)) {
      monthlyBuckets.set(monthKey, []);
    }
    monthlyBuckets.get(monthKey).push(filePath);
  });

  return Array.from(monthlyBuckets.entries())
    .map(([month, files]) => ({
      month,
      label: formatMonthLabel(month),
      reportCount: files.length
    }))
    .sort((left, right) => right.month.localeCompare(left.month));
}

function combineGilbarcoReportFiles(pdfFiles, titleOverride = "", labelOverride = "") {
  if (!Array.isArray(pdfFiles) || !pdfFiles.length) {
    throw new Error("At least one PDF file must be provided.");
  }

  const validPdfFiles = pdfFiles
    .map((file) => String(file).trim())
    .filter((file) => file && path.extname(file).toLowerCase() === ".pdf");

  if (!validPdfFiles.length) {
    throw new Error("No valid PDF files were provided.");
  }

  const fuelTotals = new Map();
  const departmentTotals = new Map();
  const pluTotals = new Map();
  const parsedReports = validPdfFiles.map((filePath) => parsePdfReportFile(filePath));

  parsedReports.forEach((report) => {
    const fuelSection = findSectionByHeaders(report.sections, [
      "Grade",
      "Grade Name",
      "Volume",
      "Sales",
      "% of Total Fuel Sales"
    ]);
    const categorySection = findSectionByHeaders(report.sections, [
      "Department",
      "Gross Sales",
      "Item Count",
      "Refund Count",
      "Net Count",
      "Refund $",
      "Discount $",
      "Net Sales",
      "% of Sales"
    ]);
    const pluSection = findSectionByHeaders(report.sections, [
      "PLU No.",
      "Pkg. Qty",
      "Description",
      "Department",
      "Count",
      "Price",
      "Sales",
      "% of Dept",
      "% of Total"
    ]);

    if (fuelSection) {
      fuelSection.rows.forEach((row) => {
        const key = [row.Grade || "", row["Grade Name"] || ""].join("|");
        const aggregate = getOrCreateAggregate(fuelTotals, key, () => ({
          Grade: row.Grade || "",
          "Grade Name": row["Grade Name"] || "",
          Volume: 0,
          Sales: 0
        }));
        aggregate.Volume += parseNumber(row.Volume);
        aggregate.Sales += parseCurrencyValue(row.Sales);
      });
    }

    if (categorySection) {
      categorySection.rows.forEach((row) => {
        const key = row.Department || "";
        const aggregate = getOrCreateAggregate(departmentTotals, key, () => ({
          Department: row.Department || "",
          "Gross Sales": 0,
          "Item Count": 0,
          "Refund Count": 0,
          "Net Count": 0,
          "Refund $": 0,
          "Discount $": 0,
          "Net Sales": 0
        }));
        aggregate["Gross Sales"] += parseCurrencyValue(row["Gross Sales"]);
        aggregate["Item Count"] += parseIntegerValue(row["Item Count"]);
        aggregate["Refund Count"] += parseIntegerValue(row["Refund Count"]);
        aggregate["Net Count"] += parseIntegerValue(row["Net Count"]);
        aggregate["Refund $"] += parseCurrencyValue(row["Refund $"]);
        aggregate["Discount $"] += parseCurrencyValue(row["Discount $"]);
        aggregate["Net Sales"] += parseCurrencyValue(row["Net Sales"]);
      });
    }

    if (pluSection) {
      pluSection.rows.forEach((row) => {
        const key = [
          row["PLU No."] || "",
          row["Pkg. Qty"] || "",
          row.Description || "",
          row.Department || "",
          row.Price || ""
        ].join("|");
        const aggregate = getOrCreateAggregate(pluTotals, key, () => ({
          "PLU No.": row["PLU No."] || "",
          "Pkg. Qty": row["Pkg. Qty"] || "",
          "Description": row.Description || "",
          "Department": row.Department || "",
          "Count": 0,
          "Price": row.Price || "",
          "Sales": 0
        }));
        aggregate.Count += parseIntegerValue(row.Count);
        aggregate.Sales += parseCurrencyValue(row.Sales);
      });
    }
  });

  const totalFuelSales = sumAggregateValues(fuelTotals, "Sales");
  const totalDepartmentNetSales = sumAggregateValues(departmentTotals, "Net Sales");
  const departmentNetByName = new Map(
    Array.from(departmentTotals.values()).map((entry) => [entry.Department, entry["Net Sales"]])
  );
  const totalPluSales = sumAggregateValues(pluTotals, "Sales");

  const fuelRows = Array.from(fuelTotals.values())
    .sort((left, right) => left.Grade.localeCompare(right.Grade))
    .map((row) => ({
      Grade: row.Grade,
      "Grade Name": row["Grade Name"],
      Volume: formatVolume(row.Volume),
      Sales: formatCurrency(row.Sales),
      "% of Total Fuel Sales": formatPercent(totalFuelSales ? (row.Sales / totalFuelSales) * 100 : 0)
    }));

  const departmentRows = Array.from(departmentTotals.values())
    .sort((left, right) => left.Department.localeCompare(right.Department))
    .map((row) => ({
      Department: row.Department,
      "Gross Sales": formatCurrency(row["Gross Sales"]),
      "Item Count": formatInteger(row["Item Count"]),
      "Refund Count": formatInteger(row["Refund Count"]),
      "Net Count": formatInteger(row["Net Count"]),
      "Refund $": formatCurrency(row["Refund $"]),
      "Discount $": formatCurrency(row["Discount $"]),
      "Net Sales": formatCurrency(row["Net Sales"]),
      "% of Sales": formatPercent(totalDepartmentNetSales ? (row["Net Sales"] / totalDepartmentNetSales) * 100 : 0)
    }));

  const pluRows = Array.from(pluTotals.values())
    .sort((left, right) => comparePluRows(left, right))
    .map((row) => {
      const departmentNetSales = departmentNetByName.get(row.Department) || 0;
      return {
        "PLU No.": row["PLU No."],
        "Pkg. Qty": row["Pkg. Qty"],
        "Description": row.Description,
        "Department": row.Department,
        "Count": formatInteger(row.Count),
        "Price": row.Price,
        "Sales": formatCurrency(row.Sales),
        "% of Dept": formatPercent(departmentNetSales ? (row.Sales / departmentNetSales) * 100 : 0),
        "% of Total": formatPercent(totalPluSales ? (row.Sales / totalPluSales) * 100 : 0)
      };
    });

  const referenceReport = parsedReports[0];
  const displayTitle = titleOverride || "Gilbarco Combined Report";
  const displayLabel = labelOverride || "Combined";
  
  return {
    sourceFile: "",
    reportTitle: displayTitle,
    reportType: "gilbarco_monthly_report",
    storeNumber: referenceReport.storeNumber || "",
    periodLabel: displayLabel,
    openPeriod: parsedReports[0].openPeriod || "",
    closePeriod: parsedReports[parsedReports.length - 1].closePeriod || "",
    scopeLabel: referenceReport.scopeLabel || "",
    sourceReportCount: validPdfFiles.length,
    sourceFiles: validPdfFiles.map((filePath) => path.basename(filePath)),
    sections: [
      {
        title: "Gasoline Grade",
        headers: [
          "Grade",
          "Grade Name",
          "Volume",
          "Sales",
          "% of Total Fuel Sales"
        ],
        rows: fuelRows,
        totalRows: fuelRows.length,
        truncated: false
      },
      {
        title: "Category",
        headers: [
          "Department",
          "Gross Sales",
          "Item Count",
          "Refund Count",
          "Net Count",
          "Refund $",
          "Discount $",
          "Net Sales",
          "% of Sales"
        ],
        rows: departmentRows,
        totalRows: departmentRows.length,
        truncated: false
      },
      {
        title: "PLU",
        headers: [
          "PLU No.",
          "Pkg. Qty",
          "Description",
          "Department",
          "Count",
          "Price",
          "Sales",
          "% of Dept",
          "% of Total"
        ],
        rows: pluRows,
        totalRows: pluRows.length,
        truncated: false
      }
    ]
  };
}

function parseMonthlyGilbarcoReport(rootPath, monthKey) {
  const normalizedMonth = String(monthKey || "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalizedMonth)) {
    throw new Error("A month in YYYY-MM format is required.");
  }

  const pdfFiles = collectFilesRecursively(rootPath)
    .filter((filePath) => path.extname(filePath).toLowerCase() === ".pdf")
    .filter((filePath) => inferMonthKeyFromGilbarcoFilename(path.basename(filePath)) === normalizedMonth)
    .sort((left, right) => left.localeCompare(right));

  if (!pdfFiles.length) {
    throw new Error(`No Gilbarco PDF reports were found for ${normalizedMonth}.`);
  }

  const combined = combineGilbarcoReportFiles(
    pdfFiles,
    `${formatMonthLabel(normalizedMonth)} Gilbarco Monthly Report`,
    formatMonthLabel(normalizedMonth)
  );

  return {
    ...combined,
    sourceFile: rootPath,
    month: normalizedMonth,
    sourceFiles: pdfFiles.map((filePath) => path.relative(rootPath, filePath).replace(/\\/g, "/"))
  };
}

function parseManualGilbarcoReport(rootPath, pdfFilenames) {
  if (!Array.isArray(pdfFilenames) || !pdfFilenames.length) {
    throw new Error("At least one PDF filename must be provided.");
  }

  const endpointDir = path.join(rootPath);
  if (!fs.existsSync(endpointDir) || !fs.statSync(endpointDir).isDirectory()) {
    throw new Error("Endpoint directory not found.");
  }

  const resolvedPaths = pdfFilenames.map((filename) => {
    const normalized = String(filename).trim();
    const fullPath = path.join(endpointDir, normalized);
    
    // Verify the path is within the endpoint directory (prevent directory traversal)
    const resolved = path.resolve(fullPath);
    const resolvedDir = path.resolve(endpointDir);
    if (!resolved.startsWith(resolvedDir)) {
      throw new Error(`Invalid file path: ${normalized}`);
    }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`File not found: ${normalized}`);
    }

    if (path.extname(resolved).toLowerCase() !== ".pdf") {
      throw new Error(`Not a PDF file: ${normalized}`);
    }

    return resolved;
  });

  const combined = combineGilbarcoReportFiles(
    resolvedPaths,
    "Gilbarco Manual Selection Report",
    "Manual Selection"
  );

  return {
    ...combined,
    sourceFile: rootPath,
    sourceFiles: pdfFilenames.map((f) => String(f).trim())
  };
}

function listPdfFilesInEndpoint(rootPath) {
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    return [];
  }

  const allFiles = collectFilesRecursively(rootPath);
  return allFiles
    .filter((filePath) => path.extname(filePath).toLowerCase() === ".pdf")
    .map((filePath) => path.relative(rootPath, filePath).replace(/\\/g, "/"))
    .sort((a, b) => a.localeCompare(b));
}

function parseVerifoneReportDirectory(directoryPath) {
  const nestedSourceDirectory = findNestedVerifoneSourceDirectory(directoryPath);
  if (nestedSourceDirectory) {
    const nestedReport = parseVerifoneReportDirectory(nestedSourceDirectory);
    return {
      ...nestedReport,
      sourceFile: directoryPath,
      sourceDirectory: nestedSourceDirectory
    };
  }

  const htmlFiles = fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (!htmlFiles.length) {
    throw new Error("No HTML reports were found in this folder.");
  }

  const departmentPath = findReportFileInDirectory(directoryPath, "department");
  const pluPath = findReportFileInDirectory(directoryPath, "plu");

  const departmentReport = departmentPath
    ? parseHtmlReportFile(departmentPath, { maxRowsPerSection: Number.POSITIVE_INFINITY })
    : null;
  const pluReport = pluPath
    ? parseHtmlReportFile(pluPath, { maxRowsPerSection: Number.POSITIVE_INFINITY })
    : null;

  const baseReport = departmentReport || pluReport;
  if (baseReport) {
    const sections = [];
    const departmentSection = departmentReport
      ? findSectionByHeaders(departmentReport.sections, [
          "Dept#",
          "Description",
          "Cust#",
          "Items",
          "% of Sales",
          "Gross",
          "Refunds",
          "Discounts",
          "Net Sales"
        ]) || departmentReport.sections.find((section) => section.rows.length) || null
      : null;
    if (departmentSection) {
      sections.push({
        ...departmentSection,
        title: "Department"
      });
    }

    const pluSection = pluReport
      ? findSectionByHeaders(pluReport.sections, [
          "PLU Number",
          "Description",
          "Price",
          "Cust",
          "Items",
          "Tot Sales",
          "%Sales",
          "Reason Code",
          "Promotion ID"
        ]) || pluReport.sections.find((section) => section.rows.length) || null
      : null;
    if (pluSection) {
      sections.push({
        ...pluSection,
        title: "PLU"
      });
    }

    if (!sections.length) {
      throw new Error("Could not find a Department.html or PLU.html report in this folder.");
    }

    return {
      sourceFile: directoryPath,
      reportTitle: `${path.basename(directoryPath)} Verifone Reports`,
      reportType: "verifone_report_bundle",
      storeNumber: baseReport.storeNumber,
      periodLabel: baseReport.periodLabel,
      openPeriod: baseReport.openPeriod,
      closePeriod: baseReport.closePeriod,
      scopeLabel: baseReport.scopeLabel,
      sections
    };
  }

  const bundledReportPath = findBundledVerifoneReportFile(directoryPath);
  if (!bundledReportPath) {
    throw new Error("Could not find a Department.html or PLU.html report in this folder.");
  }

  const bundledReport = parseHtmlReportFile(bundledReportPath, {
    maxRowsPerSection: Number.POSITIVE_INFINITY
  });
  const bundledSections = collectBundledVerifoneSections(bundledReport);
  const reportTitle = buildVerifoneDirectoryReportTitle(directoryPath, bundledReport);

  return {
    sourceFile: directoryPath,
    sourceFiles: [path.basename(bundledReportPath)],
    reportTitle,
    reportType: "verifone_report_bundle",
    storeNumber: bundledReport.storeNumber,
    periodLabel: bundledReport.periodLabel,
    openPeriod: bundledReport.openPeriod,
    closePeriod: bundledReport.closePeriod,
    scopeLabel: bundledReport.scopeLabel,
    sections: bundledSections
  };
}

function parseReportFile(filePath, options = {}) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    return parseVerifoneReportDirectory(filePath);
  }
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

function collectFilesRecursively(inputPath) {
  const stats = fs.statSync(inputPath);
  if (stats.isFile()) {
    return [inputPath];
  }

  const files = [];
  fs.readdirSync(inputPath, { withFileTypes: true }).forEach((entry) => {
    const fullPath = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFilesRecursively(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  });
  return files;
}

function findReportFileInDirectory(directoryPath, baseName) {
  const targetName = `${baseName}.html`;
  const targetAltName = `${baseName}.htm`;
  const match = fs.readdirSync(directoryPath, { withFileTypes: true }).find((entry) => {
    if (!entry.isFile()) {
      return false;
    }
    const normalized = entry.name.toLowerCase();
    return normalized === targetName || normalized === targetAltName;
  });
  return match ? path.join(directoryPath, match.name) : "";
}

function findNestedVerifoneSourceDirectory(directoryPath) {
  const candidateNames = ["DR", "MR"];
  for (const candidateName of candidateNames) {
    const candidatePath = path.join(directoryPath, candidateName);
    if (directoryHasHtmlFiles(candidatePath)) {
      return candidatePath;
    }
  }
  return "";
}

function directoryHasHtmlFiles(directoryPath) {
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    return false;
  }

  return fs.readdirSync(directoryPath, { withFileTypes: true }).some((entry) => (
    entry.isFile() && /\.html?$/i.test(entry.name)
  ));
}

function findBundledVerifoneReportFile(directoryPath) {
  const htmlFiles = fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => compareBundledVerifoneFilenames(left, right));

  return htmlFiles.length ? path.join(directoryPath, htmlFiles[0]) : "";
}

function compareBundledVerifoneFilenames(left, right) {
  const scoreDiff = scoreBundledVerifoneFilename(right) - scoreBundledVerifoneFilename(left);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }
  return left.localeCompare(right);
}

function scoreBundledVerifoneFilename(filename) {
  const normalized = String(filename || "").toLowerCase();
  let score = 0;

  if (/^[a-z]{2}-\d{8}\.html?$/i.test(normalized)) {
    score += 400;
  } else if (/\d{8}/.test(normalized)) {
    score += 250;
  }

  if (/^(dr|mr)-/.test(normalized)) {
    score += 150;
  }

  if (!normalized.includes("test")) {
    score += 50;
  }

  if (!normalized.includes("_date")) {
    score += 25;
  }

  return score;
}

function collectBundledVerifoneSections(report) {
  const sections = [];
  const sectionSpecs = [
    {
      title: "Department",
      headers: [
        "Dept#",
        "Description",
        "Cust#",
        "Items",
        "% of Sales",
        "Gross",
        "Refunds",
        "Discounts",
        "Net Sales"
      ]
    },
    {
      title: "Summary",
      headers: [
        "Category",
        "Count",
        "Amount"
      ]
    },
    {
      title: "PLU",
      headers: [
        "PLU Number",
        "Description",
        "Price",
        "Cust",
        "Items",
        "Tot Sales",
        "%Sales",
        "Reason Code",
        "Promotion ID"
      ]
    }
  ];

  for (const spec of sectionSpecs) {
    const match = findSectionByHeaders(report.sections, spec.headers);
    if (match) {
      sections.push({
        ...match,
        title: spec.title
      });
    }
  }

  const dispenserSection = buildBundledVerifoneDispenserSection(report.sections);
  if (dispenserSection) {
    sections.splice(Math.min(1, sections.length), 0, dispenserSection);
  }

  if (sections.length) {
    return sections;
  }

  return report.sections.filter((section) => section.totalRows > 0);
}

function buildVerifoneDirectoryReportTitle(directoryPath, bundledReport) {
  const folderName = path.basename(directoryPath).toUpperCase();
  if (folderName === "DR") {
    return "Daily Verifone Reports";
  }
  if (folderName === "MR") {
    return "Monthly Verifone Reports";
  }

  const normalizedTitle = normalizeLabel(bundledReport.reportTitle);
  if (normalizedTitle && normalizedTitle !== "daily" && normalizedTitle !== "monthly report") {
    return bundledReport.reportTitle;
  }

  return `${path.basename(directoryPath)} Verifone Reports`;
}

function buildBundledVerifoneDispenserSection(sections) {
  const startIndex = sections.findIndex((section) => (
    section.headers.length === 5
      && normalizeLabel(section.headers[0]) === "product"
      && normalizeLabel(section.headers[1]) === "# of sales"
      && normalizeLabel(section.headers[2]) === "volume"
      && normalizeLabel(section.headers[3]) === "amount"
      && /^fueling position \d+$/i.test(String(section.headers[4] || ""))
  ));

  if (startIndex === -1) {
    return null;
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

  if (!rows.length) {
    return null;
  }

  return {
    title: "Dispenser",
    headers: ["Position", "Product", "# of Sales", "Volume", "Amount"],
    rows,
    totalRows: rows.length,
    truncated: false
  };
}

function inferMonthKeyFromGilbarcoFilename(filename) {
  const match = String(filename).match(/StoreClose(\d{4})(\d{2})\d{2}\d*/i);
  if (!match) {
    return "";
  }
  return `${match[1]}-${match[2]}`;
}

function formatMonthLabel(monthKey) {
  const match = String(monthKey).match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    return monthKey;
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
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
  return `${monthNames[monthIndex] || match[2]} ${year}`;
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

function extractReportMetadata(html, filePath, rows = []) {
  return {
    reportTitle: firstMatch(html, /<title>([\s\S]*?)<\/title>/i),
    storeNumber: firstMatch(html, /Store Number:\s*([^<\r\n]+)/i),
    periodLabel: extractPeriodLabel(rows, html),
    openPeriod: extractLabeledValue(rows, html, "Open Period"),
    closePeriod: extractLabeledValue(rows, html, "Close Period"),
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

function findSectionByHeaders(sections, expectedHeaders) {
  return sections.find((section) => matchesHeaders(section.headers, expectedHeaders)) || null;
}

function getOrCreateAggregate(map, key, createValue) {
  if (!map.has(key)) {
    map.set(key, createValue());
  }
  return map.get(key);
}

function sumAggregateValues(map, fieldName) {
  let total = 0;
  map.forEach((value) => {
    total += Number(value[fieldName] || 0);
  });
  return total;
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

function extractPeriodLabel(rows, html) {
  const rowValue = extractLabeledValueFromRows(rows, "Period");
  if (rowValue) {
    return rowValue;
  }

  const periodMatch = html.match(/<td\b[^>]*>\s*Period\s*<\/td>[\s\S]*?<td\b[^>]*>([\s\S]*?)<\/td>/i);
  if (!periodMatch) {
    return "";
  }
  return decodeHtmlEntities(stripTags(periodMatch[1])).replace(/\s+/g, " ").trim();
}

function extractLabeledValue(rows, html, label) {
  const rowValue = extractLabeledValueFromRows(rows, label);
  if (rowValue) {
    return rowValue;
  }

  const escapedLabel = escapeRegExp(label);
  const match = html.match(new RegExp(`<td\\b[^>]*>\\s*${escapedLabel}\\s*<\\/td>[\\s\\S]*?<td\\b[^>]*>([\\s\\S]*?)<\\/td>`, "i"));
  if (!match) {
    return "";
  }
  return decodeHtmlEntities(stripTags(match[1])).replace(/\s+/g, " ").trim();
}

function extractLabeledValueFromRows(rows, label) {
  const normalizedLabel = normalizeLabel(label);
  for (const row of rows) {
    const cells = Array.isArray(row && row.cells) ? row.cells : [];
    if (!cells.length) {
      continue;
    }

    if (normalizeLabel(cells[0]) !== normalizedLabel) {
      continue;
    }

    const value = cells.slice(1).find((cell) => normalizeLabel(cell));
    if (value) {
      return String(value).replace(/\s+/g, " ").trim();
    }
  }

  return "";
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

function matchesHeaders(actualHeaders, expectedHeaders) {
  if (actualHeaders.length !== expectedHeaders.length) {
    return false;
  }

  return expectedHeaders.every((header, index) => normalizeLabel(actualHeaders[index]) === normalizeLabel(header));
}

function escapeCsvValue(value) {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function parseNumber(value) {
  const normalized = String(value || "").replace(/,/g, "").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseIntegerValue(value) {
  return Math.round(parseNumber(value));
}

function parseCurrencyValue(value) {
  const normalized = String(value || "")
    .replace(/[(),]/g, "")
    .replace(/\$/g, "")
    .trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return /^\(.*\)$/.test(String(value || "").trim()) ? parsed * -1 : parsed;
}

function formatInteger(value) {
  return Math.round(Number(value || 0)).toString();
}

function formatVolume(value) {
  return Number(value || 0).toFixed(3);
}

function formatCurrency(value) {
  const numericValue = Number(value || 0);
  const absoluteText = Math.abs(numericValue).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return numericValue < 0 ? `-$${absoluteText}` : `$${absoluteText}`;
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function comparePluRows(left, right) {
  const leftKey = String(left["PLU No."] || "");
  const rightKey = String(right["PLU No."] || "");
  return leftKey.localeCompare(rightKey, undefined, { numeric: true, sensitivity: "base" });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Report tree (Year > Month > Reports) and Verifone aggregation helpers
// ---------------------------------------------------------------------------

const VERIFONE_REPORT_FILE_RE = /^(DR|MR)-(\d{4})(\d{2})(\d{2})\.html?$/i;
const VERIFONE_DATED_DIR_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[.\-_]|$)/;

// Caches the {openPeriod, closePeriod, month, day} parsed from a Verifone HTML
// report by file path + mtime so repeated tree loads don't re-read 2 MB files.
const verifoneReportPeriodCache = new Map();

function readVerifoneReportPeriod(filePath) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }

  const cached = verifoneReportPeriodCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.value;
  }

  let html;
  try {
    html = readHtmlFile(filePath);
  } catch {
    verifoneReportPeriodCache.set(filePath, { mtimeMs, value: null });
    return null;
  }

  const openPeriodRaw = matchLabeledCell(html, "Open Period");
  const closePeriodRaw = matchLabeledCell(html, "Close Period");

  // Prefer the close period for month classification because monthly reports
  // are filed by the date their accounting period ended.
  const referenceRaw = closePeriodRaw || openPeriodRaw;
  const referenceDate = parseDateFromPeriodValue(referenceRaw);
  const value = referenceDate
    ? {
        openPeriod: openPeriodRaw,
        closePeriod: closePeriodRaw,
        month: `${referenceDate.year}-${referenceDate.month}`,
        day: `${referenceDate.year}-${referenceDate.month}-${referenceDate.day}`
      }
    : null;

  verifoneReportPeriodCache.set(filePath, { mtimeMs, value });
  return value;
}

function matchLabeledCell(html, label) {
  const escapedLabel = escapeRegExp(label);
  // Find the labeled cell, then walk through the following cells in the same
  // row and return the first one with non-whitespace text content. Verifone
  // report rows commonly have an empty spacer cell between the label and value.
  const labelRe = new RegExp(`<td\\b[^>]*>\\s*${escapedLabel}\\s*<\\/td>`, "i");
  const labelMatch = html.match(labelRe);
  if (!labelMatch) {
    return "";
  }
  const tail = html.slice(labelMatch.index + labelMatch[0].length);
  const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let cellMatch;
  while ((cellMatch = cellRe.exec(tail)) !== null) {
    const text = decodeHtmlEntities(stripTags(cellMatch[1])).replace(/\s+/g, " ").trim();
    if (text) {
      return text;
    }
    // Stop scanning once we leave the current row to avoid leaking values from
    // unrelated rows further down the document.
    const between = tail.slice(0, cellMatch.index);
    if (/<\/tr\s*>/i.test(between)) {
      return "";
    }
  }
  return "";
}

function parseDateFromPeriodValue(value) {
  if (!value) {
    return null;
  }
  // Verifone Commander writes period dates as "YYYY-MM-DD HH:MM" or "YYYY-MM-DD".
  // Also accept "MM/DD/YYYY" for older report variants.
  const isoMatch = String(value).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    return {
      year: isoMatch[1],
      month: String(isoMatch[2]).padStart(2, "0"),
      day: String(isoMatch[3]).padStart(2, "0")
    };
  }
  const usMatch = String(value).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (usMatch) {
    return {
      year: usMatch[3],
      month: String(usMatch[1]).padStart(2, "0"),
      day: String(usMatch[2]).padStart(2, "0")
    };
  }
  return null;
}

function inferReportPeriodFromName(entryName, paymentSystem) {
  const name = String(entryName || "");
  if (paymentSystem === "verifone_commander") {
    const fileMatch = name.match(VERIFONE_REPORT_FILE_RE);
    if (fileMatch) {
      return {
        month: `${fileMatch[2]}-${fileMatch[3]}`,
        day: `${fileMatch[2]}-${fileMatch[3]}-${fileMatch[4]}`,
        prefix: fileMatch[1].toUpperCase()
      };
    }
    const dirMatch = name.match(VERIFONE_DATED_DIR_RE);
    if (dirMatch) {
      return {
        month: `${dirMatch[1]}-${dirMatch[2]}`,
        day: `${dirMatch[1]}-${dirMatch[2]}-${dirMatch[3]}`,
        prefix: ""
      };
    }
  }
  if (paymentSystem === "gilbarco_passport") {
    const month = inferMonthKeyFromGilbarcoFilename(name);
    if (month) {
      const dayMatch = name.match(/StoreClose(\d{4})(\d{2})(\d{2})/i);
      return {
        month,
        day: dayMatch ? `${dayMatch[1]}-${dayMatch[2]}-${dayMatch[3]}` : "",
        prefix: ""
      };
    }
  }
  return null;
}

function listGilbarcoReportEntries(rootPath) {
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    return [];
  }
  return collectFilesRecursively(rootPath)
    .filter((fullPath) => path.extname(fullPath).toLowerCase() === ".pdf")
    .filter((fullPath) => Boolean(inferMonthKeyFromGilbarcoFilename(path.basename(fullPath))))
    .map((fullPath) => ({ name: path.basename(fullPath), fullPath, kind: "file" }));
}

function listVerifoneReportEntries(rootPath) {
  const accumulator = [];
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    return accumulator;
  }
  walkVerifoneEntries(rootPath, accumulator);
  return accumulator;
}

function walkVerifoneEntries(currentPath, accumulator) {
  let children;
  try {
    children = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return;
  }
  children.forEach((entry) => {
    const fullPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (VERIFONE_DATED_DIR_RE.test(entry.name) && directoryContainsHtmlAnywhere(fullPath)) {
        accumulator.push({ name: entry.name, fullPath, kind: "directory" });
        return;
      }
      walkVerifoneEntries(fullPath, accumulator);
      return;
    }
    if (entry.isFile() && VERIFONE_REPORT_FILE_RE.test(entry.name)) {
      accumulator.push({ name: entry.name, fullPath, kind: "file" });
    }
  });
}

function directoryContainsHtmlAnywhere(directoryPath) {
  if (directoryHasHtmlFiles(directoryPath)) {
    return true;
  }
  let children;
  try {
    children = fs.readdirSync(directoryPath, { withFileTypes: true });
  } catch {
    return false;
  }
  return children.some((entry) => (
    entry.isDirectory() && directoryContainsHtmlAnywhere(path.join(directoryPath, entry.name))
  ));
}

function buildReportTree(rootPath, paymentSystem, options = {}) {
  const slug = String(options.slug || "");
  const normalizedPaymentSystem = paymentSystem === "verifone_commander"
    ? "verifone_commander"
    : "gilbarco_passport";

  const entries = normalizedPaymentSystem === "verifone_commander"
    ? listVerifoneReportEntries(rootPath)
    : listGilbarcoReportEntries(rootPath);

  const yearMap = new Map();
  entries.forEach((entry) => {
    let period = inferReportPeriodFromName(entry.name, normalizedPaymentSystem);
    // For Verifone HTML reports (both DR and MR), prefer the close-period date
    // parsed from the file itself so the displayed month always matches the
    // accounting period rather than whatever date is in the filename.
    if (
      normalizedPaymentSystem === "verifone_commander"
      && entry.kind === "file"
      && /\.html?$/i.test(entry.name)
    ) {
      const parsed = readVerifoneReportPeriod(entry.fullPath);
      if (parsed) {
        period = {
          ...(period || {}),
          month: parsed.month,
          day: parsed.day,
          prefix: (period && period.prefix) || "",
          openPeriod: parsed.openPeriod,
          closePeriod: parsed.closePeriod
        };
      }
    }
    if (!period) {
      return;
    }
    const year = period.month.slice(0, 4);
    if (!yearMap.has(year)) {
      yearMap.set(year, new Map());
    }
    const months = yearMap.get(year);
    if (!months.has(period.month)) {
      months.set(period.month, []);
    }

    let sizeBytes = 0;
    let createdAt = "";
    try {
      const stats = fs.statSync(entry.fullPath);
      sizeBytes = stats.isDirectory() ? 0 : stats.size;
      createdAt = stats.birthtime.toISOString();
    } catch {
      // Stats are best-effort; missing data should not break the tree.
    }
    const relativePath = path.relative(rootPath, entry.fullPath).replace(/\\/g, "/");
    months.get(period.month).push({
      name: entry.name,
      path: relativePath,
      kind: entry.kind,
      day: period.day || "",
      reportKind: period.prefix || "",
      isEom: normalizedPaymentSystem === "verifone_commander" && period.prefix === "MR",
      canParseReport: entry.kind === "directory" || /\.(html?|pdf)$/i.test(entry.name),
      sizeBytes,
      sizeLabel: sizeBytes ? formatBytesLabel(sizeBytes) : "",
      createdAt,
      downloadUrl: entry.kind === "directory" || !slug
        ? ""
        : `/api/admin/keys/${encodeURIComponent(slug)}/file-download?path=${encodeURIComponent(relativePath)}`
    });
  });

  const years = Array.from(yearMap.entries())
    .map(([year, monthMap]) => ({
      year,
      label: year,
      months: Array.from(monthMap.entries())
        .map(([month, reports]) => {
          reports.sort((left, right) => {
            const dayDelta = (right.day || "").localeCompare(left.day || "");
            if (dayDelta !== 0) {
              return dayDelta;
            }
            return left.name.localeCompare(right.name);
          });
          let eomReport = null;
          if (normalizedPaymentSystem === "verifone_commander") {
            const mrReports = reports.filter((report) => report.reportKind === "MR");
            if (mrReports.length) {
              eomReport = mrReports[0];
            }
          }
          return {
            month,
            label: formatMonthLabel(month),
            year,
            reportCount: reports.length,
            reports,
            eomReport: eomReport ? { name: eomReport.name, path: eomReport.path, day: eomReport.day } : null,
            canCompile: normalizedPaymentSystem === "gilbarco_passport" && reports.length > 0
          };
        })
        .sort((left, right) => right.month.localeCompare(left.month))
    }))
    .sort((left, right) => right.year.localeCompare(left.year));

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  return {
    slug,
    paymentSystem: normalizedPaymentSystem,
    currentMonth: {
      month: currentMonth,
      label: formatMonthLabel(currentMonth)
    },
    years
  };
}

function formatBytesLabel(bytes) {
  if (!Number.isFinite(bytes)) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Verifone combined-report aggregation (used for Current Month report)
// ---------------------------------------------------------------------------

function combineVerifoneReports(parsedReports, titleOverride, labelOverride, opts = {}) {
  if (!Array.isArray(parsedReports) || !parsedReports.length) {
    throw new Error("At least one Verifone report must be provided.");
  }

  const departmentTotals = new Map();
  const pluTotals = new Map();
  const summaryTotals = new Map();
  const dispenserTotals = new Map();

  parsedReports.forEach((report) => {
    const sections = Array.isArray(report.sections) ? report.sections : [];
    sections.forEach((section) => {
      const title = String(section.title || "").toLowerCase();
      const rows = Array.isArray(section.rows) ? section.rows : [];
      if (title === "department") {
        rows.forEach((row) => {
          const key = String(row["Dept#"] || "").trim();
          if (!key) {
            return;
          }
          const aggregate = getOrCreateAggregate(departmentTotals, key, () => ({
            "Dept#": row["Dept#"] || "",
            Description: row.Description || "",
            "Cust#": 0,
            Items: 0,
            Gross: 0,
            Refunds: 0,
            Discounts: 0,
            "Net Sales": 0
          }));
          if (!aggregate.Description) {
            aggregate.Description = row.Description || aggregate.Description;
          }
          aggregate["Cust#"] += parseIntegerValue(row["Cust#"]);
          aggregate.Items += parseIntegerValue(row.Items);
          aggregate.Gross += parseCurrencyValue(row.Gross);
          aggregate.Refunds += parseCurrencyValue(row.Refunds);
          aggregate.Discounts += parseCurrencyValue(row.Discounts);
          aggregate["Net Sales"] += parseCurrencyValue(row["Net Sales"]);
        });
      } else if (title === "plu") {
        rows.forEach((row) => {
          const key = String(row["PLU Number"] || "").trim();
          if (!key) {
            return;
          }
          const aggregate = getOrCreateAggregate(pluTotals, key, () => ({
            "PLU Number": row["PLU Number"] || "",
            Description: row.Description || "",
            Price: row.Price || "",
            Cust: 0,
            Items: 0,
            "Tot Sales": 0
          }));
          if (!aggregate.Description) {
            aggregate.Description = row.Description || aggregate.Description;
          }
          if (!aggregate.Price) {
            aggregate.Price = row.Price || aggregate.Price;
          }
          aggregate.Cust += parseIntegerValue(row.Cust);
          aggregate.Items += parseIntegerValue(row.Items);
          aggregate["Tot Sales"] += parseCurrencyValue(row["Tot Sales"]);
        });
      } else if (title === "summary") {
        rows.forEach((row) => {
          const key = String(row.Category || "").trim();
          if (!key) {
            return;
          }
          const aggregate = getOrCreateAggregate(summaryTotals, key, () => ({
            Category: row.Category || "",
            Count: 0,
            Amount: 0
          }));
          aggregate.Count += parseIntegerValue(row.Count);
          aggregate.Amount += parseCurrencyValue(row.Amount);
        });
      } else if (title === "dispenser") {
        rows.forEach((row) => {
          const key = `${row.Position || ""}|${row.Product || ""}`;
          const aggregate = getOrCreateAggregate(dispenserTotals, key, () => ({
            Position: row.Position || "",
            Product: row.Product || "",
            "# of Sales": 0,
            Volume: 0,
            Amount: 0
          }));
          aggregate["# of Sales"] += parseIntegerValue(row["# of Sales"]);
          aggregate.Volume += parseNumber(row.Volume);
          aggregate.Amount += parseCurrencyValue(row.Amount);
        });
      }
    });
  });

  const totalDepartmentNet = sumAggregateValues(departmentTotals, "Net Sales");
  const totalPluSales = sumAggregateValues(pluTotals, "Tot Sales");

  const departmentRows = Array.from(departmentTotals.values())
    .sort((left, right) => String(left["Dept#"]).localeCompare(String(right["Dept#"])))
    .map((row) => ({
      "Dept#": row["Dept#"],
      Description: row.Description,
      "Cust#": formatInteger(row["Cust#"]),
      Items: formatInteger(row.Items),
      "% of Sales": formatPercent(totalDepartmentNet ? (row["Net Sales"] / totalDepartmentNet) * 100 : 0),
      Gross: formatCurrency(row.Gross),
      Refunds: formatCurrency(row.Refunds),
      Discounts: formatCurrency(row.Discounts),
      "Net Sales": formatCurrency(row["Net Sales"])
    }));

  const pluRows = Array.from(pluTotals.values())
    .sort((left, right) => String(left["PLU Number"]).localeCompare(String(right["PLU Number"])))
    .map((row) => ({
      "PLU Number": row["PLU Number"],
      Description: row.Description,
      Price: row.Price,
      Cust: formatInteger(row.Cust),
      Items: formatInteger(row.Items),
      "Tot Sales": formatCurrency(row["Tot Sales"]),
      "%Sales": formatPercent(totalPluSales ? (row["Tot Sales"] / totalPluSales) * 100 : 0)
    }));

  const summaryRows = Array.from(summaryTotals.values())
    .map((row) => ({
      Category: row.Category,
      Count: formatInteger(row.Count),
      Amount: formatCurrency(row.Amount)
    }));

  const dispenserRows = Array.from(dispenserTotals.values())
    .sort((left, right) => {
      const positionDelta = String(left.Position).localeCompare(String(right.Position));
      if (positionDelta !== 0) {
        return positionDelta;
      }
      return String(left.Product).localeCompare(String(right.Product));
    })
    .map((row) => ({
      Position: row.Position,
      Product: row.Product,
      "# of Sales": formatInteger(row["# of Sales"]),
      Volume: formatVolume(row.Volume),
      Amount: formatCurrency(row.Amount)
    }));

  const sections = [];
  if (departmentRows.length) {
    sections.push({
      title: "Department",
      headers: ["Dept#", "Description", "Cust#", "Items", "% of Sales", "Gross", "Refunds", "Discounts", "Net Sales"],
      rows: departmentRows,
      totalRows: departmentRows.length,
      truncated: false
    });
  }
  if (dispenserRows.length) {
    sections.push({
      title: "Dispenser",
      headers: ["Position", "Product", "# of Sales", "Volume", "Amount"],
      rows: dispenserRows,
      totalRows: dispenserRows.length,
      truncated: false
    });
  }
  if (summaryRows.length) {
    sections.push({
      title: "Summary",
      headers: ["Category", "Count", "Amount"],
      rows: summaryRows,
      totalRows: summaryRows.length,
      truncated: false
    });
  }
  if (pluRows.length) {
    sections.push({
      title: "PLU",
      headers: ["PLU Number", "Description", "Price", "Cust", "Items", "Tot Sales", "%Sales"],
      rows: pluRows,
      totalRows: pluRows.length,
      truncated: false
    });
  }

  const reference = parsedReports[0];
  return {
    sourceFile: "",
    reportTitle: titleOverride || "Verifone Combined Report",
    reportType: "verifone_combined_report",
    storeNumber: reference.storeNumber || "",
    periodLabel: labelOverride || "Combined",
    openPeriod: reference.openPeriod || "",
    closePeriod: parsedReports[parsedReports.length - 1].closePeriod || "",
    scopeLabel: reference.scopeLabel || "",
    sourceReportCount: parsedReports.length,
    sourceFiles: Array.isArray(opts.sourceFiles) ? opts.sourceFiles : [],
    sections
  };
}

function findVerifoneDailyReportsForMonth(rootPath, monthKey) {
  return listVerifoneReportEntries(rootPath)
    .filter((entry) => {
      // Exclude MR-* (end-of-month) files from the daily aggregation.
      if (/^MR-/i.test(entry.name)) {
        return false;
      }
      // Use the parsed close-period date when available so DR files are bucketed
      // by their actual accounting month rather than the filename date.
      if (entry.kind === "file" && /\.html?$/i.test(entry.name)) {
        const parsed = readVerifoneReportPeriod(entry.fullPath);
        if (parsed) {
          return parsed.month === monthKey;
        }
      }
      const period = inferReportPeriodFromName(entry.name, "verifone_commander");
      return period && period.month === monthKey;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function parseVerifoneMonthlyReport(rootPath, monthKey, opts = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ""))) {
    throw new Error("A month in YYYY-MM format is required.");
  }
  const entries = findVerifoneDailyReportsForMonth(rootPath, monthKey);
  if (!entries.length) {
    throw new Error(`No Verifone daily reports were found for ${monthKey}.`);
  }
  const parsedReports = entries.map((entry) => {
    if (entry.kind === "directory") {
      return parseVerifoneReportDirectory(entry.fullPath);
    }
    const htmlReport = parseHtmlReportFile(entry.fullPath, { maxRowsPerSection: Number.POSITIVE_INFINITY });
    return {
      ...htmlReport,
      reportType: "verifone_report_bundle",
      sections: collectBundledVerifoneSections(htmlReport)
    };
  });

  return combineVerifoneReports(
    parsedReports,
    opts.titleOverride || `${formatMonthLabel(monthKey)} Verifone Combined Report`,
    opts.labelOverride || formatMonthLabel(monthKey),
    { sourceFiles: entries.map((entry) => path.relative(rootPath, entry.fullPath).replace(/\\/g, "/")) }
  );
}

function parseCurrentMonthReport(rootPath, paymentSystem, monthKey) {
  const normalizedMonth = String(monthKey || "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalizedMonth)) {
    throw new Error("A month in YYYY-MM format is required.");
  }
  if (paymentSystem === "verifone_commander") {
    return parseVerifoneMonthlyReport(rootPath, normalizedMonth, {
      titleOverride: `Current Month Verifone Report (${formatMonthLabel(normalizedMonth)})`,
      labelOverride: `Current Month (${formatMonthLabel(normalizedMonth)})`
    });
  }
  // Default to Gilbarco aggregation.
  const combined = parseMonthlyGilbarcoReport(rootPath, normalizedMonth);
  return {
    ...combined,
    reportTitle: `Current Month Gilbarco Report (${formatMonthLabel(normalizedMonth)})`,
    periodLabel: `Current Month (${formatMonthLabel(normalizedMonth)})`
  };
}

module.exports = {
  listGilbarcoReportMonths,
  parseMonthlyGilbarcoReport,
  parseManualGilbarcoReport,
  listPdfFilesInEndpoint,
  parseReportFile,
  parseHtmlReportFile,
  parsePdfReportFile,
  parseVerifoneReportDirectory,
  parseCategoryReportFile,
  collectCategoryReportFiles,
  buildCategoryCsv,
  buildReportTree,
  parseVerifoneMonthlyReport,
  parseCurrentMonthReport
};
