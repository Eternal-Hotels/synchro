"use strict";

const { parentPort, workerData } = require("worker_threads");

const {
  parseManualGilbarcoReport,
  parseMonthlyGilbarcoReport,
  parseReportFile,
  parseCurrentMonthReport
} = require("./report-parser");

const TASK_HANDLERS = {
  parseReportFile(taskArgs) {
    return parseReportFile(taskArgs.filePath);
  },
  parseCurrentMonthReport(taskArgs) {
    return parseCurrentMonthReport(taskArgs.rootPath, taskArgs.paymentSystem, taskArgs.monthKey);
  },
  parseMonthlyGilbarcoReport(taskArgs) {
    return parseMonthlyGilbarcoReport(taskArgs.rootPath, taskArgs.monthKey);
  },
  parseManualGilbarcoReport(taskArgs) {
    return parseManualGilbarcoReport(taskArgs.rootPath, taskArgs.pdfFilenames);
  }
};

function serializeError(error) {
  const statusCode = Number.isInteger(error && error.statusCode)
    ? error.statusCode
    : 500;

  return {
    message: error && error.message ? String(error.message) : "Report task failed.",
    statusCode
  };
}

async function runTask() {
  const taskName = workerData && workerData.taskName ? String(workerData.taskName) : "";
  const taskArgs = workerData && workerData.taskArgs ? workerData.taskArgs : {};
  const handler = TASK_HANDLERS[taskName];

  if (!handler) {
    throw new Error(`Unsupported report task: ${taskName || "unknown"}`);
  }

  return handler(taskArgs);
}

Promise.resolve()
  .then(runTask)
  .then((result) => {
    parentPort.postMessage({ ok: true, result });
  })
  .catch((error) => {
    parentPort.postMessage({ ok: false, error: serializeError(error) });
  });