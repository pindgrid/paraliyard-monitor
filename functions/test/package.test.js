"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const pkg = require("../package.json");

const FORBIDDEN = ["firebase-admin", "@google-cloud/firestore", "@google-cloud/storage"];

test("engines pins node 22", () => {
  assert.deepEqual(pkg.engines, { node: "22" });
});

test("no forbidden dependencies", () => {
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = Object.keys(pkg[field] || {});
    for (const name of FORBIDDEN) {
      assert.ok(!deps.includes(name), `${name} must not be in ${field}`);
    }
  }
});
