import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = Number(process.env.PORT || 5000);
const allowedOrigins = new Set([
  "http://localhost:5173", "http://127.0.0.1:5173",
  "http://localhost:5174", "http://127.0.0.1:5174",
  "http://localhost:5175", "http://127.0.0.1:5175",
  "http://localhost:5182", "http://127.0.0.1:5182",
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
}));
app.use(express.json());

const io = new Server(httpServer, {
  cors: { origin: [...allowedOrigins], methods: ["GET", "POST"] },
});

const MONGODB_URI = process.env.MONGODB_URI;
const users = new Map();
const voiceReadyUsers = new Set();
let mongoClient;
let positionsCollection;
let memoryMode = false;

app.get("/", (_req, res) => res.send("Welcome to ProxiSpeak Backend!"));
app.get("/api/health", (_req, res) => res.json({
  success: true,
  project: "ProxiSpeak",
  message: "Backend is running successfully",
  database: positionsCollection ? "connected" : (memoryMode ? "memory fallback" : "disconnected"),
  connectedUsers: users.size,
}));

async function savePosition(user) {
  if (!positionsCollection) return;
  await positionsCollection.updateOne(
    { _id: user.id },
    { $set: { name: user.name, position: [user.x, user.y], updatedAt: new Date() } },
    { upsert: true }
  );
}

async function updateProximity(user) {
  let nearby;
  if (positionsCollection) {
    const results = await positionsCollection.find({
      _id: { $ne: user.id },
      position: { $near: [user.x, user.y], $maxDistance: 100 },
    }).toArray();
    nearby = results.map((other) => ({
      id: other._id, name: other.name,
      distance: Math.round(Math.hypot(user.x - other.position[0], user.y - other.position[1])),
    }));
  } else {
    nearby = [...users.values()]
      .filter((other) => other.id !== user.id)
      .map((other) => ({
        id: other.id, name: other.name,
        distance: Math.round(Math.hypot(user.x - other.x, user.y - other.y)),
      }))
      .filter((other) => other.distance <= 100);
  }
  io.to(user.id).emit("proximity:update", nearby);
}

async function refreshAllProximity() {
  await Promise.all([...users.values()].map(async (user) => {
    try { await updateProximity(user); }
    catch (err) { console.error("Proximity update failed:", err.message); }
  }));
}

function relaySignal(socket, eventName, payload) {
  if (!payload || typeof payload.to !== "string" || !users.has(payload.to)) return;
  const forwarded = { from: socket.id };
  if (payload.description) forwarded.description = payload.description;
  if (payload.candidate) forwarded.candidate = payload.candidate;
  io.to(payload.to).emit(eventName, forwarded);
}

io.on("connection", (socket) => {
  const user = { id: socket.id, name: `User-${socket.id.slice(0, 4)}`, x: 180, y: 180 };
  users.set(socket.id, user);
  console.log(`Connected: ${user.name} (${socket.id})`);
  socket.emit("users:update", [...users.values()]);
  socket.broadcast.emit("user:joined", user);
  savePosition(user).then(refreshAllProximity).catch((err) => {
    console.error("Could not save initial position:", err.message);
    refreshAllProximity();
  });

  socket.on("player:move", async (position) => {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
    user.x = Math.max(16, Math.min(884, position.x));
    user.y = Math.max(16, Math.min(484, position.y));
    socket.broadcast.emit("player:moved", { id: socket.id, x: user.x, y: user.y });
    try { await savePosition(user); await refreshAllProximity(); }
    catch (err) {
      console.error("Could not update user position:", err.message);
      await refreshAllProximity();
    }
  });

  socket.on("voice:ready", () => {
    socket.emit("voice:ready-users", [...voiceReadyUsers].filter((id) => id !== socket.id));
    voiceReadyUsers.add(socket.id);
    socket.broadcast.emit("voice:user-ready", { id: socket.id });
  });
  socket.on("voice:stop", () => {
    voiceReadyUsers.delete(socket.id);
    socket.broadcast.emit("voice:user-stopped", { id: socket.id });
  });

  socket.on("webrtc:offer", (payload) => relaySignal(socket, "webrtc:offer", payload));
  socket.on("webrtc:answer", (payload) => relaySignal(socket, "webrtc:answer", payload));
  socket.on("webrtc:ice-candidate", (payload) => relaySignal(socket, "webrtc:ice-candidate", payload));

  socket.on("disconnect", async (reason) => {
    users.delete(socket.id);
    voiceReadyUsers.delete(socket.id);
    socket.broadcast.emit("voice:user-stopped", { id: socket.id });
    try { if (positionsCollection) await positionsCollection.deleteOne({ _id: socket.id }); }
    catch (err) { console.error("Disconnect cleanup failed:", err.message); }
    await refreshAllProximity();
    io.emit("user:left", socket.id);
    console.log(`Disconnected: ${user.name}; reason: ${reason}`);
  });
});

async function startServer() {
  if (MONGODB_URI) {
    try {
      mongoClient = new MongoClient(MONGODB_URI);
      await mongoClient.connect();
      positionsCollection = mongoClient.db("proxispeak").collection("user_positions");
      const indexes = await positionsCollection.indexes();
      const oldIndex = indexes.find((index) => index.name === "position_2d");
      if (oldIndex) await positionsCollection.dropIndex("position_2d");
      await positionsCollection.createIndex({ position: "2d" }, { min: 0, max: 900 });
      console.log("MongoDB connected successfully.");
    } catch (err) {
      console.error("MongoDB setup failed:", err.message);
      console.warn("Starting in memory mode; user positions will not persist.");
      await mongoClient?.close().catch(() => {});
      mongoClient = null;
      positionsCollection = null;
      memoryMode = true;
    }
  } else {
    memoryMode = true;
    console.warn("MONGODB_URI is missing; starting in memory mode; positions will not persist.");
  }

  httpServer.on("error", (err) => console.error("ProxiSpeak server error:", err.message));
  httpServer.listen(PORT, () => console.log(`ProxiSpeak backend running at http://localhost:${PORT}`));
}

startServer();

async function shutdown() {
  try {
    await new Promise((resolve) => io.close(resolve));
    await mongoClient?.close();
  } finally { process.exit(0); }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
