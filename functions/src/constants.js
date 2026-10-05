"use strict";

// Every Cloud Monitoring name used by the backend lives in this file.
// Anything marked "assumption: confirm in Metrics Explorer" has not been
// checked against the live project; a wrong value only shows "not available".

const PROJECT_ID = "mineral-proton-438104-g8";
const PROJECT_NAME = `projects/${PROJECT_ID}`;
const REGION = "asia-south1";

// Allowed time windows (seconds). Anything else falls back to DEFAULT_WINDOW.
const WINDOWS = Object.freeze({ "1h": 3600, "6h": 21600 });
const DEFAULT_WINDOW = "1h";

const ALIGNMENT_SECONDS = 60;
// Alignment for the long lookbacks without their own alignment (bucket bytes)
// so a single page covers the whole lookback.
const LONG_ALIGNMENT_SECONDS = 3600;
// Scheduler runs are read in 5-minute buckets so the run time stays precise
// over the 8-day lookback (at most 2304 points per series).
const SCHEDULER_ALIGNMENT_SECONDS = 300;
const BUCKET_BYTES_LOOKBACK_SECONDS = 48 * 3600;
const SCHEDULER_LOOKBACK_SECONDS = 8 * 24 * 3600;

const CACHE_TTL_MS = 60000;
const CALL_TIMEOUT_MS = 10000;
const MAX_CONCURRENT_CALLS = 4;
const PAGE_SIZE = 1000;

// pyCleanupOnAuthDelete is deployed with 512 MB.
const GEN1_MEMORY_BYTES = 512 * 1024 * 1024;

const KINDS = Object.freeze(["function2", "function1", "firestore", "bucket", "hosting", "scheduler"]);

// Monitored-resource type and the label that identifies each service.
const RESOURCES = Object.freeze({
  // assumption: confirm in Metrics Explorer (2nd gen functions report as Cloud Run services)
  function2: Object.freeze({ type: "cloud_run_revision", label: "service_name" }),
  // assumption: confirm in Metrics Explorer
  function1: Object.freeze({ type: "cloud_function", label: "function_name" }),
  // assumption: confirm in Metrics Explorer
  firestore: Object.freeze({ type: "firestore.googleapis.com/Database", label: "database_id" }),
  // assumption: confirm in Metrics Explorer
  bucket: Object.freeze({ type: "gcs_bucket", label: "bucket_name" }),
  // assumption: confirm in Metrics Explorer
  hosting: Object.freeze({ type: "firebase_domain", label: "domain_name" }),
  // assumption: confirm in Metrics Explorer (each job is read from its function's Cloud Run service)
  scheduler: Object.freeze({ type: "cloud_run_revision", label: "service_name" }),
});

// Fixed allowlist of metric types. Nothing outside this list is ever queried.
const METRIC_TYPES = Object.freeze({
  // assumption: confirm in Metrics Explorer
  RUN_CPU: "run.googleapis.com/container/cpu/utilizations",
  // assumption: confirm in Metrics Explorer
  RUN_MEMORY: "run.googleapis.com/container/memory/utilizations",
  // assumption: confirm in Metrics Explorer (errors use metric.labels.response_code_class)
  RUN_REQUESTS: "run.googleapis.com/request_count",
  // assumption: confirm in Metrics Explorer
  RUN_INSTANCES: "run.googleapis.com/container/instance_count",
  // assumption: confirm in Metrics Explorer
  GEN1_EXECUTIONS: "cloudfunctions.googleapis.com/function/execution_count",
  // assumption: confirm in Metrics Explorer
  GEN1_MEMORY: "cloudfunctions.googleapis.com/function/user_memory_bytes",
  // assumption: confirm in Metrics Explorer (the analyst listed document/read_count etc.)
  FIRESTORE_READS: "firestore.googleapis.com/document/read_ops_count",
  // assumption: confirm in Metrics Explorer
  FIRESTORE_WRITES: "firestore.googleapis.com/document/write_ops_count",
  // assumption: confirm in Metrics Explorer
  FIRESTORE_DELETES: "firestore.googleapis.com/document/delete_ops_count",
  // assumption: confirm in Metrics Explorer
  BUCKET_REQUESTS: "storage.googleapis.com/api/request_count",
  // assumption: confirm in Metrics Explorer
  BUCKET_BYTES: "storage.googleapis.com/storage/total_bytes",
  // assumption: confirm in Metrics Explorer
  HOSTING_SENT_BYTES: "firebasehosting.googleapis.com/network/sent_bytes_count",
});

function service(kind, name, resourceLabel) {
  return Object.freeze({ id: `${kind}:${name}`, kind, name, resourceLabel });
}

// 2nd gen functions run as Cloud Run services named after the function in lower case.
// assumption: confirm in Metrics Explorer
function gen2(name) {
  return service("function2", name, name.toLowerCase());
}

// A scheduled job is read from its function's Cloud Run request_count (service
// named after the function in lower case), so manual HTTP calls also count as runs.
// assumption: confirm in Metrics Explorer
function job(name) {
  return service("scheduler", name, name.toLowerCase());
}

// One entry per row of data/paraliyard-services.csv.
const SERVICES = Object.freeze([
  gen2("pyNightlyExport"),
  gen2("pyReadStockistDocs"),
  gen2("pyYardStaffOnWrite"),
  gen2("pyMintOnCrewClaim"),
  gen2("pyDeleteAccountOnRequest"),
  gen2("pyStaffLoginOnRequest"),
  gen2("pyWeeklyAccounts"),
  gen2("pyPushOnNotification"),
  gen2("pyMintOnRoleRequest"),
  service("function1", "pyCleanupOnAuthDelete", "pyCleanupOnAuthDelete"),
  service("firestore", "yard", "yard"),
  service("bucket", "mineral-proton-438104-g8-paraliyard", "mineral-proton-438104-g8-paraliyard"),
  service("bucket", "mineral-proton-438104-g8-yard-backups", "mineral-proton-438104-g8-yard-backups"),
  // assumption: confirm in Metrics Explorer (domain label values)
  service("hosting", "paraliyard", "paraliyard.web.app"),
  service("hosting", "preparaliyard", "preparaliyard.web.app"),
  job("pyNightlyExport"),
  job("pyWeeklyAccounts"),
]);

module.exports = {
  PROJECT_ID,
  PROJECT_NAME,
  REGION,
  WINDOWS,
  DEFAULT_WINDOW,
  ALIGNMENT_SECONDS,
  LONG_ALIGNMENT_SECONDS,
  SCHEDULER_ALIGNMENT_SECONDS,
  BUCKET_BYTES_LOOKBACK_SECONDS,
  SCHEDULER_LOOKBACK_SECONDS,
  CACHE_TTL_MS,
  CALL_TIMEOUT_MS,
  MAX_CONCURRENT_CALLS,
  PAGE_SIZE,
  GEN1_MEMORY_BYTES,
  KINDS,
  RESOURCES,
  METRIC_TYPES,
  SERVICES,
};
