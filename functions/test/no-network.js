"use strict";

// Loaded by every functions test: any attempt to open a socket fails loudly.
const net = require("node:net");

net.Socket.prototype.connect = function connect() {
  throw new Error("network disabled in tests");
};
