#!/usr/bin/env node
import { JsonLinePeer } from "./jsonrpc.js";
import { BrokerMcpServer } from "./mcp-server.js";
const peer = new JsonLinePeer(process.stdin, process.stdout, "broker-host");
const server = new BrokerMcpServer(peer);
let closing = false;
async function close() {
    if (closing) {
        return;
    }
    closing = true;
    await server.close();
}
process.on("SIGINT", () => {
    void close().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
});
process.on("beforeExit", () => {
    void close();
});
server.start();
