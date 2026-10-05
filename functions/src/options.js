"use strict";

// Runtime identity and limits for liveMonitorApi. The service account and its
// Monitoring Viewer role are created by a person outside this repository.
module.exports = Object.freeze({
  region: "asia-south1",
  serviceAccount: "live-monitor@mineral-proton-438104-g8.iam.gserviceaccount.com",
  maxInstances: 2,
  memory: "256MiB",
  timeoutSeconds: 30,
});
