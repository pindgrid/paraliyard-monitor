import type { Kind, ServiceInfo } from "./types";

// Same ids as functions/src/constants.js: `${kind}:${name}`.
function service(kind: Kind, name: string): ServiceInfo {
  return { id: `${kind}:${name}`, kind, name };
}

// One entry per row of data/paraliyard-services.csv.
export const SERVICES: readonly ServiceInfo[] = [
  service("function2", "pyNightlyExport"),
  service("function2", "pyReadStockistDocs"),
  service("function2", "pyYardStaffOnWrite"),
  service("function2", "pyMintOnCrewClaim"),
  service("function2", "pyDeleteAccountOnRequest"),
  service("function2", "pyStaffLoginOnRequest"),
  service("function2", "pyWeeklyAccounts"),
  service("function2", "pyPushOnNotification"),
  service("function2", "pyMintOnRoleRequest"),
  service("function1", "pyCleanupOnAuthDelete"),
  service("firestore", "yard"),
  service("bucket", "mineral-proton-438104-g8-paraliyard"),
  service("bucket", "mineral-proton-438104-g8-yard-backups"),
  service("hosting", "paraliyard"),
  service("hosting", "preparaliyard"),
  service("scheduler", "pyNightlyExport"),
  service("scheduler", "pyWeeklyAccounts"),
];

export const KIND_ORDER: readonly Kind[] = ["function2", "function1", "firestore", "bucket", "hosting", "scheduler"];

export const KIND_LABELS: Record<Kind, string> = {
  function2: "Cloud Functions (2nd gen)",
  function1: "Cloud Functions (1st gen)",
  firestore: "Firestore",
  bucket: "Storage buckets",
  hosting: "Firebase Hosting",
  scheduler: "Cloud Scheduler jobs",
};

export interface Column {
  key: string;
  label: string;
}

// Metric columns per kind, in the same key order as the API.
export const COLUMNS: Record<Kind, readonly Column[]> = {
  function2: [
    { key: "cpuPct", label: "CPU %" },
    { key: "memPct", label: "RAM %" },
    { key: "reqPerMin", label: "Requests/min" },
    { key: "errPerMin", label: "Errors/min" },
    { key: "instances", label: "Instances" },
  ],
  function1: [
    { key: "cpuPct", label: "CPU %" },
    { key: "execPerMin", label: "Executions/min" },
    { key: "memBytes", label: "Memory" },
    { key: "memPct", label: "RAM %" },
  ],
  firestore: [
    { key: "readsPerMin", label: "Reads/min" },
    { key: "writesPerMin", label: "Writes/min" },
    { key: "deletesPerMin", label: "Deletes/min" },
  ],
  bucket: [
    { key: "reqPerMin", label: "Requests/min" },
    { key: "bytesStored", label: "Bytes stored" },
  ],
  hosting: [
    { key: "bytesServed", label: "Bytes served" },
    { key: "reqPerMin", label: "Requests/min" },
  ],
  scheduler: [
    { key: "lastRunAt", label: "Last run" },
    { key: "lastResult", label: "Last result" },
  ],
};

// Totals for these keys are the maximum, not the sum.
export const MAX_KEYS: ReadonlySet<string> = new Set(["cpuPct", "memPct"]);
