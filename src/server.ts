import http from "http";
import express from "express";
import bodyParser from "body-parser";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "./config";
import { voiceRouter } from "./routes/voice";
import { statusRouter } from "./routes/status";
import { outboundRouter } from "./routes/outbound";
import { handleMediaStream } from "./routes/mediaStream";

const WEBSOCKET_PATH = "/media-stream";
const HEARTBEAT_INTERVAL_MS = 30000;
const SHUTDOWN_TIMEOUT_MS = 25000;
const SERVICE_RESTART_CLOSE_CODE = 1012;

interface HeartbeatWebSocket extends WebSocket {
  isAlive: boolean;
}

const app = express();
let shuttingDown = false;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/health", (_req, res) => {
  res.status(shuttingDown ? 503 : 200).json({
    status: shuttingDown ? "shutting_down" : "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    nodeEnv: config.NODE_ENV,
    websocketPath: WEBSOCKET_PATH,
  });
});

app.use("/voice", voiceRouter);
app.use("/status", statusRouter);
app.use("/outbound", outboundRouter);

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: WEBSOCKET_PATH });
wss.on("connection", (ws) => {
  const heartbeatWs = ws as HeartbeatWebSocket;
  heartbeatWs.isAlive = true;
  heartbeatWs.on("pong", () => {
    heartbeatWs.isAlive = true;
  });
  handleMediaStream(heartbeatWs);
});

const heartbeatInterval = setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as HeartbeatWebSocket;
    if (ws.readyState !== WebSocket.OPEN) {
      ws.terminate();
      continue;
    }
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down voice server`);

  clearInterval(heartbeatInterval);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.close(SERVICE_RESTART_CLOSE_CODE, "Service restarting");
    } else {
      client.terminate();
    }
  }

  server.close((err) => {
    if (err) {
      console.error("HTTP server close failed:", err);
      process.exit(1);
    }
    console.log("Voice server shutdown complete");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    for (const client of wss.clients) {
      client.terminate();
    }
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(config.PORT, "0.0.0.0", () => {
  console.log(`Voice agent running on port ${config.PORT}`);
  console.log(`Webhook base: ${config.TWILIO_WEBHOOK_BASE}`);
});
