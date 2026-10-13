import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const API_URL = "http://localhost:5000";
const WIDTH = 900;
const HEIGHT = 500;
const SPEED = 4;
const HEARING_RADIUS = 100;
const PLAYER_RADIUS = 12;
const COLLISION_RADIUS = 9;
const WALL_THICKNESS = 6;

// Office Layout Geometry
const ROOM = { left: 660, top: 25, right: 875, bottom: 170 };
const DOORWAY = { left: 735, right: 785 };

const SOLID_WALLS = [
  // Meeting Room
  [ROOM.left, ROOM.top, ROOM.right, ROOM.top],
  [ROOM.left, ROOM.top, ROOM.left, ROOM.bottom],
  [ROOM.right, ROOM.top, ROOM.right, ROOM.bottom],
  [ROOM.left, ROOM.bottom, DOORWAY.left, ROOM.bottom],
  [DOORWAY.right, ROOM.bottom, ROOM.right, ROOM.bottom],
  // Private Executive Rooms
  [25, 25, 245, 25],
  [25, 25, 25, 455],
  [245, 25, 245, 250],
  [245, 330, 245, 455],
  [25, 165, 98, 165],
  [145, 165, 245, 165],
  [25, 305, 98, 305],
  [145, 305, 245, 305],
  [25, 455, 245, 455],
];

const DESKS = [
  [285, 90], [400, 90], [515, 90],
  [285, 190], [400, 190], [515, 190],
  [285, 290], [400, 290], [515, 290],
];
const DESK_WIDTH = 95;
const DESK_HEIGHT = 48;

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

function pointHitsSegment(x, y, x1, y1, x2, y2, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : clamp(((x - x1) * dx + (y - y1) * dy) / lenSq, 0, 1);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const distSq = (x - cx) * (x - cx) + (y - cy) * (y - cy);
  const colRadius = radius + WALL_THICKNESS / 2;
  return distSq < colRadius * colRadius;
}

function collidesWithObstacle(x, y) {
  // Desks
  const hitDesk = DESKS.some(([dx, dy]) => {
    const cx = clamp(x, dx, dx + DESK_WIDTH);
    const cy = clamp(y, dy, dy + DESK_HEIGHT);
    return (x - cx) ** 2 + (y - cy) ** 2 < COLLISION_RADIUS ** 2;
  });
  if (hitDesk) return true;

  // Solid Walls
  return SOLID_WALLS.some(([x1, y1, x2, y2]) => pointHitsSegment(x, y, x1, y1, x2, y2, COLLISION_RADIUS));
}

// Ray-wall intersection for acoustic occlusion / sound muffling
function rayHitsWall(x1, y1, x2, y2) {
  for (const [wx1, wy1, wx2, wy2] of SOLID_WALLS) {
    const denom = (y2 - y1) * (wx2 - wx1) - (x2 - x1) * (wy2 - wy1);
    if (denom === 0) continue;
    const ua = ((x2 - x1) * (wy1 - y1) - (y2 - y1) * (wx1 - x1)) / denom;
    const ub = ((wx2 - wx1) * (wy1 - y1) - (wy2 - wy1) * (wx1 - x1)) / denom;
    if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) return true;
  }
  return false;
}

// Canvas Drawing Helpers
function roundedRect(ctx, x, y, width, height, radius, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function drawPlant(ctx, x, y, scale = 1) {
  roundedRect(ctx, x - 7 * scale, y + 3 * scale, 14 * scale, 12 * scale, 3 * scale, "#334155", "#475569");
  ctx.fillStyle = "#10b981";
  [[-5, -5], [0, -10], [5, -5], [0, 0]].forEach(([dx, dy]) => {
    ctx.beginPath();
    ctx.ellipse(x + dx * scale, y + dy * scale, 4 * scale, 7 * scale, dx * 0.08, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawWorkstation(ctx, x, y, label) {
  // Desk surface
  roundedRect(ctx, x + 2, y + 3, DESK_WIDTH, DESK_HEIGHT, 5, "#1e293b");
  roundedRect(ctx, x, y, DESK_WIDTH, DESK_HEIGHT, 5, "#334155", "#475569");

  // Dual Monitors
  roundedRect(ctx, x + 24, y + 5, 22, 16, 2, "#0f172a", "#38bdf8");
  roundedRect(ctx, x + 49, y + 5, 22, 16, 2, "#0f172a", "#38bdf8");

  // Keyboard & Mousepad
  roundedRect(ctx, x + 30, y + 26, 35, 6, 2, "#1e293b");
  roundedRect(ctx, x + 70, y + 26, 8, 8, 2, "#1e293b");

  // Ergonomic Chair
  roundedRect(ctx, x + 38, y + 50, 20, 12, 4, "#2563eb");
  roundedRect(ctx, x + 41, y + 52, 14, 6, 2, "#60a5fa");

  if (label) {
    ctx.fillStyle = "#64748b";
    ctx.font = "9px Arial";
    ctx.fillText(label, x + 24, y + 44);
  }
}

export default function App() {
  const canvasRef = useRef(null);
  const socketRef = useRef(null);
  const audioCtxRef = useRef(null);
  const localStreamRef = useRef(null);
  const localAnalyserRef = useRef(null);
  const peerConnectionsRef = useRef(new Map());
  const peerAudioNodesRef = useRef(new Map());
  const peerAudioElementsRef = useRef(new Map());
  const voiceReadyIdsRef = useRef(new Set());
  const positionsRef = useRef(new Map());
  const playerRef = useRef({ x: 420, y: 380, color: "#3b82f6", name: "Dev-User" });
  const demoBotPosRef = useRef({ x: 485, y: 380 });
  const demoBotIntervalRef = useRef(null);
  const keysRef = useRef(new Set());
  const waypointRef = useRef(null);
  const localIdRef = useRef(null);

  // States
  const [player, setPlayer] = useState({ x: 420, y: 380, color: "#3b82f6", name: "Dev-User" });
  const [users, setUsers] = useState([]);
  const [nearbyUsers, setNearbyUsers] = useState([]);
  const [connected, setConnected] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("Microphone offline");
  const [attenuationMode, setAttenuationMode] = useState("linear"); // "linear" | "exponential"
  const [spatialAudit, setSpatialAudit] = useState(null);
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [meshStats, setMeshStats] = useState(null);
  const [demoBotActive, setDemoBotActive] = useState(false);
  const [error, setError] = useState("");
  const [activePeersCount, setActivePeersCount] = useState(0);

  // Audio Context initialization helper
  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioCtxRef.current = new AudioCtx();
    }
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  // Spatial Demo Bot synthesizer (for instant solo testing)
  const demoBotGainRef = useRef(null);
  const demoBotPannerRef = useRef(null);
  const demoBotFilterRef = useRef(null);

  const toggleDemoBot = () => {
    const nextState = !demoBotActive;
    setDemoBotActive(nextState);

    const ctx = getAudioContext();
    ctx.resume();

    if (nextState) {
      // Spawn Bot inside the 100px earshot of player's current position (60px to the right)
      const cur = playerRef.current;
      const botX = clamp(cur.x + 60, 35, WIDTH - 35);
      const botY = cur.y;
      demoBotPosRef.current = { x: botX, y: botY };

      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      const filter = ctx.createBiquadFilter();

      filter.type = "lowpass";
      filter.frequency.setValueAtTime(18000, ctx.currentTime);
      gain.gain.setValueAtTime(0.5, ctx.currentTime);

      filter.connect(panner);
      panner.connect(gain);
      gain.connect(ctx.destination);

      demoBotGainRef.current = gain;
      demoBotPannerRef.current = panner;
      demoBotFilterRef.current = filter;

      // Play melodic harmonic beacon notes every 650ms
      let noteIndex = 0;
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6 (clear pleasant chimes)

      const playBeaconNote = () => {
        if (!demoBotGainRef.current) return;
        const osc = ctx.createOscillator();
        const noteEnv = ctx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(notes[noteIndex % notes.length], ctx.currentTime);
        noteIndex++;

        noteEnv.gain.setValueAtTime(0.35, ctx.currentTime);
        noteEnv.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);

        osc.connect(noteEnv);
        noteEnv.connect(filter);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.45);
      };

      playBeaconNote();
      demoBotIntervalRef.current = setInterval(playBeaconNote, 650);
      setVoiceStatus("🤖 Sound Bot active! Walk around it to hear volume drop-off and 3D stereo panning.");
    } else {
      if (demoBotIntervalRef.current) {
        clearInterval(demoBotIntervalRef.current);
        demoBotIntervalRef.current = null;
      }
      if (demoBotGainRef.current) {
        try { demoBotGainRef.current.disconnect(); } catch {}
        demoBotGainRef.current = null;
      }
      setVoiceStatus("Sound Bot stopped.");
    }
  };

  // Speaker and Web Audio Output Tester (Plays Left ear, Right ear, Center chime)
  const testAudioOutput = () => {
    const ctx = getAudioContext();
    ctx.resume();

    const playPing = (pan, freq, delayTime, label) => {
      setTimeout(() => {
        const osc = ctx.createOscillator();
        const panner = ctx.createStereoPanner();
        const gain = ctx.createGain();

        panner.pan.setValueAtTime(pan, ctx.currentTime);
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        osc.type = "triangle";

        gain.gain.setValueAtTime(0.4, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

        osc.connect(panner);
        panner.connect(gain);
        gain.connect(ctx.destination);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
        setVoiceStatus(`🔊 Audio Test: ${label}`);
      }, delayTime);
    };

    playPing(-0.85, 523.25, 0, "Left Ear (523Hz)");
    playPing(0.85, 659.25, 450, "Right Ear (659Hz)");
    playPing(0, 783.99, 900, "Center Stereo (784Hz)");
  };

  // Run Mid-Project Review: Spatial Audit Benchmark (< 20ms proof)
  const runSpatialAudit = async () => {
    try {
      const res = await fetch(`${API_URL}/api/spatial-audit`);
      const data = await res.json();
      setSpatialAudit(data.spatialAuditReview);

      const meshRes = await fetch(`${API_URL}/api/mesh-stats`);
      const meshData = await meshRes.json();
      setMeshStats(meshData);

      setShowAuditModal(true);
    } catch (err) {
      setError(`Could not fetch Spatial Audit: ${err.message}`);
    }
  };

  // Position update and socket emission (Week 1)
  const updatePosition = useCallback((next) => {
    playerRef.current = { ...playerRef.current, ...next };
    setPlayer(playerRef.current);
    if (localIdRef.current) {
      positionsRef.current.set(localIdRef.current, playerRef.current);
    }
    socketRef.current?.emit("player:move", next);
  }, []);

  // WebRTC Audio Track Connection into Web Audio API (Week 3 Dynamic Attenuation)
  const cleanupPeerAudio = useCallback((peerId) => {
    const pc = peerConnectionsRef.current.get(peerId);
    if (pc) {
      pc.close();
      peerConnectionsRef.current.delete(peerId);
    }
    const nodes = peerAudioNodesRef.current.get(peerId);
    if (nodes) {
      try {
        nodes.source.disconnect();
        nodes.filter.disconnect();
        nodes.panner.disconnect();
        nodes.gain.disconnect();
      } catch {}
      peerAudioNodesRef.current.delete(peerId);
    }
    const audioEl = peerAudioElementsRef.current.get(peerId);
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      peerAudioElementsRef.current.delete(peerId);
    }
    setActivePeersCount(peerConnectionsRef.current.size);
  }, []);

  const createPeerConnection = useCallback((peerId) => {
    let pc = peerConnectionsRef.current.get(peerId);
    if (pc) return pc;

    const socket = socketRef.current;
    if (!socket || !localStreamRef.current) return null;

    pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    localStreamRef.current.getTracks().forEach((track) => pc.addTrack(track, localStreamRef.current));

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("webrtc:ice-candidate", { to: peerId, candidate: event.candidate });
      }
    };

    // Week 3: Hook remote audio track into Web Audio API graph
    pc.ontrack = (event) => {
      if (event.track.kind !== "audio") return;
      const remoteStream = event.streams[0];
      if (!remoteStream) return;

      const audioCtx = getAudioContext();
      audioCtx.resume();

      // Ensure Chrome decodes the incoming WebRTC stream
      let audioEl = peerAudioElementsRef.current.get(peerId);
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.srcObject = remoteStream;
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.volume = 0; // Handled through Web Audio graph below
        audioEl.play().catch(() => {});
        peerAudioElementsRef.current.set(peerId, audioEl);
      }

      let nodes = peerAudioNodesRef.current.get(peerId);
      if (!nodes) {
        const source = audioCtx.createMediaStreamSource(remoteStream);
        const filter = audioCtx.createBiquadFilter();
        const panner = audioCtx.createStereoPanner();
        const gain = audioCtx.createGain();
        const analyser = audioCtx.createAnalyser();

        filter.type = "lowpass";
        filter.frequency.setValueAtTime(20000, audioCtx.currentTime);
        gain.gain.setValueAtTime(1.0, audioCtx.currentTime);

        source.connect(filter);
        filter.connect(panner);
        panner.connect(gain);
        gain.connect(analyser);
        gain.connect(audioCtx.destination);

        nodes = { source, filter, panner, gain, analyser };
        peerAudioNodesRef.current.set(peerId, nodes);
      }
      setVoiceStatus("Voice connected! Speaking with nearby peers via 3D Spatial Audio.");
      setActivePeersCount(peerConnectionsRef.current.size);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        cleanupPeerAudio(peerId);
      }
    };

    peerConnectionsRef.current.set(peerId, pc);
    setActivePeersCount(peerConnectionsRef.current.size);
    return pc;
  }, [cleanupPeerAudio, getAudioContext]);

  // Connect WebRTC peer only when voice is active AND within earshot (Week 2 & 3)
  const connectPeerIfEarshot = useCallback(async (peerId) => {
    const socket = socketRef.current;
    const localId = localIdRef.current;
    if (!socket || !localId || !localStreamRef.current || !voiceReadyIdsRef.current.has(peerId) || peerId === localId) return;

    // Check distance
    const local = playerRef.current;
    const remote = positionsRef.current.get(peerId);
    if (!remote) return;
    const dist = Math.hypot(local.x - remote.x, local.y - remote.y);
    if (dist > HEARING_RADIUS) {
      // Outside 100px: teardown to optimize WebRTC mesh (Week 3 Mesh Scaling)
      cleanupPeerAudio(peerId);
      return;
    }

    const pc = createPeerConnection(peerId);
    if (!pc) return;

    // Tie-break: lowest ID sends the offer
    if (localId.localeCompare(peerId) < 0 && !pc.localDescription) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("webrtc:offer", { to: peerId, description: pc.localDescription });
      } catch (err) {
        console.error("WebRTC offer failed:", err);
      }
    }
  }, [cleanupPeerAudio, createPeerConnection]);

  // Start Microphone
  const startVoice = async () => {
    if (localStreamRef.current) return;
    setError("");
    try {
      const audioCtx = getAudioContext();
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access requires HTTPS or localhost.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });

      localStreamRef.current = stream;

      // Local microphone analyser
      const micSource = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      micSource.connect(analyser);
      localAnalyserRef.current = analyser;

      setVoiceOn(true);
      setVoiceStatus("Microphone live. Establishing spatial audio mesh with nearby peers.");
      socketRef.current?.emit("voice:ready");
    } catch (err) {
      setError(err.message || "Microphone access denied.");
      setVoiceStatus("Microphone unavailable");
    }
  };

  const stopVoice = () => {
    socketRef.current?.emit("voice:stop");
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    localAnalyserRef.current = null;
    [...peerConnectionsRef.current.keys()].forEach(cleanupPeerAudio);
    voiceReadyIdsRef.current.clear();
    setVoiceOn(false);
    setVoiceStatus("Voice chat off");
  };

  const toggleMute = () => {
    if (!localStreamRef.current) return;
    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setMuted(!audioTrack.enabled);
    }
  };

  // Socket.IO Setup
  useEffect(() => {
    const socket = io(API_URL, { transports: ["websocket", "polling"], reconnection: true });
    socketRef.current = socket;

    socket.on("connect", () => {
      localIdRef.current = socket.id;
      setConnected(true);
      setError("");
      positionsRef.current.set(socket.id, playerRef.current);
    });

    socket.on("disconnect", () => {
      setConnected(false);
      setError("Disconnected from server. Attempting reconnect…");
    });

    socket.on("users:update", (list) => {
      setUsers(list);
      list.forEach((u) => {
        positionsRef.current.set(u.id, { x: u.x, y: u.y, color: u.color, name: u.name });
      });
    });

    socket.on("user:joined", (user) => {
      setUsers((old) => [...old.filter((u) => u.id !== user.id), user]);
      positionsRef.current.set(user.id, user);
    });

    socket.on("player:moved", ({ id, x, y }) => {
      const existing = positionsRef.current.get(id);
      positionsRef.current.set(id, { ...existing, x, y });
      setUsers((old) => old.map((u) => (u.id === id ? { ...u, x, y } : u)));
      // Check if this peer is now within/outside earshot
      connectPeerIfEarshot(id);
    });

    socket.on("user:left", (id) => {
      setUsers((old) => old.filter((u) => u.id !== id));
      positionsRef.current.delete(id);
      voiceReadyIdsRef.current.delete(id);
      cleanupPeerAudio(id);
    });

    socket.on("proximity:update", setNearbyUsers);

    socket.on("voice:ready-users", (ids) => {
      ids.forEach((id) => voiceReadyIdsRef.current.add(id));
      ids.forEach(connectPeerIfEarshot);
    });

    socket.on("voice:user-ready", ({ id }) => {
      voiceReadyIdsRef.current.add(id);
      connectPeerIfEarshot(id);
    });

    socket.on("voice:user-stopped", ({ id }) => {
      voiceReadyIdsRef.current.delete(id);
      cleanupPeerAudio(id);
    });

    // Week 2: Filtered Signaling Relay Handlers
    socket.on("webrtc:offer", async ({ from, description }) => {
      if (!localStreamRef.current || !voiceReadyIdsRef.current.has(from)) return;
      try {
        const pc = createPeerConnection(from);
        if (!pc) return;
        await pc.setRemoteDescription(description);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("webrtc:answer", { to: from, description: pc.localDescription });
      } catch (err) {
        console.error("Handling WebRTC offer failed:", err);
      }
    });

    socket.on("webrtc:answer", async ({ from, description }) => {
      const pc = peerConnectionsRef.current.get(from);
      if (pc) {
        try { await pc.setRemoteDescription(description); } catch {}
      }
    });

    socket.on("webrtc:ice-candidate", async ({ from, candidate }) => {
      const pc = peerConnectionsRef.current.get(from);
      if (pc && candidate) {
        try { await pc.addIceCandidate(candidate); } catch {}
      }
    });

    socket.on("webrtc:earshot-blocked", ({ reason }) => {
      console.warn("Signaling Gate:", reason);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      peerConnectionsRef.current.forEach((pc) => pc.close());
      peerConnectionsRef.current.clear();
      if (demoBotIntervalRef.current) {
        clearInterval(demoBotIntervalRef.current);
        demoBotIntervalRef.current = null;
      }
    };
  }, [cleanupPeerAudio, connectPeerIfEarshot, createPeerConnection]);

  // Keyboard and Click-to-Move Controls (Week 1 Movement)
  useEffect(() => {
    const handleKeyDown = (e) => {
      const key = e.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"].includes(key)) {
        e.preventDefault();
        keysRef.current.add(key);
        waypointRef.current = null; // Keyboard overrides waypoint
      }
    };

    const handleKeyUp = (e) => keysRef.current.delete(e.key.toLowerCase());
    const handleBlur = () => keysRef.current.clear();

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    let frameId;
    const moveLoop = () => {
      const keys = keysRef.current;
      const cur = playerRef.current;
      let dx = 0;
      let dy = 0;

      if (keys.has("arrowup") || keys.has("w")) dy -= SPEED;
      if (keys.has("arrowdown") || keys.has("s")) dy += SPEED;
      if (keys.has("arrowleft") || keys.has("a")) dx -= SPEED;
      if (keys.has("arrowright") || keys.has("d")) dx += SPEED;

      // Waypoint click-to-move handling
      if (dx === 0 && dy === 0 && waypointRef.current) {
        const wp = waypointRef.current;
        const wdx = wp.x - cur.x;
        const wdy = wp.y - cur.y;
        const dist = Math.hypot(wdx, wdy);
        if (dist > SPEED) {
          dx = (wdx / dist) * SPEED;
          dy = (wdy / dist) * SPEED;
        } else {
          waypointRef.current = null;
        }
      }

      if (dx !== 0 && dy !== 0) {
        dx *= Math.SQRT1_2;
        dy *= Math.SQRT1_2;
      }

      if (dx !== 0 || dy !== 0) {
        const nextX = clamp(cur.x + dx, 16, WIDTH - 16);
        const nextY = clamp(cur.y + dy, 16, HEIGHT - 16);

        let finalX = cur.x;
        let finalY = cur.y;

        // Anti-stuck solver: if current position was somehow in obstacle, immediately allow moving
        if (collidesWithObstacle(cur.x, cur.y)) {
          finalX = nextX;
          finalY = nextY;
        } else if (!collidesWithObstacle(nextX, nextY)) {
          finalX = nextX;
          finalY = nextY;
        } else if (!collidesWithObstacle(nextX, cur.y)) {
          finalX = nextX; // slide along horizontal axis
        } else if (!collidesWithObstacle(cur.x, nextY)) {
          finalY = nextY; // slide along vertical axis
        }

        if (finalX !== cur.x || finalY !== cur.y) {
          updatePosition({ x: finalX, y: finalY });
        }
      }

      frameId = requestAnimationFrame(moveLoop);
    };

    frameId = requestAnimationFrame(moveLoop);
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [updatePosition]);

  // Handle canvas click-to-move
  const handleCanvasClick = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus();
    const rect = canvas.getBoundingClientRect();
    const scaleX = WIDTH / rect.width;
    const scaleY = HEIGHT / rect.height;
    const targetX = clamp((e.clientX - rect.left) * scaleX, 20, WIDTH - 20);
    const targetY = clamp((e.clientY - rect.top) * scaleY, 20, HEIGHT - 20);

    waypointRef.current = { x: targetX, y: targetY };
  };

  // Explicit manual step movement (for UI controls / mobile / trackpad)
  const stepMove = (dir) => {
    waypointRef.current = null;
    const cur = playerRef.current;
    let dx = 0;
    let dy = 0;
    const STEP = 20;
    if (dir === "up") dy -= STEP;
    if (dir === "down") dy += STEP;
    if (dir === "left") dx -= STEP;
    if (dir === "right") dx += STEP;

    const nextX = clamp(cur.x + dx, 16, WIDTH - 16);
    const nextY = clamp(cur.y + dy, 16, HEIGHT - 16);

    let fx = cur.x;
    let fy = cur.y;
    if (collidesWithObstacle(cur.x, cur.y) || !collidesWithObstacle(nextX, nextY)) {
      fx = nextX; fy = nextY;
    } else if (!collidesWithObstacle(nextX, cur.y)) {
      fx = nextX;
    } else if (!collidesWithObstacle(cur.x, nextY)) {
      fy = nextY;
    }
    updatePosition({ x: fx, y: fy });
  };

  const centerAvatar = () => {
    waypointRef.current = null;
    updatePosition({ x: 420, y: 380 });
  };

  // 60 FPS HTML5 Canvas Rendering Engine (Week 1 & 4) + Dynamic Attenuation (Week 3)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    let animId;
    let waveAngle = 0;

    const render = () => {
      waveAngle += 0.05;
      const local = playerRef.current;

      // Retina High-DPI Canvas scaling
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== WIDTH * dpr) {
        canvas.width = WIDTH * dpr;
        canvas.height = HEIGHT * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.clearRect(0, 0, WIDTH, HEIGHT);

      // Floor background with architectural grid
      ctx.fillStyle = "#090d16";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      roundedRect(ctx, 10, 10, WIDTH - 20, HEIGHT - 20, 10, "#0f172a", "#1e293b");

      // Subtle floor tiles
      ctx.save();
      ctx.beginPath();
      ctx.rect(12, 12, WIDTH - 24, HEIGHT - 24);
      ctx.clip();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.04)";
      ctx.lineWidth = 1;
      for (let x = 20; x < WIDTH; x += 35) {
        ctx.beginPath(); ctx.moveTo(x, 12); ctx.lineTo(x, HEIGHT - 12); ctx.stroke();
      }
      for (let y = 20; y < HEIGHT; y += 35) {
        ctx.beginPath(); ctx.moveTo(12, y); ctx.lineTo(WIDTH - 12, y); ctx.stroke();
      }
      ctx.restore();

      // Outer border
      ctx.strokeStyle = "#334155";
      ctx.lineWidth = 3;
      ctx.strokeRect(8, 8, WIDTH - 16, HEIGHT - 16);

      // 1. Private Executive Rooms (Left)
      roundedRect(ctx, 25, 25, 220, 430, 6, "rgba(16, 185, 129, 0.03)", "#1e293b");
      roundedRect(ctx, 32, 32, 206, 126, 4, "#131e33");
      roundedRect(ctx, 32, 172, 206, 126, 4, "#131e33");
      roundedRect(ctx, 32, 312, 206, 136, 4, "#131e33");

      ctx.fillStyle = "#10b981";
      ctx.font = "bold 10px monospace";
      ctx.fillText("CEO EXECUTIVE SUITE", 45, 50);
      ctx.fillStyle = "#06b6d4";
      ctx.fillText("COLLABORATION LAB", 45, 190);
      ctx.fillStyle = "#8b5cf6";
      ctx.fillText("QUIET FOCUS POD", 45, 330);

      // Furniture inside private rooms
      roundedRect(ctx, 72, 73, 112, 34, 5, "#1e293b", "#334155");
      roundedRect(ctx, 108, 81, 40, 18, 3, "#3b82f6");
      drawPlant(ctx, 210, 65, 0.9);

      roundedRect(ctx, 72, 213, 112, 34, 5, "#1e293b", "#334155");
      roundedRect(ctx, 108, 221, 40, 18, 3, "#06b6d4");

      roundedRect(ctx, 85, 365, 86, 35, 5, "#1e293b", "#334155");
      roundedRect(ctx, 111, 373, 35, 18, 3, "#8b5cf6");
      drawPlant(ctx, 210, 350, 0.9);

      // Private room solid walls
      ctx.strokeStyle = "#475569";
      ctx.lineWidth = WALL_THICKNESS;
      ctx.lineCap = "square";
      [
        [25, 25, 245, 25], [25, 25, 25, 455],
        [245, 25, 245, 250], [245, 330, 245, 455],
        [25, 165, 98, 165], [145, 165, 245, 165],
        [25, 305, 98, 305], [145, 305, 245, 305],
        [25, 455, 245, 455],
      ].forEach(([x1, y1, x2, y2]) => {
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      });

      // 2. Central Open Workspace
      ctx.fillStyle = "#94a3b8";
      ctx.font = "bold 12px monospace";
      ctx.fillText("OPEN WORKSPACE (DESKS 1-9)", 350, 52);
      DESKS.forEach(([x, y], i) => drawWorkstation(ctx, x, y, `WK-${i + 1}`));

      // 3. Executive Meeting Room (Top Right)
      roundedRect(ctx, ROOM.left, ROOM.top, ROOM.right - ROOM.left, ROOM.bottom - ROOM.top, 8, "rgba(59, 130, 246, 0.05)", "#1e3a8a");
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = WALL_THICKNESS;
      [
        [ROOM.left, ROOM.top, ROOM.right, ROOM.top],
        [ROOM.left, ROOM.top, ROOM.left, ROOM.bottom],
        [ROOM.right, ROOM.top, ROOM.right, ROOM.bottom],
        [ROOM.left, ROOM.bottom, DOORWAY.left, ROOM.bottom],
        [DOORWAY.right, ROOM.bottom, ROOM.right, ROOM.bottom],
      ].forEach(([x1, y1, x2, y2]) => {
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      });

      ctx.lineWidth = 1;
      ctx.lineCap = "butt";
      ctx.fillStyle = "#60a5fa";
      ctx.font = "bold 13px monospace";
      ctx.fillText("MEETING ROOM", 710, 50);

      // Doorway indicator
      ctx.fillStyle = "#38bdf8";
      ctx.font = "bold 9px monospace";
      ctx.fillText("ENTRANCE", DOORWAY.left + 5, ROOM.bottom - 6);

      // Conference Table & Chairs
      roundedRect(ctx, 700, 72, 135, 48, 8, "#1e293b", "#3b82f6");
      roundedRect(ctx, 747, 84, 40, 24, 4, "#0f172a", "#60a5fa");
      [[708, 58], [741, 58], [774, 58], [807, 58], [708, 125], [741, 125], [774, 125], [807, 125]].forEach(([x, y]) => {
        roundedRect(ctx, x, y, 16, 9, 3, "#2563eb");
      });

      // 4. Breakout Lounge
      roundedRect(ctx, 665, 240, 210, 205, 12, "rgba(245, 158, 11, 0.03)", "#334155");
      ctx.fillStyle = "#f59e0b";
      ctx.font = "bold 11px monospace";
      ctx.fillText("BREAKOUT LOUNGE", 725, 262);
      roundedRect(ctx, 695, 285, 145, 38, 8, "#334155");
      roundedRect(ctx, 703, 291, 62, 26, 5, "#475569");
      roundedRect(ctx, 770, 291, 62, 26, 5, "#475569");
      roundedRect(ctx, 730, 350, 75, 40, 7, "#1e293b", "#475569");
      drawPlant(ctx, 685, 410, 1.1);
      drawPlant(ctx, 850, 410, 1.1);
      drawPlant(ctx, 265, 55, 0.9);
      drawPlant(ctx, 630, 420, 0.9);

      // 5. Waypoint Target Flag (if navigating via click-to-move)
      if (waypointRef.current) {
        const wp = waypointRef.current;
        ctx.beginPath();
        ctx.arc(wp.x, wp.y, 6 + Math.sin(waveAngle * 4) * 2, 0, Math.PI * 2);
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // 6. Week 3 Dynamic Attenuation & Stereo Audio Updating
      const audioCtx = audioCtxRef.current;
      peerAudioNodesRef.current.forEach((nodes, id) => {
        const remote = positionsRef.current.get(id);
        if (!remote || !audioCtx) {
          nodes.gain.gain.setTargetAtTime(0, audioCtx?.currentTime || 0, 0.05);
          return;
        }

        const dx = remote.x - local.x;
        const dy = remote.y - local.y;
        const dist = Math.hypot(dx, dy);

        let vol = 0;
        let pan = 0;

        if (dist <= HEARING_RADIUS) {
          // Attenuation Curve
          if (attenuationMode === "linear") {
            vol = Math.max(0, 1 - dist / HEARING_RADIUS);
          } else {
            vol = Math.exp(-2.2 * (dist / HEARING_RADIUS));
          }

          // 3D Stereo Panning (-1 = Left ear, +1 = Right ear)
          pan = clamp(dx / HEARING_RADIUS, -1, 1);

          // Acoustic Obstacle Muffling: Check wall occlusion
          const isOccluded = rayHitsWall(local.x, local.y, remote.x, remote.y);
          if (isOccluded) {
            nodes.filter.frequency.setTargetAtTime(500, audioCtx.currentTime, 0.05); // Muffled lowpass
            vol *= 0.5; // Dampen volume through walls
          } else {
            nodes.filter.frequency.setTargetAtTime(20000, audioCtx.currentTime, 0.05);
          }
        }

        nodes.gain.gain.setTargetAtTime(vol, audioCtx.currentTime, 0.05);
        nodes.panner.pan.setTargetAtTime(pan, audioCtx.currentTime, 0.05);
      });

      // Update Demo Bot Audio if Active
      if (demoBotActive && demoBotGainRef.current && demoBotPannerRef.current && audioCtx) {
        const botPos = demoBotPosRef.current;
        const botX = botPos.x;
        const botY = botPos.y;
        const dx = botX - local.x;
        const dy = botY - local.y;
        const dist = Math.hypot(dx, dy);

        let vol = 0;
        let pan = 0;
        if (dist <= HEARING_RADIUS) {
          vol = Math.max(0, 1 - dist / HEARING_RADIUS) * 0.5;
          pan = clamp(dx / HEARING_RADIUS, -1, 1);
          const isOccluded = rayHitsWall(local.x, local.y, botX, botY);
          if (isOccluded && demoBotFilterRef.current) {
            demoBotFilterRef.current.frequency.setTargetAtTime(500, audioCtx.currentTime, 0.05);
            vol *= 0.5;
          } else if (demoBotFilterRef.current) {
            demoBotFilterRef.current.frequency.setTargetAtTime(18000, audioCtx.currentTime, 0.05);
          }
        }
        demoBotGainRef.current.gain.setTargetAtTime(vol, audioCtx.currentTime, 0.05);
        demoBotPannerRef.current.pan.setTargetAtTime(pan, audioCtx.currentTime, 0.05);

        // Draw Demo Bot Avatar
        ctx.beginPath();
        ctx.arc(botX, botY, 14, 0, Math.PI * 2);
        ctx.fillStyle = "#f59e0b";
        ctx.fill();
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = "#fef3c7";
        ctx.font = "bold 10px monospace";
        ctx.fillText("BOT 🔊", botX - 16, botY - 20);

        // Demo Bot Audio waves
        if (dist <= HEARING_RADIUS) {
          const r = 18 + ((waveAngle * 25) % 35);
          ctx.beginPath();
          ctx.arc(botX, botY, r, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(245, 158, 11, ${Math.max(0, 1 - r / 50)})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // 7. Local Hearing Proximity Circle (100px)
      ctx.beginPath();
      ctx.arc(local.x, local.y, HEARING_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(16, 185, 129, 0.06)";
      ctx.fill();
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.stroke();
      ctx.setLineDash([]);

      // 8. Other Users
      users.filter((u) => u.id !== localIdRef.current).forEach((peer) => {
        const pos = positionsRef.current.get(peer.id) || peer;
        const dist = Math.hypot(local.x - pos.x, local.y - pos.y);
        const inEarshot = dist <= HEARING_RADIUS;

        // Line to peer in earshot with distance badge
        if (inEarshot) {
          ctx.beginPath();
          ctx.moveTo(local.x, local.y);
          ctx.lineTo(pos.x, pos.y);
          ctx.strokeStyle = "rgba(56, 189, 248, 0.4)";
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // Distance badge
          const midX = (local.x + pos.x) / 2;
          const midY = (local.y + pos.y) / 2;
          roundedRect(ctx, midX - 22, midY - 10, 44, 20, 4, "#0f172a", "#38bdf8");
          ctx.fillStyle = "#38bdf8";
          ctx.font = "bold 9px monospace";
          ctx.fillText(`${Math.round(dist)}px`, midX - 14, midY + 4);
        }

        // Peer Avatar
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, PLAYER_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = pos.color || "#f97316";
        ctx.fill();
        ctx.strokeStyle = inEarshot ? "#38bdf8" : "#475569";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Peer Name
        ctx.fillStyle = "#f8fafc";
        ctx.font = "bold 11px system-ui";
        ctx.fillText(pos.name || "Dev", pos.x - 20, pos.y - 20);

        // Proximity indicator dot
        if (inEarshot) {
          ctx.beginPath();
          ctx.arc(pos.x + 12, pos.y - 12, 4, 0, Math.PI * 2);
          ctx.fillStyle = "#10b981";
          ctx.fill();
        }
      });

      // 9. Local Avatar (YOU)
      // Speaking ripples if microphone has volume
      if (voiceOn && !muted && localAnalyserRef.current) {
        const dataArr = new Uint8Array(localAnalyserRef.current.frequencyBinCount);
        localAnalyserRef.current.getByteFrequencyData(dataArr);
        const avg = dataArr.reduce((a, b) => a + b, 0) / dataArr.length;
        if (avg > 15) {
          const rippleR = PLAYER_RADIUS + (avg / 255) * 25;
          ctx.beginPath();
          ctx.arc(local.x, local.y, rippleR, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(59, 130, 246, 0.6)";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      ctx.beginPath();
      ctx.arc(local.x, local.y, PLAYER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = player.color || "#3b82f6";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px monospace";
      ctx.fillText("YOU", local.x - 9, local.y + 4);

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [attenuationMode, demoBotActive, muted, player, users, voiceOn]);

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="brand-section">
          <div className="brand-icon">🎙️</div>
          <div className="brand-text">
            <h1>ProxiSpeak</h1>
            <p>Geospatial Proximity Audio Virtual Office (2D Canvas)</p>
          </div>
        </div>

        <div className="header-badges">
          <div className={`badge ${connected ? "badge-connected" : "badge-disconnected"}`}>
            <span className={`dot ${connected ? "pulse" : ""}`}></span>
            {connected ? "Server Connected" : "Connecting..."}
          </div>
          <div className="badge">
            👥 {users.length} Active {users.length === 1 ? "User" : "Users"}
          </div>
          <div className="badge">
            🎧 Earshot: {HEARING_RADIUS}px
          </div>
          <div className={`badge ${voiceOn ? "badge-voice-on" : ""}`}>
            {voiceOn ? (muted ? "🔇 Mic Muted" : "🎙️ Voice Mesh Live") : "🔇 Mic Off"}
          </div>
        </div>
      </header>

      {/* Control Toolbar */}
      <section className="toolbar-section">
        <div className="toolbar-left">
          {!voiceOn ? (
            <button className="btn btn-primary" onClick={startVoice}>
              🎙️ Enable Voice Chat
            </button>
          ) : (
            <>
              <button className="btn btn-danger" onClick={stopVoice}>
                🛑 Stop Voice
              </button>
              <button className={`btn btn-outline ${muted ? "btn-active" : ""}`} onClick={toggleMute}>
                {muted ? "🔊 Unmute Mic" : "🔇 Mute Mic"}
              </button>
            </>
          )}

          <button
            className={`btn btn-outline ${demoBotActive ? "btn-active" : ""}`}
            onClick={toggleDemoBot}
            title="Spawns an interactive spatial audio synth bot to test distance drop-off & stereo panning immediately"
          >
            {demoBotActive ? "🔊 Stop Sound Bot" : "🤖 Spawn Sound Bot"}
          </button>

          <button
            className="btn btn-outline"
            onClick={testAudioOutput}
            title="Test browser audio speakers (Plays Left, Right, and Center stereo chimes)"
          >
            🔊 Test Audio Output
          </button>

          <button
            className="btn btn-outline"
            onClick={() => setAttenuationMode((m) => (m === "linear" ? "exponential" : "linear"))}
            title="Toggle between Linear and Realistic Exponential sound attenuation curves"
          >
            📉 Curve: {attenuationMode === "linear" ? "Linear Drop-off" : "Realistic Exp"}
          </button>
        </div>

        <div className="toolbar-right">
          <button className="btn btn-audit" onClick={runSpatialAudit}>
            ⚡ Run Spatial Audit (&lt; 20ms)
          </button>
        </div>
      </section>

      {/* Error Message */}
      {error && <div className="connection-error">{error}</div>}

      {/* 2D Canvas Viewport */}
      <div className="canvas-wrapper">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className="canvas-viewport"
          style={{ aspectRatio: `${WIDTH} / ${HEIGHT}`, outline: "none" }}
          onClick={handleCanvasClick}
          title="Click to walk or use WASD / Arrow Keys"
        />

        <div className="canvas-overlay-hud">
          <div className="hud-pill">
            Position: <strong>X {Math.round(player.x)}, Y {Math.round(player.y)}</strong>
          </div>
          <div className="hud-pill">
            Hearing Radius: <strong>{HEARING_RADIUS}px</strong>
          </div>
          <div className="hud-pill">
            Active Earshot Links: <strong>{activePeersCount}</strong>
          </div>
        </div>

        <div className="canvas-controls-overlay">
          Move with <strong>W, A, S, D</strong> / Arrow keys or <strong>Click on Floor</strong>
        </div>
      </div>

      {/* Walking Controls & D-Pad Bar */}
      <div className="walking-controls-bar">
        <div className="walking-instructions">
          🎮 <strong>How to Walk:</strong> Click anywhere on the floor, use <strong>W, A, S, D / Arrow keys</strong>, or use the buttons 👉
        </div>
        <div className="dpad-buttons">
          <button className="dpad-btn" onClick={() => stepMove("up")} title="Walk Up (W / Up Arrow)">⬆️</button>
          <button className="dpad-btn" onClick={() => stepMove("left")} title="Walk Left (A / Left Arrow)">⬅️</button>
          <button className="dpad-btn" onClick={() => stepMove("down")} title="Walk Down (S / Down Arrow)">⬇️</button>
          <button className="dpad-btn" onClick={() => stepMove("right")} title="Walk Right (D / Right Arrow)">➡️</button>
          <button className="btn btn-outline" onClick={centerAvatar} title="Reset position to open hallway aisle">
            🎯 Reset Position
          </button>
        </div>
      </div>

      {/* Real-time Dashboard Grid */}
      <div className="dashboard-grid">
        {/* Radar & Nearby Users */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <span className="icon">📡</span> Proximity Radar (Users in 100px Earshot)
            </h2>
            <span className="badge">{nearbyUsers.length} in range</span>
          </div>

          <div className="proximity-list">
            {nearbyUsers.length === 0 ? (
              <div className="empty-radar">
                No colleagues within your 100-pixel hearing radius.
                <br />
                Walk closer to another avatar or spawn the <strong>Sound Bot</strong> to join a conversation!
              </div>
            ) : (
              nearbyUsers.map((u) => {
                const volPct = Math.max(0, Math.round((1 - u.distance / HEARING_RADIUS) * 100));
                const remote = users.find((usr) => usr.id === u.id);
                const dx = remote ? remote.x - player.x : 0;
                const panLabel = dx < -15 ? "Left Ear" : dx > 15 ? "Right Ear" : "Center Stereo";

                return (
                  <div key={u.id} className="proximity-item">
                    <div className="user-info">
                      <div className="user-avatar-badge" style={{ backgroundColor: u.color || "#f97316" }}>
                        {u.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div className="user-name">{u.name}</div>
                        <div className="user-distance">{u.distance}px away</div>
                      </div>
                    </div>

                    <div className="audio-meters">
                      <div className="meter-wrapper">
                        <span className="meter-label">Volume: {volPct}%</span>
                        <div className="volume-bar-bg">
                          <div className="volume-bar-fill" style={{ width: `${volPct}%` }}></div>
                        </div>
                      </div>
                      <span className="pan-indicator">{panLabel}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Spatial Audio Engine Diagnostics */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <span className="icon">🎛️</span> Spatial Audio & WebRTC Mesh Engine
            </h2>
            <span className="badge badge-connected">Week 1-3 Spec Active</span>
          </div>

          <div className="diag-grid">
            <div className="diag-item">
              <span className="label">Web Audio Mixer</span>
              <span className="value success">Web Audio API (Gain + Panner)</span>
            </div>

            <div className="diag-item">
              <span className="label">Spatial Attenuation</span>
              <span className="value accent">{attenuationMode === "linear" ? "Linear Drop-off" : "Exponential (Inverse Exp)"}</span>
            </div>

            <div className="diag-item">
              <span className="label">3D Stereo Panning</span>
              <span className="value success">StereoPannerNode (-1.0 to +1.0)</span>
            </div>

            <div className="diag-item">
              <span className="label">Wall Sound Occlusion</span>
              <span className="value accent">Biquad Lowpass Filter (500Hz)</span>
            </div>

            <div className="diag-item">
              <span className="label">WebRTC Signaling Gate</span>
              <span className="value success">100px Earshot Restriced (Week 2)</span>
            </div>

            <div className="diag-item">
              <span className="label">Mesh Optimization</span>
              <span className="value accent">Proximity Scoped (O(1) vs O(N²))</span>
            </div>
          </div>

          <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
            {voiceStatus}
          </p>
        </div>
      </div>

      {/* Mid-Project Review: Spatial Audit Benchmark Modal */}
      {showAuditModal && spatialAudit && (
        <div className="modal-backdrop" onClick={() => setShowAuditModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>⚡ Mid-Project Review: Geospatial Audit Benchmark</h3>
              <button className="close-btn" onClick={() => setShowAuditModal(false)}>✕</button>
            </div>

            <div className="modal-body">
              <div className={`audit-score-card ${spatialAudit.passedAudit ? "" : "warning"}`}>
                <div>
                  <div className="audit-status-badge">
                    {spatialAudit.passedAudit ? "✅ AUDIT PASSED (< 20ms REQUIREMENT)" : "⚠️ AUDIT WARNING"}
                  </div>
                  <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
                    {spatialAudit.verdict}
                  </p>
                </div>
                <div className="audit-latency-value">
                  {spatialAudit.geospatialEngineLatencyMs} ms
                </div>
              </div>

              <table className="audit-details-table">
                <tbody>
                  <tr>
                    <td>Target Execution Time:</td>
                    <td>{spatialAudit.targetExecutionTime}</td>
                  </tr>
                  <tr>
                    <td>Geospatial Engine Latency:</td>
                    <td style={{ color: "#34d399" }}>{spatialAudit.geospatialEngineLatencyMs} ms</td>
                  </tr>
                  <tr>
                    <td>Concurrent Avatars Tested:</td>
                    <td>{spatialAudit.simulatedConcurrentAvatars} Avatars</td>
                  </tr>
                  <tr>
                    <td>Proximity Clusters Formed:</td>
                    <td>{spatialAudit.clustersIdentified} spatial clusters</td>
                  </tr>
                  <tr>
                    <td>Database Backend:</td>
                    <td>{spatialAudit.activeDatabaseType}</td>
                  </tr>
                  {meshStats && (
                    <>
                      <tr>
                        <td>Full Mesh Overhead Avoidance:</td>
                        <td style={{ color: "#60a5fa" }}>{meshStats.meshEfficiencyReduction}</td>
                      </tr>
                      <tr>
                        <td>Pub/Sub Clustering Bus:</td>
                        <td>{meshStats.redisPubSub}</td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>

              <div style={{ marginTop: "10px" }}>
                <span style={{ fontSize: "12px", fontWeight: "600", color: "var(--text-secondary)" }}>
                  Sample Proximity Clusters Output ($near 100px):
                </span>
                <pre className="code-block">
                  {JSON.stringify(spatialAudit.sampleClusters, null, 2)}
                </pre>
              </div>

              <button
                className="btn btn-primary"
                style={{ width: "100%", justifyContent: "center", marginTop: "8px" }}
                onClick={() => setShowAuditModal(false)}
              >
                Close Audit Report
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
