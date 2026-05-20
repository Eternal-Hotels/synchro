"use strict";

const crypto = require("crypto");
const path = require("path");
const { Worker } = require("worker_threads");

const WORKER_PATH = path.join(__dirname, "report-parser-worker.js");
const COMPLETED_JOB_TTL_MS = 30 * 60 * 1000;
const MAX_RETAINED_JOBS = 200;

const jobs = new Map();

function timestamp() {
  return new Date().toISOString();
}

function normalizeError(error) {
  const normalized = new Error(error && error.message ? String(error.message) : "Report task failed.");
  normalized.statusCode = Number.isInteger(error && error.statusCode)
    ? error.statusCode
    : 500;
  return normalized;
}

function serializeJob(job) {
  return {
    jobId: job.jobId,
    label: job.label,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || "",
    result: job.status === "completed" ? job.result : undefined,
    error: job.status === "failed" && job.error ? job.error.message : undefined
  };
}

function pruneJobs() {
  const cutoff = Date.now() - COMPLETED_JOB_TTL_MS;

  for (const [jobId, job] of jobs.entries()) {
    if (job.status !== "completed" && job.status !== "failed") {
      continue;
    }

    const updatedAtMs = Date.parse(job.updatedAt || job.createdAt || "");
    if (updatedAtMs && updatedAtMs < cutoff) {
      jobs.delete(jobId);
    }
  }

  const completedJobs = Array.from(jobs.values())
    .filter((job) => job.status === "completed" || job.status === "failed")
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));

  while (completedJobs.length > MAX_RETAINED_JOBS) {
    const oldest = completedJobs.shift();
    jobs.delete(oldest.jobId);
  }
}

function runReportTask(taskName, taskArgs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        taskName,
        taskArgs
      }
    });

    worker.once("message", (message) => {
      if (settled) {
        return;
      }

      settled = true;
      if (message && message.ok) {
        resolve(message.result);
        return;
      }

      reject(normalizeError(message && message.error));
    });

    worker.once("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(normalizeError(error));
    });

    worker.once("exit", (code) => {
      if (settled || code === 0) {
        return;
      }

      settled = true;
      reject(normalizeError({ message: `Report worker exited with code ${code}.` }));
    });
  });
}

function startReportJob(ownerUserId, label, taskName, taskArgs) {
  pruneJobs();

  const jobId = crypto.randomUUID();
  const createdAt = timestamp();
  const job = {
    jobId,
    ownerUserId: String(ownerUserId || ""),
    label: String(label || "report"),
    status: "running",
    createdAt,
    updatedAt: createdAt,
    completedAt: "",
    result: null,
    error: null
  };

  jobs.set(jobId, job);

  runReportTask(taskName, taskArgs)
    .then((result) => {
      job.status = "completed";
      job.result = result;
      job.updatedAt = timestamp();
      job.completedAt = job.updatedAt;
      pruneJobs();
    })
    .catch((error) => {
      job.status = "failed";
      job.error = normalizeError(error);
      job.updatedAt = timestamp();
      job.completedAt = job.updatedAt;
      pruneJobs();
    });

  return {
    jobId,
    label: job.label,
    status: job.status,
    createdAt: job.createdAt,
    statusUrl: `/api/admin/report-jobs/${encodeURIComponent(jobId)}`
  };
}

function getReportJob(jobId, ownerUserId) {
  pruneJobs();

  const job = jobs.get(String(jobId || ""));
  if (!job) {
    return null;
  }

  if (job.ownerUserId && String(ownerUserId || "") !== job.ownerUserId) {
    return null;
  }

  return serializeJob(job);
}

module.exports = {
  getReportJob,
  runReportTask,
  startReportJob
};