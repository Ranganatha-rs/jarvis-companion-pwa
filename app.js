"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const mode = new URLSearchParams(location.search).get("mode") === "assistant" ? "assistant" : "phone";
  document.body.dataset.mode = mode;
  const PAIR_KEY = "jarvis-companion-pair-v1";
  const state = {
    token: "", bootstrap: null, pairing: null, socket: null, pc: null, sid: "", cryptoKey: null,
    sequence: 0, signalQueue: Promise.resolve(), lastSequence: new Map(), remoteCandidates: [], remoteReady: false,
    stream: null, audioContext: null, audioDestination: null, sourceNode: null,
    samples: [], preRoll: [], activeSamples: 0, quietSamples: 0, localPhase: "disconnected",
    ttsGeneration: 0, reconnectAttempts: 0, sessionStarted: false, closed: false, notifyTopic: "", assistantStarted: false,
    controlAck: null, remotePlaybackAck: null, remoteAckTimeout: null, statusTimer: null
  };
  const statusText = message => { if ($("statusText")) $("statusText").textContent = message; };
  const message = (value, error = false) => {
    if (!$("message")) return;
    $("message").textContent = value;
    $("message").classList.toggle("error", error);
  };
  const badge = (value, type = "") => {
    const item = $("connectionBadge");
    if (!item) return;
    item.textContent = value;
    item.classList.toggle("connected", type === "connected");
    item.classList.toggle("error", type === "error");
  };
  const jsonFetch = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
    if (options.body && !(options.body instanceof ArrayBuffer)) headers.set("Content-Type", "application/json");
    const response = await fetch(url, {...options, headers, cache: "no-store"});
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
    return value;
  };
  const localApi = (path, body, method = "POST") => jsonFetch(path, {method, body: body === undefined ? undefined : JSON.stringify(body)});
  const bytesFromB64 = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)), c => c.charCodeAt(0));
  const b64FromBytes = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function deriveSessionKey(pairing, sid) {
    const raw = bytesFromB64(pairing.sharedKey);
    const material = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      {name: "HKDF", hash: "SHA-256", salt: encoder.encode(sid), info: encoder.encode("JARVIS browser companion signalling v1")},
      material, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]
    );
  }

  async function encryptEnvelope(kind, payload) {
    const body = {sid: state.sid, from: mode, seq: ++state.sequence, ts: Date.now(), kind, payload};
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({name: "AES-GCM", iv}, state.cryptoKey, encoder.encode(JSON.stringify(body)));
    return JSON.stringify({sid: state.sid, iv: b64FromBytes(iv), ciphertext: b64FromBytes(ciphertext)});
  }

  async function publishSignal(kind, payload) {
    if (!state.pairing || !state.sid || !state.cryptoKey) throw new Error("No paired signalling session.");
    const send = state.signalQueue.then(async () => {
      const body = await encryptEnvelope(kind, payload);
      const response = await fetch(`https://ntfy.sh/${encodeURIComponent(state.pairing.signalTopic)}`, {
        method: "POST", mode: "cors", headers: {"Content-Type": "text/plain"}, body
      });
      if (!response.ok) throw new Error(`Signalling service rejected a message (${response.status}).`);
    });
    state.signalQueue = send.catch(() => {});
    return send;
  }

  async function waitForIce(pc) {
    if (pc.iceGatheringState === "complete") return;
    await Promise.race([
      new Promise(resolve => pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") resolve();
      })), new Promise(resolve => setTimeout(resolve, 8000))
    ]);
  }

  async function openSignal(topic, callback) {
    state.socket?.close();
    const socket = new WebSocket(`wss://ntfy.sh/${encodeURIComponent(topic)}/ws`);
    state.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Signalling service connection timed out.")), 10000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("Could not reach ntfy signalling. Check internet access.")); };
    });
    socket.onmessage = async event => {
      try {
        const record = JSON.parse(event.data);
        if (record.event !== "message" || typeof record.message !== "string") return;
        const envelope = JSON.parse(record.message);
        if (mode === "assistant" && !state.sid && typeof envelope.sid === "string" && envelope.sid.length >= 16) {
          state.sid = envelope.sid; state.sequence = 0; state.lastSequence.clear();
          state.cryptoKey = await deriveSessionKey(state.pairing, state.sid);
        }
        if (envelope.sid !== state.sid || !state.cryptoKey) return;
        const decrypted = await crypto.subtle.decrypt({name: "AES-GCM", iv: bytesFromB64(envelope.iv)}, state.cryptoKey, bytesFromB64(envelope.ciphertext));
        const body = JSON.parse(decoder.decode(decrypted));
        if (body.sid !== state.sid || body.from === mode || Date.now() - body.ts > 120000 || body.ts - Date.now() > 30000) return;
        const previous = state.lastSequence.get(body.from) || 0;
        if (!Number.isSafeInteger(body.seq) || body.seq <= previous) return;
        state.lastSequence.set(body.from, body.seq);
        if (typeof body.kind === "string") await callback(body.kind, body.payload || {}, body.from);
      } catch (_error) {
        // Invalid, stale, replayed, or non-companion messages are ignored silently.
      }
    };
    socket.onclose = () => {
      if (state.pc && !state.closed) statusText("Signalling disconnected. The voice peer may still be connected.");
    };
    return socket;
  }

  function setRtcState(value, error = false) {
    const label = value === "connected" ? "Connected" : value === "connecting" ? "Connecting…" : value === "failed" ? "Connection failed" : value;
    if ($("voiceState")) $("voiceState").textContent = label;
    badge(label, value === "connected" ? "connected" : error ? "error" : "");
    if ($("disconnectButton")) $("disconnectButton").disabled = !state.pc;
    if (value === "connected") statusText(mode === "phone" ? "Connected to the laptop. Say “Hey JARVIS” to begin." : "Phone connected. Waiting for “Hey JARVIS”.");
    if (value === "failed") statusText("WebRTC could not connect. This network may require a TURN relay, which is not configured. Try another network.");
  }

  function makePeerConnection() {
    const pc = new RTCPeerConnection({iceServers: [{urls: "stun:stun.l.google.com:19302"}]});
    state.pc = pc;
    pc.onconnectionstatechange = () => {
      setRtcState(pc.connectionState, pc.connectionState === "failed");
      if (mode === "phone" && ["disconnected", "failed"].includes(pc.connectionState)) scheduleIceRestart(pc);
      if (pc.connectionState === "connected" && mode === "assistant" && !state.sessionStarted) {
        state.sessionStarted = true;
        localApi("/api/session/connected", {session_id: state.sid}).then(() => publishSignal("state", {phase: "waiting_for_wake"})).catch(error => {
          state.sessionStarted = false; statusText(error.message); pc.close();
        });
      }
      if (["failed", "closed"].includes(pc.connectionState)) {
        if (mode === "assistant") {
          state.sessionStarted = false;
          localApi("/api/session/disconnect", {}).catch(() => {});
        }
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") setRtcState("failed", true);
      if (pc.iceConnectionState === "disconnected") statusText("Network changed or peer disconnected. Waiting briefly for WebRTC to recover…");
    };
    pc.onicecandidate = event => {
      if (event.candidate && state.sid) publishSignal("candidate", event.candidate.toJSON()).catch(() => {});
    };
    return pc;
  }

  function scheduleIceRestart(pc) {
    if (state.reconnectAttempts >= 1 || state.closed) return;
    setTimeout(async () => {
      if (pc !== state.pc || state.closed || pc.connectionState === "connected") return;
      state.reconnectAttempts++;
      statusText("Trying one WebRTC ICE restart. No relay service is configured.");
      try {
        const offer = await pc.createOffer({iceRestart: true});
        await pc.setLocalDescription(offer);
        await waitForIce(pc);
        await publishSignal("offer", pc.localDescription.toJSON());
      } catch (_error) { setRtcState("failed", true); }
    }, 3500);
  }

  async function acceptCandidate(candidate) {
    if (!state.pc || !candidate) return;
    if (!state.remoteReady) { state.remoteCandidates.push(candidate); return; }
    try { await state.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_error) {}
  }

  async function handlePhoneSignal(kind, payload) {
    if (kind === "answer" && state.pc && mode === "phone") {
      await state.pc.setRemoteDescription(new RTCSessionDescription(payload));
      state.remoteReady = true;
      for (const candidate of state.remoteCandidates.splice(0)) await acceptCandidate(candidate);
    } else if (kind === "candidate") await acceptCandidate(payload);
    else if (kind === "state" && mode === "phone") statusText(payload.phase === "waiting_for_wake" ? "Connected. Say “Hey JARVIS” when you're ready." : `JARVIS: ${payload.phase || "connected"}`);
    else if (kind === "response" && mode === "phone") {
      statusText(payload.text || "JARVIS responded.");
      const audio = $("remoteAudio");
      let played = false;
      if (!payload.speakFallback && audio) {
        try {
          await audio.play();
          if (payload.ending) await new Promise(resolve => setTimeout(resolve, Math.max(500, Math.min(2500, Number(payload.drainMs) || 1200))));
          played = !audio.paused && audio.readyState >= 2;
        } catch (_error) { played = false; }
      }
      if (!played && payload.text) {
        const fallback = await JarvisVoiceAudio.speakFallback(payload.text);
        played = fallback.spoken;
        message(fallback.spoken
          ? `Spoken locally using ${fallback.voice}.`
          : `Speech was not delivered (${fallback.reason}). The response remains visible as text.`, !fallback.spoken);
      }
      if (payload.ending) await publishSignal("playback_ack", {played, method: payload.speakFallback ? "browser_speech" : "webrtc_or_fallback"}).catch(() => {});
    } else if (kind === "interrupt" && mode === "phone") {
      const audio = $("remoteAudio"); if (audio) { audio.pause(); audio.currentTime = 0; }
      JarvisVoiceAudio.cancelFallback();
      statusText("JARVIS stopped speaking and is listening.");
    } else if (kind === "ended") await cleanup("The JARVIS session ended.");
    else if (kind === "control_ack" && mode === "phone") {
      const ack = state.controlAck;
      if (ack) { state.controlAck = null; ack(payload); }
    }
    else if (kind === "playback_ack" && mode === "assistant") {
      const ack = state.remotePlaybackAck;
      if (ack) { state.remotePlaybackAck = null; clearTimeout(state.remoteAckTimeout); state.remoteAckTimeout = null; ack(payload); }
    }
    else if (kind === "offer" && mode === "assistant") await acceptPhoneOffer(payload);
    else if (kind === "control" && mode === "assistant") {
      const action = payload.action;
      try {
        const result = await localApi("/api/session/control", {action});
        await publishSignal("control_ack", {action, ok: true, emergency_stopped: !!result.emergency_stopped});
        if (["pause", "emergency_stop", "disconnect"].includes(action)) {
          await publishSignal("ended", {reason: action});
          await cleanup(action === "emergency_stop" ? "Emergency stop is active." : "JARVIS companion paused.");
        } else statusText("JARVIS companion resumed. Join again to start a session.");
      } catch (error) {
        await publishSignal("control_ack", {action, ok: false, error: error.message}).catch(() => {});
        statusText(error.message);
      }
    }
  }

  async function attachPhoneAudio(track) {
    if (!state.audioContext) return;
    const stream = new MediaStream([track]);
    const source = state.audioContext.createMediaStreamSource(stream);
    const moduleUrl = new URL("./audio-worklet.js", location.href);
    try {
      await state.audioContext.audioWorklet.addModule(moduleUrl.href);
      const worklet = new AudioWorkletNode(state.audioContext, "jarvis-pcm-tap", {numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1]});
      const silent = state.audioContext.createGain(); silent.gain.value = 0;
      source.connect(worklet); worklet.connect(silent); silent.connect(state.audioContext.destination);
      worklet.port.onmessage = event => processAudioBlock(event.data, state.audioContext.sampleRate);
    } catch (_error) {
      statusText("This browser cannot run the local voice audio bridge. Please update the laptop browser.");
    }
  }

  function resample(input, sourceRate, targetRate) {
    const outputLength = Math.floor(input.length * targetRate / sourceRate);
    const output = new Int16Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const position = i * sourceRate / targetRate;
      const low = Math.floor(position), fraction = position - low;
      const sample = input[low] * (1 - fraction) + (input[Math.min(low + 1, input.length - 1)] || 0) * fraction;
      output[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }
    return output;
  }

  function processAudioBlock(floatBlock, sampleRate) {
    if (state.closed || mode !== "assistant" || !state.pc || state.pc.connectionState !== "connected") return;
    const pcm = resample(floatBlock, sampleRate, 16000);
    let energy = 0;
    for (const value of pcm) energy += value * value;
    const rms = Math.sqrt(energy / Math.max(1, pcm.length)) / 32768;
    if (!state.samples.length) {
      state.preRoll.push(pcm);
      if (state.preRoll.length > 2) state.preRoll.shift();
    }
    if (rms >= 0.012) {
      if (!state.samples.length) {
        state.samples.push(...state.preRoll);
        state.activeSamples = 0; state.quietSamples = 0;
        if (["speaking", "processing"].includes(state.localPhase)) interruptSpeech();
      }
      state.samples.push(pcm); state.activeSamples += pcm.length; state.quietSamples = 0;
    } else if (state.samples.length) {
      state.samples.push(pcm); state.quietSamples += pcm.length;
      if (state.quietSamples >= 16000 * 0.85 || state.samples.reduce((sum, block) => sum + block.length, 0) >= 16000 * 18) {
        const utterance = state.samples; state.samples = []; state.preRoll = []; state.quietSamples = 0;
        if (state.activeSamples >= 16000 * 0.25) submitPcm(utterance);
      }
    }
  }

  function concatPcm(blocks) {
    const total = blocks.reduce((sum, block) => sum + block.length, 0);
    const result = new Int16Array(total); let offset = 0;
    for (const block of blocks) { result.set(block, offset); offset += block.length; }
    return result;
  }

  async function submitPcm(blocks) {
    if (!state.token || !state.pc || state.pc.connectionState !== "connected") return;
    const requestGeneration = state.ttsGeneration;
    state.localPhase = "processing";
    const pcm = concatPcm(blocks);
    if (pcm.length / 16000 < 0.25) return;
    try {
      const result = await jsonFetch("/api/audio", {method: "POST", headers: {"Content-Type": "application/octet-stream"}, body: pcm.buffer});
      state.localPhase = result.phase || state.localPhase;
      if (result.response) statusText(result.response);
      let fallbackSpeech = !!result.response && !result.audio_wav;
      if (result.audio_wav && requestGeneration === state.ttsGeneration && state.pc?.connectionState === "connected") {
        try { await playResponse(result.audio_wav); }
        catch (_error) { fallbackSpeech = !!result.response; }
      }
      if (requestGeneration !== state.ttsGeneration || state.closed) return;
      if (result.phase) {
        await publishSignal("state", {phase: result.phase}).catch(() => {});
        if (result.response) {
          const ending = !!result.ended;
          const ackPromise = ending ? new Promise(resolve => {
            state.remotePlaybackAck = resolve;
            state.remoteAckTimeout = setTimeout(() => {
              if (state.remotePlaybackAck === resolve) {
                state.remotePlaybackAck = null;
                state.remoteAckTimeout = null;
                resolve(null);
              }
            }, 12000);
          }) : null;
          await publishSignal("response", {text: result.response, speakFallback: fallbackSpeech, ending, drainMs: 1200}).catch(() => {});
          if (ending) {
            const ack = await ackPromise;
            if (!ack?.played) statusText("The phone did not confirm spoken goodbye audio; ending safely with the response still visible.");
            await publishSignal("ended", {reason: "goodbye"}).catch(() => {});
            await cleanup("Goodbye. This session has ended.");
            return;
          }
        }
        if ($("voiceState")) $("voiceState").textContent = result.phase.replaceAll("_", " ");
      }
      if (result.recognized === false && result.response) statusText(result.response);
    } catch (error) { statusText(error.message); }
  }

  async function playResponse(base64) {
    if (!state.audioContext || !state.audioDestination) throw new Error("JARVIS audio output is unavailable.");
    const generation = state.ttsGeneration;
    const audioBytes = bytesFromB64(base64).buffer;
    const buffer = await state.audioContext.decodeAudioData(audioBytes.slice(0));
    if (generation !== state.ttsGeneration || state.closed) throw new Error("Audio playback was interrupted.");
    state.sourceNode?.stop();
    const source = state.audioContext.createBufferSource();
    state.sourceNode = source;
    source.buffer = buffer;
    source.connect(state.audioDestination);
    state.localPhase = "speaking";
    try {
      await JarvisVoiceAudio.waitForSource(source, Math.min(35000, Math.ceil(buffer.duration * 1000) + 5000));
      if (generation !== state.ttsGeneration || state.closed) throw new Error("Audio playback was interrupted.");
    } finally {
      if (state.sourceNode === source) state.sourceNode = null;
    }
  }

  function interruptSpeech() {
    state.ttsGeneration++;
    try { state.sourceNode?.stop(); } catch (_error) {}
    state.sourceNode = null;
    localApi("/api/session/interrupt", {}).catch(() => {});
    publishSignal("interrupt", {}).catch(() => {});
    state.localPhase = "listening";
  }

  async function joinPhone() {
    try {
      const stored = localStorage.getItem(PAIR_KEY);
      if (!stored) throw new Error("Paste the pairing code from the JARVIS laptop first.");
      state.pairing = JSON.parse(stored);
      if (state.pairing.version !== 1 || !state.pairing.signalTopic || !state.pairing.sharedKey) throw new Error("Pairing code is invalid.");
      state.closed = false; state.sid = crypto.randomUUID(); state.sequence = 0; state.reconnectAttempts = 0; state.signalQueue = Promise.resolve(); state.lastSequence.clear();
      state.cryptoKey = await deriveSessionKey(state.pairing, state.sid);
      statusText("Requesting microphone permission…");
      state.stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}, video: false});

      const micTrack = state.stream.getAudioTracks()[0];

      console.log("[JARVIS PHONE MIC]", {
        settings: micTrack.getSettings(),
        enabled: micTrack.enabled,
        muted: micTrack.muted,
        readyState: micTrack.readyState
      });

      micTrack.onmute = () => console.warn("[JARVIS PHONE MIC] MUTED");
      micTrack.onunmute = () => console.log("[JARVIS PHONE MIC] UNMUTED");
      micTrack.onended = () => console.error("[JARVIS PHONE MIC] ENDED");
      await openSignal(state.pairing.signalTopic, handlePhoneSignal);
      const pc = makePeerConnection();
      state.stream.getAudioTracks().forEach(track => pc.addTrack(track, state.stream));
      pc.ontrack = event => {
        const audio = $("remoteAudio");
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        audio.play().catch(() => statusText("Tap the page once to allow JARVIS audio playback."));
      };
      setRtcState("connecting");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc);
      await publishSignal("offer", pc.localDescription.toJSON());
      statusText("Waiting for the JARVIS laptop to answer. Microphone is active only for this join attempt.");
      $("joinButton").disabled = true;
    } catch (error) {
      statusText(error.name === "NotAllowedError" ? "Microphone permission was denied. Allow microphone access in browser settings and try again." : error.message);
      badge("Not connected", "error");
      await cleanup();
    }
  }

  async function startAssistant() {
    try {
      if (!state.token) await loadLocalBootstrap();
      state.pairing = state.bootstrap?.pairing || null;
      if (!state.pairing) throw new Error("Create a pairing code before starting the laptop voice endpoint.");
      state.sid = ""; state.sequence = 0; state.lastSequence.clear(); state.closed = false;
      state.audioContext = new AudioContext(); await state.audioContext.resume();
      state.audioDestination = state.audioContext.createMediaStreamDestination();
      state.assistantStarted = true;
      await openSignal(state.pairing.signalTopic, handlePhoneSignal);
      statusText("Laptop endpoint ready. Waiting for the phone to join; no session is active yet.");
      badge("Waiting for phone");
      $("startAssistantButton").disabled = true;
    } catch (error) { statusText(error.message); }
  }

  async function acceptPhoneOffer(offer) {
    if (!state.assistantStarted || state.closed) return;
    if (!state.bootstrap?.status?.enabled || state.bootstrap.status.paused || state.bootstrap.status.emergency_stopped) {
      await publishSignal("ended", {reason: "not_available"}); statusText("The laptop companion is disabled, paused, or emergency-stopped."); return;
    }
    if (state.pc && !["closed", "failed"].includes(state.pc.connectionState)) {
      try {
        await state.pc.setRemoteDescription(new RTCSessionDescription(offer));
        state.remoteReady = true;
        const reconnectAnswer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(reconnectAnswer);
        await waitForIce(state.pc);
        await publishSignal("answer", state.pc.localDescription.toJSON());
      } catch (_error) { statusText("WebRTC reconnect negotiation failed. Leave and rejoin the session."); }
      return;
    }
    try {
      const pc = makePeerConnection();
      pc.addTrack(state.audioDestination.stream.getAudioTracks()[0], state.audioDestination.stream);
      pc.ontrack = event => attachPhoneAudio(event.track);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      state.remoteReady = true;
      const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); await waitForIce(pc);
      await publishSignal("answer", pc.localDescription.toJSON());
      for (const candidate of state.remoteCandidates.splice(0)) await acceptCandidate(candidate);
      statusText("Phone is connected. Waiting for “Hey JARVIS”.");
    } catch (error) {
      statusText(`Could not start the companion session: ${error.message}`);
      await publishSignal("ended", {reason: "local_session_rejected"}).catch(() => {});
    }
  }

  async function stopPhone() {
    if (state.socket?.readyState === WebSocket.OPEN) await publishSignal("control", {action: "disconnect"}).catch(() => {});
    await cleanup("Disconnected.");
  }

  async function cleanup(text = "Disconnected.") {
    state.closed = true; state.assistantStarted = false;
    state.sessionStarted = false;
    JarvisVoiceAudio.cancelFallback();
    clearTimeout(state.remoteAckTimeout); state.remoteAckTimeout = null; state.remotePlaybackAck = null;
    state.pc?.close(); state.pc = null;
    state.socket?.close(); state.socket = null;
    state.stream?.getTracks().forEach(track => track.stop()); state.stream = null;
    state.samples = []; state.preRoll = [];
    try { state.sourceNode?.stop(); } catch (_error) {}
    state.sourceNode = null; state.audioDestination = null;
    if (state.audioContext) { await state.audioContext.close().catch(() => {}); state.audioContext = null; }
    state.cryptoKey = null; state.sid = ""; state.localPhase = "disconnected";
    if (mode === "assistant" && state.token) localApi("/api/session/disconnect", {}).catch(() => {});
    if ($("joinButton")) $("joinButton").disabled = false;
    if ($("startAssistantButton")) $("startAssistantButton").disabled = false;
    if ($("disconnectButton")) $("disconnectButton").disabled = true;
    if ($("remoteAudio")) $("remoteAudio").srcObject = null;
    setRtcState("disconnected"); statusText(text);
  }

  async function loadLocalBootstrap() {
    const bootstrap = await jsonFetch("/api/bootstrap");
    state.bootstrap = bootstrap; state.token = bootstrap.token; state.pairing = bootstrap.pairing;
    applyStatus(bootstrap.status);
    return bootstrap;
  }

  function applyStatus(value) {
    if (!value) return;
    if ($("speechState")) $("speechState").textContent = value.local_speech_available ? "Ready · local Whisper" : "Model unavailable";
    if ($("ollamaState")) $("ollamaState").textContent = value.local_ollama_available ? "Available · local" : "Unavailable";
    if ($("enabledSetting")) $("enabledSetting").checked = !!value.enabled;
    if ($("morningSetting")) $("morningSetting").checked = value.morning_enabled !== false;
    if ($("eveningSetting")) $("eveningSetting").checked = value.evening_enabled !== false;
    if ($("notificationStatus")) {
      const delivery = value.notification_delivery;
      $("notificationStatus").textContent = delivery?.status
        ? `${delivery.status}${delivery.attempts ? ` · attempt ${delivery.attempts}` : ""}${delivery.detail ? ` · ${delivery.detail}` : ""}`
        : "No scheduled notification attempt yet.";
    }
  }

  async function saveSettings() {
    try {
      const value = await localApi("/api/settings", {
        enabled: $("enabledSetting").checked,
        notifications_enabled: $("notificationSetting").checked,
        morning_enabled: $("morningSetting").checked,
        evening_enabled: $("eveningSetting").checked,
        paused: false,
        public_app_url: $("publicUrl").value.trim()
      });
      state.bootstrap.status = value;
      state.bootstrap.settings = value;
      message("Settings saved. Schedules run only while this service is running.");
      applyStatus(value);
    } catch (error) { message(error.message, true); }
  }

  async function createPairing() {
    try {
      const result = await localApi("/api/pair", {public_app_url: $("publicUrl").value.trim()});
      state.bootstrap.pairing = result.pairing;
      $("pairingCode").value = JSON.stringify(result.pairing);
      $("copyPairButton").disabled = false;
      $("notificationSetting").disabled = false;
      message("Pairing key stored in Windows Credential Manager for this user. Copy the code only to your own phone.");
    } catch (error) { message(error.message, true); }
  }

  async function remoteControl(action) {
    if (mode === "assistant") {
      try {
        const result = await localApi("/api/session/control", {action});
        applyStatus(result);
        if (action === "pause" || action === "emergency_stop" || action === "disconnect") await cleanup("Companion control applied.");
        else message(result.emergency_stopped ? "Emergency stop is latched; resume is blocked." : "Companion resumed.");
      } catch (error) { message(error.message, true); }
    } else {
      try {
        const stored = localStorage.getItem(PAIR_KEY);
        if (!stored) throw new Error("Pair this phone before sending remote controls.");
        state.pairing = JSON.parse(stored);
        if (!state.sid || !state.pc || state.pc.connectionState !== "connected") {
          state.sid = crypto.randomUUID(); state.cryptoKey = await deriveSessionKey(state.pairing, state.sid); state.sequence = 0;
        }
        await openSignal(state.pairing.signalTopic, handlePhoneSignal);
        const ackPromise = new Promise(resolve => {
          state.controlAck = resolve;
          setTimeout(() => { if (state.controlAck === resolve) { state.controlAck = null; resolve(null); } }, 12000);
        });
        await publishSignal("control", {action});
        const ack = await ackPromise;
        if (!ack) { message("No acknowledgement from the laptop. The control may not have been applied; check the laptop service.", true); return; }
        if (!ack.ok) { message(ack.error || "The laptop rejected the control request.", true); return; }
        if (action === "emergency_stop") message("Emergency stop is latched on the laptop.");
        else if (action === "pause") message("Companion paused on the laptop.");
        else if (action === "disconnect") message("Companion disconnected on the laptop.");
        else message(ack.emergency_stopped ? "Emergency stop is latched; resume was rejected." : "Companion resumed on the laptop. Emergency stop can only be cleared locally.");
        if (["pause", "emergency_stop", "disconnect"].includes(action)) await cleanup("Remote control acknowledged by the laptop.");
      } catch (error) { message(error.message, true); }
    }
  }

  function initEvents() {
    $("joinButton")?.addEventListener("click", joinPhone);
    $("startAssistantButton")?.addEventListener("click", startAssistant);
    $("disconnectButton")?.addEventListener("click", mode === "phone" ? stopPhone : () => cleanup());
    $("saveSettingsButton")?.addEventListener("click", saveSettings);
    $("testNotificationButton")?.addEventListener("click", async () => {
      try { await localApi("/api/test-notification", {}); message("Test notification sent. No session was started."); }
      catch (error) { message(error.message, true); }
    });
    $("pairButton")?.addEventListener("click", createPairing);
    $("copyPairButton")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText($("pairingCode").value); message("Pairing code copied. Paste it into your own phone browser.");
    });
    $("revokeButton")?.addEventListener("click", async () => {
      if (!confirm("Revoke the paired device and disable companion notifications?")) return;
      try { await localApi("/api/pair/revoke", {}); await cleanup("Paired device revoked."); message("Device revoked. Create a new pairing code to reconnect."); }
      catch (error) { message(error.message, true); }
    });
    $("savePairingButton")?.addEventListener("click", () => {
      try {
        const pairing = JSON.parse($("phonePairingCode").value.trim());
        if (pairing.version !== 1 || typeof pairing.signalTopic !== "string" || typeof pairing.sharedKey !== "string") throw new Error("Pairing code format is invalid.");
        localStorage.setItem(PAIR_KEY, JSON.stringify(pairing)); $("phonePairingCode").value = "";
        state.pairing = pairing; message("Pairing saved on this phone. Tap Join when the laptop endpoint is ready.");
      } catch (error) { message(error.message, true); }
    });
    $("forgetPairingButton")?.addEventListener("click", async () => {
      await cleanup(); localStorage.removeItem(PAIR_KEY); state.pairing = null; message("Pairing forgotten on this phone.");
    });
    $("pauseButton")?.addEventListener("click", () => remoteControl("pause"));
    $("resumeButton")?.addEventListener("click", () => remoteControl("resume"));
    $("emergencyButton")?.addEventListener("click", async () => {
      if (!confirm("Latch the JARVIS emergency stop? It cannot be cleared from this phone.")) return;
      if (mode === "assistant") {
        try { await localApi("/api/emergency-stop", {}); await cleanup("Emergency stop is latched."); message("Emergency stop latched."); }
        catch (error) { message(error.message, true); }
      } else await remoteControl("emergency_stop");
    });
    window.addEventListener("pagehide", () => {
      if (state.statusTimer) clearInterval(state.statusTimer);
      void cleanup();
    });
    window.addEventListener("offline", () => statusText("Internet connection lost. No new session can connect until the network returns."));
  }

  async function init() {
    initEvents();
    if ("serviceWorker" in navigator && mode === "phone" && location.protocol === "https:") navigator.serviceWorker.register("./sw.js").catch(() => {});
    if (mode === "assistant") {
      try {
        await loadLocalBootstrap();
        state.bootstrap.settings = state.bootstrap.status;
        $("notificationSetting").checked = !!state.bootstrap.status.notifications_enabled;
        $("morningSetting").checked = state.bootstrap.status.morning_enabled !== false;
        $("eveningSetting").checked = state.bootstrap.status.evening_enabled !== false;
        if (state.bootstrap.pairing) {
          $("pairingCode").value = JSON.stringify(state.bootstrap.pairing);
          $("copyPairButton").disabled = false;
        }
        if (state.bootstrap.status.emergency_stopped) statusText("Emergency stop is latched. Only the local PowerShell console can clear it.");
        state.statusTimer = setInterval(async () => {
          try {
            const status = await localApi("/api/status", undefined, "GET");
            state.bootstrap.status = status;
            state.bootstrap.settings = status;
            applyStatus(status);
          } catch (_error) { statusText("Local companion status is unavailable; scheduled notification state may be stale."); }
        }, 10000);
      } catch (error) { statusText(`Local JARVIS service unavailable: ${error.message}`); }
    } else {
      const saved = localStorage.getItem(PAIR_KEY);
      if (saved) { state.pairing = JSON.parse(saved); statusText("Phone is paired. Join when your laptop endpoint is ready."); }
      else statusText("Paste the pairing code from the laptop, then tap Join.");
    }
  }
  void init();
})();
