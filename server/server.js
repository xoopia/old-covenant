/**
 * server.js - 游戏服务入口
 *
 * 旧日圣契 - Node.js + 原生 WebSocket (ws)
 * 权威服务器架构：全部逻辑在服务端，客户端仅发指令+渲染UI
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const { handleMessage } = require("./messageHandler");
const { roomManager } = require("./roomManager");

// 静态文件 MIME 映射
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// 客户端静态文件目录
const CLIENT_DIR = path.join(__dirname, "..", "client");

// ========== HTTP 服务器 ==========
const server = http.createServer((req, res) => {
  // 健康检查端点 (Render 部署必需)
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // CORS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // 简易 HTTP API
  if (req.url === "/api/stats" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(
      JSON.stringify({
        rooms: Object.keys(roomManager.rooms).length,
        uptime: process.uptime(),
      })
    );
    return;
  }

  // 静态文件服务
  let filePath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  filePath = path.normalize(filePath).replace(/^\/+/, "");
  const fullPath = path.join(CLIENT_DIR, filePath);

  // 安全检查：确保不越出 client 目录
  if (!fullPath.startsWith(CLIENT_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(fullPath);
  const contentType = MIME[ext] || "application/octet-stream";

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

// ========== WebSocket 服务器 ==========
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  console.log(`[连接] 新客户端 ${req.socket.remoteAddress}`);

  // 消息处理
  ws.on("message", (data) => {
    try {
      handleMessage(ws, data.toString());
    } catch (err) {
      console.error("[消息错误]", err.message);
      // 不崩溃进程，静默吞掉异常
    }
  });

  // 客户端断开
  ws.on("close", () => {
    console.log("[断开] 客户端离开");
    // 断线处理由心跳检测驱动，立即查找并标记
    for (const room of Object.values(roomManager.rooms)) {
      const player = room.getPlayerByWs(ws);
      if (player) {
        room.handleDisconnect(player.id);
        console.log(`[断线] 玩家 ${player.id} 已标记离线`);
        break;
      }
    }
  });

  ws.on("error", (err) => {
    console.error("[WS错误]", err.message);
  });
});

// ========== 启动 ==========
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   📜 旧日圣契 服务器已启动          ║");
  console.log(`║   端口: ${PORT}                           ║`);
  console.log("║   架构: 权威服务器 CS                   ║");
  console.log("║   协议: WebSocket (ws)                  ║");
  console.log("╚══════════════════════════════════════════╝");
});

// 启动心跳循环
roomManager.startHeartbeatLoop();

// 启动房间清理循环
roomManager.startCleanupLoop();
