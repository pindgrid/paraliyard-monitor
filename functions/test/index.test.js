"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Count MetricServiceClient constructions before index.js is loaded.
const monitoring = require("@google-cloud/monitoring");
const RealClient = monitoring.MetricServiceClient;
let constructed = 0;
monitoring.MetricServiceClient = class SpyClient {
  constructor() {
    constructed += 1;
  }
};

const mod = require("../index.js");
const options = require("../src/options");

test.after(() => {
  monitoring.MetricServiceClient = RealClient;
});

test("exports exactly liveMonitorApi", () => {
  assert.deepEqual(Object.keys(mod), ["liveMonitorApi"]);
  assert.equal(typeof mod.liveMonitorApi, "function");
});

test("declared options", () => {
  assert.deepEqual({ ...options }, {
    region: "asia-south1",
    serviceAccount: "live-monitor@mineral-proton-438104-g8.iam.gserviceaccount.com",
    maxInstances: 2,
    memory: "256MiB",
    timeoutSeconds: 30,
  });
  assert.ok(Object.isFrozen(options));
});

test("endpoint manifest carries the options", () => {
  const endpoint = mod.liveMonitorApi.__endpoint;
  assert.deepEqual(endpoint.region, ["asia-south1"]);
  assert.equal(endpoint.serviceAccountEmail, "live-monitor@mineral-proton-438104-g8.iam.gserviceaccount.com");
  assert.equal(endpoint.availableMemoryMb, 256);
  assert.equal(endpoint.maxInstances, 2);
  assert.equal(endpoint.timeoutSeconds, 30);
  assert.equal(endpoint.platform, "gcfv2");
  assert.ok(endpoint.httpsTrigger);
});

test("loading the module creates no Monitoring client", () => {
  assert.equal(constructed, 0);
});

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test("source never references forbidden packages", () => {
  const root = path.join(__dirname, "..");
  const files = [path.join(root, "index.js"), ...walk(path.join(root, "src"))];
  assert.ok(files.length > 1);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const name of ["firebase-admin", "@google-cloud/firestore", "@google-cloud/storage"]) {
      assert.ok(!text.includes(name), `${name} referenced in ${file}`);
    }
  }
});
