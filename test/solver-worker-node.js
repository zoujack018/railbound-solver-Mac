import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("solver-worker-node.js must run inside a worker thread");

globalThis.self = {
  postMessage(message) {
    parentPort.postMessage(message);
  },
  close() {
    parentPort.close();
  },
};

await import("../railbound-worker.js");

parentPort.on("message", data => {
  globalThis.self.onmessage({ data });
});
