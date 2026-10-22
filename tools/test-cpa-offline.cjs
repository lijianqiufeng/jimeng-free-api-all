const http = require("node:http"), https = require("node:https"), net = require("node:net");
const blocked = () => { throw Error("Unmocked network is forbidden in isolated CPA tests"); };
http.request = http.get = https.request = https.get = net.connect = net.createConnection = blocked;
globalThis.fetch = blocked;
require("node:module").syncBuiltinESMExports();
