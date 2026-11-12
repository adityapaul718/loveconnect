
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;

// Metered TURN configuration
const TURN_SERVER_URL = process.env.TURN_SERVER_URL;
const TURN_USERNAME = process.env.TURN_USERNAME;
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL;

if (!ADMIN_KEY) {
  console.warn("ADMIN_KEY is not configured");
}

if (!TURN_SERVER_URL || !TURN_USERNAME || !TURN_CREDENTIAL) {
  console.warn("TURN server environment variables are incomplete");
}

// Data storage
const DATA_FILE = "./data.json";
let reports = [];
let bans = [];
let totalMatches = 0;

try {
  if (fs.existsSync(DATA_FILE)) {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    reports = data.reports || [];
    bans = data.bans || [];
    totalMatches = data.totalMatches || 0;
  }
} catch (e) {
  console.error("Data loading error:", e.message);
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      reports,
      bans,
      totalMatches
    }));
  } catch (e) {
    console.error("Data saving error:", e.message);
  }
}

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

app.use(rateLimit({
  windowMs: 60000,
  limit: 100
}));

// TURN credentials are supplied to the browser for WebRTC.
app.get("/api/ice-servers", (req, res) => {
  const iceServers = [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun.cloudflare.com:3478"
      ]
    }
  ];

  if (TURN_SERVER_URL && TURN_USERNAME && TURN_CREDENTIAL) {
    const turnUrls = TURN_SERVER_URL
      .split(",")
      .map(url => url.trim())
      .filter(url => url.startsWith("turn:") || url.startsWith("turns:"));

    if (turnUrls.length > 0) {
      iceServers.push({
        urls: turnUrls,
        username: TURN_USERNAME,
        credential: TURN_CREDENTIAL
      });
    }
  }

  res.set("Cache-Control", "no-store");
  res.json({ iceServers });
});

// Website files
app.use(express.static("public"));

function admin(req) {
  return ADMIN_KEY &&
    req.get("x-admin-key") === ADMIN_KEY;
}

// Matching system
const waiting = new Map();
const pairs = new Map();
const users = new Map();

function endPair(socket, reason) {
  const other = pairs.get(socket.id);
  if (!other) return;

  pairs.delete(socket.id);
  pairs.delete(other);

  io.to(other).emit("partner-left", { reason });
}

function matchUser(socket, region) {
  waiting.delete(socket.id);
  endPair(socket, "Partner changed");

  for (const [id, data] of waiting) {
    if (id === socket.id) continue;

    if (
      region !== "any" &&
      data.region !== "any" &&
      data.region !== region
    ) continue;

    const partner = io.sockets.sockets.get(id);
    if (!partner) continue;

    waiting.delete(id);

    pairs.set(socket.id, id);
    pairs.set(id, socket.id);

    totalMatches++;
    saveData();

    socket.emit("matched", { initiator: true });
    partner.emit("matched", { initiator: false });
    return;
  }

  waiting.set(socket.id, { region });
  socket.emit("waiting");
}

// Socket.IO
io.on("connection", socket => {
  users.set(socket.id, {
    id: socket.id.slice(0, 8),
    connected: new Date().toISOString(),
    region: "any"
  });

  socket.on("find-partner", prefs => {
    const region = ["any", "india", "world"].includes(prefs?.region)
      ? prefs.region
      : "any";

    const user = users.get(socket.id);
    if (user) user.region = region;

    matchUser(socket, region);
  });

  socket.on("signal", data => {
    const other = pairs.get(socket.id);
    if (other) {
      io.to(other).emit("signal", data);
    }
  });

  socket.on("chat-message", message => {
    const other = pairs.get(socket.id);
    if (!other) return;

    const text = String(message || "")
      .replace(/[<>]/g, "")
      .slice(0, 500);

    if (text.trim()) {
      io.to(other).emit("chat-message", {
        text,
        at: Date.now()
      });
    }
  });

  socket.on("stop", () => {
    waiting.delete(socket.id);
    endPair(socket, "You ended the chat");
  });

  socket.on("report", data => {
    reports.push({
      id: Date.now().toString(),
      reporter: socket.id.slice(0, 8),
      reported: pairs.get(socket.id)?.slice(0, 8) || null,
      reason: String(data?.reason || "User report").slice(0, 200),
      time: new Date().toISOString(),
      status: "open"
    });

    saveData();
    endPair(socket, "Chat ended after report");
    socket.emit("report-received");
  });

  socket.on("disconnect", () => {
    waiting.delete(socket.id);
    endPair(socket, "Partner disconnected");
    users.delete(socket.id);
  });
});

// Admin dashboard
app.get("/admin", (req, res) => {
  res.sendFile(__dirname + "/public/admin.html");
});

app.get("/api/admin", (req, res) => {
  if (!admin(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.json({
    online: users.size,
    waiting: waiting.size,
    activeCalls: pairs.size / 2,
    totalMatches,
    reports,
    bans: bans.length,
    users: [...users.values()]
  });
});

app.post("/api/admin/report/:id", (req, res) => {
  if (!admin(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const report = reports.find(r => r.id === req.params.id);

  if (!report) {
    return res.status(404).json({ error: "Not found" });
  }

  report.status = "reviewed";
  saveData();

  res.json({ success: true });
});

// Start server
server.listen(PORT, "0.0.0.0", () => {
  console.log("LoveConnect running on port " + PORT);
});
