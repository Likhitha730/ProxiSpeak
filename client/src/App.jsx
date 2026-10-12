import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const API_URL = "http://localhost:5000";
const WIDTH = 900, HEIGHT = 500, SPEED = 3, HEARING_RADIUS = 100;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export default function App() {
  const canvasRef = useRef(null);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const peersRef = useRef(new Map());
  const audiosRef = useRef(new Map());
  const voiceReadyRef = useRef(new Set());
  const positionsRef = useRef(new Map());
  const playerRef = useRef({ x: 180, y: 180 });
  const keysRef = useRef(new Set());
  const localIdRef = useRef(null);

  const [player, setPlayer] = useState({ x: 180, y: 180 });
  const [users, setUsers] = useState([]);
  const [nearbyUsers, setNearbyUsers] = useState([]);
  const [connected, setConnected] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("Voice is off");
  const [error, setError] = useState("");

  const updatePosition = useCallback((next) => {
    playerRef.current = next;
    setPlayer(next);
    if (localIdRef.current) positionsRef.current.set(localIdRef.current, next);
    socketRef.current?.emit("player:move", next);
  }, []);

  const closePeer = useCallback((id) => {
    peersRef.current.get(id)?.close();
    peersRef.current.delete(id);
    const audio = audiosRef.current.get(id);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audiosRef.current.delete(id);
    }
  }, []);

  const createPeer = useCallback((id) => {
    if (peersRef.current.has(id)) return peersRef.current.get(id);
    const socket = socketRef.current;
    if (!socket || !localStreamRef.current) return null;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    localStreamRef.current.getTracks().forEach((track) => pc.addTrack(track, localStreamRef.current));
    pc.onicecandidate = (event) => {
      if (event.candidate) socket.emit("webrtc:ice-candidate", { to: id, candidate: event.candidate });
    };
    pc.ontrack = (event) => {
      let audio = audiosRef.current.get(id);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        audio.playsInline = true;
        audio.volume = 0;
        audiosRef.current.set(id, audio);
      }
      audio.srcObject = event.streams[0];
      audio.play().catch(() => setVoiceStatus("Voice connected; click the page to enable audio."));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") setVoiceStatus("A voice connection failed. Check your network.");
    };
    peersRef.current.set(id, pc);
    return pc;
  }, []);

  const connectPeer = useCallback(async (id) => {
    const socket = socketRef.current;
    const localId = localIdRef.current;
    if (!socket || !localId || !localStreamRef.current || !voiceReadyRef.current.has(id) || id === localId) return;
    const pc = createPeer(id);
    if (!pc) return;
    if (localId.localeCompare(id) < 0 && !pc.localDescription) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("webrtc:offer", { to: id, description: pc.localDescription });
      } catch (err) {
        console.error("Could not create WebRTC offer:", err);
      }
    }
  }, [createPeer]);

  const startVoice = async () => {
    if (localStreamRef.current) return;
    setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access requires localhost or HTTPS.");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      localStreamRef.current = stream;
      if (!socketRef.current?.connected) {
        stream.getTracks().forEach((track) => track.stop());
        localStreamRef.current = null;
        throw new Error("The ProxiSpeak server is not connected.");
      }
      setVoiceOn(true);
      setVoiceStatus("Microphone on. Waiting for nearby users with voice.");
      socketRef.current.emit("voice:ready");
    } catch (err) {
      setError(err.message || "Could not access the microphone.");
      setVoiceStatus("Microphone unavailable");
    }
  };

  const stopVoice = () => {
    socketRef.current?.emit("voice:stop");
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    [...peersRef.current.keys()].forEach(closePeer);
    voiceReadyRef.current.clear();
    setVoiceOn(false);
    setVoiceStatus("Voice is off");
  };

  useEffect(() => {
    const socket = io(API_URL, { transports: ["websocket", "polling"], reconnection: true, timeout: 10000 });
    socketRef.current = socket;
    socket.on("connect", () => {
      localIdRef.current = socket.id;
      setConnected(true);
      setError("");
      positionsRef.current.set(socket.id, playerRef.current);
    });
    socket.on("disconnect", () => {
      setConnected(false);
      setError("Disconnected from server. Reconnecting…");
    });
    socket.on("connect_error", (err) => {
      setConnected(false);
      setError(`Server connection failed: ${err.message}`);
    });
    socket.on("users:update", (list) => {
      setUsers(list);
      list.forEach((u) => positionsRef.current.set(u.id, { x: u.x, y: u.y }));
    });
    socket.on("user:joined", (user) => {
      setUsers((old) => [...old.filter((u) => u.id !== user.id), user]);
      positionsRef.current.set(user.id, { x: user.x, y: user.y });
    });
    socket.on("player:moved", ({ id, x, y }) => {
      positionsRef.current.set(id, { x, y });
      setUsers((old) => old.map((u) => u.id === id ? { ...u, x, y } : u));
    });
    socket.on("user:left", (id) => {
      setUsers((old) => old.filter((u) => u.id !== id));
      positionsRef.current.delete(id);
      voiceReadyRef.current.delete(id);
      closePeer(id);
    });
    socket.on("proximity:update", setNearbyUsers);
    socket.on("voice:ready-users", async (ids) => {
      ids.forEach((id) => voiceReadyRef.current.add(id));
      for (const id of ids) await connectPeer(id);
    });
    socket.on("voice:user-ready", async ({ id }) => {
      voiceReadyRef.current.add(id);
      await connectPeer(id);
    });
    socket.on("voice:user-stopped", ({ id }) => {
      voiceReadyRef.current.delete(id);
      closePeer(id);
    });
    socket.on("webrtc:offer", async ({ from, description }) => {
      if (!localStreamRef.current || !voiceReadyRef.current.has(from)) return;
      try {
        const pc = createPeer(from);
        if (!pc) return;
        await pc.setRemoteDescription(description);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("webrtc:answer", { to: from, description: pc.localDescription });
      } catch (err) { console.error("Could not handle WebRTC offer:", err); }
    });
    socket.on("webrtc:answer", async ({ from, description }) => {
      const pc = peersRef.current.get(from);
      if (pc) try { await pc.setRemoteDescription(description); }
      catch (err) { console.error("Could not handle WebRTC answer:", err); }
    });
    socket.on("webrtc:ice-candidate", async ({ from, candidate }) => {
      const pc = peersRef.current.get(from);
      if (pc && candidate) try { await pc.addIceCandidate(candidate); }
      catch (err) { console.error("Could not add ICE candidate:", err); }
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      peersRef.current.forEach((pc) => pc.close());
      peersRef.current.clear();
      audiosRef.current.forEach((audio) => { audio.pause(); audio.srcObject = null; });
      audiosRef.current.clear();
    };
  }, [closePeer, connectPeer, createPeer]);

  useEffect(() => {
    const down = (event) => {
      const key = event.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"].includes(key)) {
        event.preventDefault();
        keysRef.current.add(key);
      }
    };
    const up = (event) => keysRef.current.delete(event.key.toLowerCase());
    const blur = () => keysRef.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    let frame;
    const move = () => {
      const keys = keysRef.current;
      let { x, y } = playerRef.current;
      if (keys.has("arrowup") || keys.has("w")) y -= SPEED;
      if (keys.has("arrowdown") || keys.has("s")) y += SPEED;
      if (keys.has("arrowleft") || keys.has("a")) x -= SPEED;
      if (keys.has("arrowright") || keys.has("d")) x += SPEED;
      x = clamp(x, 16, WIDTH - 16);
      y = clamp(y, 16, HEIGHT - 16);
      if (x !== playerRef.current.x || y !== playerRef.current.y) updatePosition({ x, y });
      frame = requestAnimationFrame(move);
    };
    frame = requestAnimationFrame(move);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [updatePosition]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let frame;
    const draw = () => {
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = "#f8fafc";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 3;
      ctx.strokeRect(8, 8, WIDTH - 16, HEIGHT - 16);
      ctx.fillStyle = "#e0f2fe";
      ctx.fillRect(640, 35, 220, 125);
      ctx.strokeStyle = "#7dd3fc";
      ctx.strokeRect(640, 35, 220, 125);
      ctx.fillStyle = "#075985";
      ctx.font = "bold 15px Arial";
      ctx.fillText("Meeting Room", 690, 58);

      [[70,75],[230,75],[70,200],[230,200],[70,325],[230,325],[480,220],[480,325]].forEach(([x,y]) => {
        ctx.fillStyle = "#d6b58c";
        ctx.fillRect(x,y,95,48);
        ctx.strokeStyle = "#9a7046";
        ctx.strokeRect(x,y,95,48);
        ctx.fillStyle = "#64748b";
        ctx.fillRect(x+34,y+7,28,20);
      });

      const local = playerRef.current;
      audiosRef.current.forEach((audio, id) => {
        const remote = positionsRef.current.get(id);
        const d = remote ? Math.hypot(local.x - remote.x, local.y - remote.y) : Infinity;
        audio.volume = !remote || !localStreamRef.current || d >= HEARING_RADIUS ? 0 : Math.max(0, 1 - d / HEARING_RADIUS);
      });

      ctx.beginPath();
      ctx.arc(local.x, local.y, HEARING_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(34,197,94,0.08)";
      ctx.fill();
      ctx.strokeStyle = "#22c55e";
      ctx.setLineDash([6,5]);
      ctx.stroke();
      ctx.setLineDash([]);

      users.filter((u) => u.id !== localIdRef.current).forEach((u) => {
        const pos = positionsRef.current.get(u.id) || u;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 12, 0, Math.PI * 2);
        ctx.fillStyle = "#f97316";
        ctx.fill();
        ctx.fillStyle = "#7c2d12";
        ctx.font = "12px Arial";
        ctx.fillText(u.name, pos.x - 25, pos.y - 18);
      });

      ctx.beginPath();
      ctx.arc(local.x, local.y, 13, 0, Math.PI * 2);
      ctx.fillStyle = "#2563eb";
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 10px Arial";
      ctx.fillText("YOU", local.x - 10, local.y + 4);
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [users, player]);

  return (
    <main className="app">
      <header className="app-header">
        <h1>ProxiSpeak</h1>
        <p>Proximity-based virtual office</p>
      </header>
      <section className="stats">
        <span className={connected ? "status-connected" : "status-disconnected"}>
          {connected ? "Connected" : "Disconnected"} · Connected users: {connected ? Math.max(users.length, 1) : 0}
        </span>
        <span>Position: X {Math.round(player.x)}, Y {Math.round(player.y)}</span>
        <span>Hearing radius: {HEARING_RADIUS}px</span>
      </section>
      <div className="office-wrap">
        <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} aria-label="ProxiSpeak virtual office" />
      </div>
      <section className="voice-panel">
        <h2>Voice Chat</h2>
        <p>{voiceStatus}</p>
        {!voiceOn ? <button onClick={startVoice}>Start Voice</button> :
          <button onClick={stopVoice} className="stop-button">Stop Voice</button>}
        {error && <p className="error-message">{error}</p>}
        <p className="help-text">Keep your microphone enabled only when you want to participate. Audio volume decreases with distance and is muted beyond 100 pixels.</p>
      </section>
      <section className="proximity-panel">
        <h3>Proximity Detection</h3>
        {nearbyUsers.length === 0 ? <p>No users within your 100-pixel hearing radius.</p> :
          <ul>{nearbyUsers.map((u) => <li key={u.id}><span className="nearby-indicator">●</span>{" "}{u.name} — {u.distance} pixels away</li>)}</ul>}
      </section>
      <p className="keyboard-help">Move with arrow keys or W, A, S, D.</p>
    </main>
  );
}
