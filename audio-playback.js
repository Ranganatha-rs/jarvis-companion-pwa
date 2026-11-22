"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.JarvisVoiceAudio = api;
})(globalThis, function () {
  function waitForSource(source, timeoutMs) {
    const timeout = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 30000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        source.onended = null;
        source.onerror = null;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => {
        try { source.stop(); } catch (_error) {}
        finish(new Error("Audio playback timed out."));
      }, timeout);
      source.onended = () => finish();
      source.onerror = event => finish(new Error(event?.error?.message || "Audio playback failed."));
      try { source.start(); } catch (error) { finish(error); }
    });
  }

  function speakFallback(text, environment = globalThis, timeoutMs = 20000) {
    const clean = String(text || "").trim();
    const synth = environment?.speechSynthesis;
    const Utterance = environment?.SpeechSynthesisUtterance;
    if (!clean) return Promise.resolve({spoken: false, reason: "empty_text"});
    if (!synth || typeof synth.speak !== "function" || typeof Utterance !== "function") {
      return Promise.resolve({spoken: false, reason: "speech_synthesis_unavailable"});
    }
    return new Promise(resolve => {
      let settled = false;
      let utterance = null;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (utterance) { utterance.onend = null; utterance.onerror = null; }
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { synth.cancel(); } catch (_error) {}
        finish({spoken: false, reason: "speech_synthesis_timeout"});
      }, timeoutMs);
      try {
        const voices = synth.getVoices?.() || [];
        const english = voices.filter(voice => /^en(?:[-_]|$)/i.test(voice.lang || ""));
        if (!english.length) {
          finish({spoken: false, reason: voices.length ? "no_english_voice" : "no_voice_available"});
          return;
        }
        utterance = new Utterance(clean);
        utterance.voice = english.find(voice => voice.default) || english[0];
        utterance.lang = utterance.voice.lang || "en-US";
        utterance.onend = () => finish({spoken: true, voice: utterance.voice.name || "English"});
        utterance.onerror = event => finish({spoken: false, reason: event?.error || "speech_synthesis_error"});
        synth.speak(utterance);
      } catch (_error) {
        finish({spoken: false, reason: "speech_synthesis_error"});
      }
    });
  }

  function cancelFallback(environment = globalThis) {
    try { environment?.speechSynthesis?.cancel(); } catch (_error) {}
  }

  return {waitForSource, speakFallback, cancelFallback};
});
