"use strict";

const fs = require("fs");
const path = require("path");

const { buildCategoryCsv, collectCategoryReportFiles, parseCategoryReportFile } = require("./services/report-parser");
const { ensureDirectory } = require("./utils/files");

function main() {
  const { inputPath, outputPath } = parseArgs(process.argv.slice(2));
  const reportFiles = collectCategoryReportFiles(inputPath);

  if (!reportFiles.length) {
    throw new Error(`No Category.html files were found under: ${path.resolve(inputPath)}`);
  }

  const allRecords = [];
  for (const reportFile of reportFiles) {
    allRecords.push(...parseCategoryReportFile(reportFile));
  }

  if (!allRecords.length) {
    throw new Error("Category report files were found, but no category rows could be parsed.");
  }

  const finalOutputPath = outputPath
    ? path.resolve(outputPath)
    : buildDefaultOutputPath(inputPath);

  ensureDirectory(path.dirname(finalOutputPath));
  fs.writeFileSync(finalOutputPath, buildCategoryCsv(allRecords), "utf8");

  console.log(`Parsed ${allRecords.length} category row(s) from ${reportFiles.length} report file(s).`);
  console.log(`CSV written to ${finalOutputPath}`);
}

function parseArgs(args) {
  let inputPath = "";
  let outputPath = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input" || arg === "-i") {
      inputPath = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--output" || arg === "-o") {
      outputPath = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (!inputPath) {
      inputPath = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!inputPath) {
    printHelp();
    throw new Error("An input file or directory is required.");
  }

  return { inputPath, outputPath };
}

function buildDefaultOutputPath(inputPath) {
  const resolvedInput = path.resolve(inputPath);
  const stats = fs.statSync(resolvedInput);

  if (stats.isFile()) {
    return path.join(path.dirname(resolvedInput), `${path.basename(resolvedInput, path.extname(resolvedInput))}-categories.csv`);
  }

  return path.join(resolvedInput, "category-export.csv");
}

function printHelp() {
  console.log("Usage: node src/parse-category-report.js --input <file-or-folder> [--output <csv-path>]");
  console.log("You can also pass the input path as the first positional argument.");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
