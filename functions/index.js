"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const options = require("./src/options");
const { createHandler } = require("./src/handler");

let client = null;

// The Monitoring client is created on the first refresh, never at load time,
// and uses the runtime service account's default credentials.
function getClient() {
  if (!client) {
    const { MetricServiceClient } = require("@google-cloud/monitoring");
    client = new MetricServiceClient();
  }
  return client;
}

exports.liveMonitorApi = onRequest(options, createHandler({ getClient }));
