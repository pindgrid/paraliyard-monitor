"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SERVICES } = require("../src/constants");

const TYPE_TO_KIND = {
  "Cloud Function (2nd gen)": "function2",
  "Cloud Function (1st gen)": "function1",
  "Firestore database": "firestore",
  "Storage bucket": "bucket",
  "Firebase Hosting site": "hosting",
  "Cloud Scheduler job": "scheduler",
};

function readInventory() {
  const text = fs.readFileSync(path.join(__dirname, "..", "..", "data", "paraliyard-services.csv"), "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = lines[0].split(",");
  const typeCol = header.indexOf("Type");
  const nameCol = header.indexOf("Name");
  // No quoted fields in the inventory, so a plain split is enough.
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    return { type: cols[typeCol], name: cols[nameCol] };
  });
}

test("inventory has 17 rows", () => {
  assert.equal(readInventory().length, 17);
});

test("one service per inventory row with the mapped kind", () => {
  const rows = readInventory();
  assert.equal(SERVICES.length, rows.length);
  for (const row of rows) {
    const kind = TYPE_TO_KIND[row.type];
    assert.ok(kind, `unknown type ${row.type}`);
    const matches = SERVICES.filter((s) => s.kind === kind && s.name === row.name);
    assert.equal(matches.length, 1, `${kind}:${row.name}`);
  }
});

test("service ids are unique and follow kind:name", () => {
  const ids = SERVICES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of SERVICES) assert.equal(s.id, `${s.kind}:${s.name}`);
});

test("service counts per kind", () => {
  const counts = {};
  for (const s of SERVICES) counts[s.kind] = (counts[s.kind] || 0) + 1;
  assert.deepEqual(counts, { function2: 9, function1: 1, firestore: 1, bucket: 2, hosting: 2, scheduler: 2 });
});
