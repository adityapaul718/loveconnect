
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

if (!ADMIN_KEY) {
  console.warn("ADMIN_KEY is not configured");
}

const DATA_FILE = "./data.json";
let reports = [];
let bans = [];
let totalMatches = 0;

try {
  if (fs.existsSync(DATA_FILE)) {
    const data = JSON.parse(fs.readFileSync(DATA_FILE));
    reports = data.reports || [];
    bans = data.bans || [];
    totalMatches = data.totalMatches || 0;
  }
} catch (e) {
  console.error("Data loading error");
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    reports, bans, totalMatches
  }));
}

const waiting = new Map();
const pairs = new Map();
const users = new Map();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(rateLimit({
  windowMs: 60000,
  limit: 100
}));
app.use(express.static("public"));

function admin(req) {
  return ADMIN_KEY &&
    req.get("x-admin-key") === ADMIN_KEY;
}

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

io.on("connection", socket => {
  users.set(socket.id, {
    id: socket.id.slice(0, 8),
    connected: new Date().toISOString(),
    region: "any"
  });

  socket.on("find-partner", prefs => {
    const region = ["any", "india", "world"].includes(prefs?.region)
      ? prefs.region : "any";

    const user = users.get(socket.id);
    if (user) user.region = region;

    matchUser(socket, region);
  });

  socket.on("signal", data => {
    const other = pairs.get(socket.id);
    if (other) io.to(other).emit("signal", data);
  });

  socket.on("chat-message", message => {
    const other = pairs.get(socket.id);
    if (!other) return;

    const text = String(message || "")
      .replace(/[<>]/g, "").slice(0, 500);

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
  if (!report) return res.status(404).json({ error: "Not found" });

  report.status = "reviewed";
  saveData();
  res.json({ success: true });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("LoveConnect running on port " + PORT);
});
