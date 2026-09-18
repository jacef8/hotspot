/**
 * HOTSPOT - Audio & Announcer Engine
 * Web Speech API for dramatic voice commentary (Seekers & Spectators only)
 * Web Audio API for synthetic pulse sound effects, count-down beeps, and tag alerts
 * Automatically SILENT for Hiders to prevent exposing their location!
 */

class HotspotAudio {
  constructor() {
    this.speechEnabled = true;
    this.audioFxEnabled = true;
    this.synth = window.speechSynthesis || null;
    this.audioCtx = null;
    this.lastSpokenBand = null;
    this.lastSpokenTime = 0;
    this.unlocked = false;
    this.voices = [];

    this.initVoices();
    this.setupUnlockListeners();
  }

  initVoices() {
    if (this.synth) {
      this.voices = this.synth.getVoices();
      if (this.synth.onvoiceschanged !== undefined) {
        this.synth.onvoiceschanged = () => {
          this.voices = this.synth.getVoices();
          this.chosenVoice = null;
          this.populateVoiceSelect();
        };
      }
    }
    // Voices often load a beat after the page does; the picker fills in when
    // they arrive, and once now in case they are already here.
    setTimeout(() => this.populateVoiceSelect(), 0);
  }

  // --- VOICE SELECTION ---
  // Every phone ships a different set of voices and the difference between the
  // best and the worst is enormous: an on-device "compact" voice sounds like a
  // 1990s toy, a network or "enhanced" neural voice sounds like a person. The old
  // code took the first voice whose name contained "US", "Google" or "Natural",
  // which on an iPhone falls through to the default (worst) voice. Rank instead.
  scoreVoice(v) {
    const name = (v.name || '');
    const lang = (v.lang || '').replace('_', '-');
    if (!/^en/i.test(lang)) return -1000;

    let s = 0;
    if (/^en-US$/i.test(lang)) s += 30;
    else if (/^en-(GB|AU|CA|IE|ZA|NZ)$/i.test(lang)) s += 12;
    else s += 4;

    // Neural / high-quality tiers, in the words the platforms use for them.
    if (/neural|natural/i.test(name)) s += 70;
    if (/premium/i.test(name)) s += 65;
    if (/enhanced/i.test(name)) s += 55;
    if (/siri/i.test(name)) s += 45;
    if (/online/i.test(name)) s += 25;
    // Chrome/Android network voices are the good ones; the local ones are not.
    if (/google/i.test(name)) s += v.localService === false ? 40 : 18;
    if (v.localService === false) s += 12;

    // Voices that read as a person rather than a demo.
    if (/\b(ava|allison|evan|nathan|zoe|tom|jenny|aria|guy|davis|samantha|aaron|nicky|noelle)\b/i.test(name)) s += 22;

    // The bottom of the barrel.
    if (/compact/i.test(name)) s -= 35;
    if (/espeak|festival|flite/i.test(name)) s -= 90;
    if (/\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|junior|kathy|organ|princess|ralph|trinoids|whisper|zarvox|fred|superstar|wobble|jester)\b/i.test(name)) s -= 200;
    return s;
  }

  englishVoices() {
    const list = (this.voices && this.voices.length) ? this.voices : (this.synth ? this.synth.getVoices() : []);
    return list.filter(v => /^en/i.test((v.lang || '').replace('_', '-')))
               .sort((a, b) => this.scoreVoice(b) - this.scoreVoice(a));
  }

  pickVoice() {
    if (this.chosenVoice) return this.chosenVoice;
    const list = this.englishVoices();
    if (!list.length) return null;

    let saved = null;
    try { saved = localStorage.getItem('hotspot_voice'); } catch (e) {}
    if (saved && saved !== 'auto') {
      const hit = list.find(v => v.voiceURI === saved || v.name === saved);
      if (hit) { this.chosenVoice = hit; return hit; }
    }
    this.chosenVoice = list[0];
    return this.chosenVoice;
  }

  populateVoiceSelect() {
    const sel = document.getElementById('voice-select');
    if (!sel) return;
    const list = this.englishVoices();
    if (!list.length) {
      sel.innerHTML = '<option value="auto">Phone default</option>';
      return;
    }
    let saved = 'auto';
    try { saved = localStorage.getItem('hotspot_voice') || 'auto'; } catch (e) {}
    const auto = list[0];
    const esc = window.hsEscape || ((x) => x);
    sel.innerHTML =
      `<option value="auto">Best available — ${esc(auto.name)}</option>` +
      list.map(v => `<option value="${esc(v.voiceURI || v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === saved) ? saved : 'auto';
    sel.onchange = () => {
      try { localStorage.setItem('hotspot_voice', sel.value); } catch (e) {}
      this.chosenVoice = null;
      this.testVoice();
    };
  }

  testVoice() {
    this.speak('Hot! You are closing in. Stay low and keep moving.');
  }

  // Sentence case for shouted words. Engines read capitals inconsistently —
  // some spell them, some stress them — and the result is the "yelling robot".
  humanize(text) {
    return String(text)
      .replace(/\b([A-Z])([A-Z]+)\b/g, (m, a, b) => (m === 'GPS' ? m : a + b.toLowerCase()))
      .replace(/!{2,}/g, '!');
  }

  setupUnlockListeners() {
    const unlock = () => {
      this.initAudioContext();
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      this.unlocked = true;
      if (this.synth && this.speechEnabled) {
        try {
          const u = new SpeechSynthesisUtterance('');
          u.volume = 0;
          this.synth.speak(u);
        } catch (e) {}
      }
    };

    ['click', 'touchstart', 'touchend', 'keydown'].forEach(evt => {
      window.addEventListener(evt, unlock, { once: true, capture: true });
    });
  }

  isHiderSilent() {
    return window.hotspotApp && window.hotspotApp.role === 'hider';
  }

  // Proximity cues (band callouts and pulse beeps) must not play on a hider's
  // phone, and also not on a spectator's — a parent standing near the hider was
  // effectively announcing "RED HOT, THEY ARE RIGHT THERE" to everyone nearby.
  // Game-state announcements (round start, tag, time) still play for spectators.
  isProximityMuted() {
    if (!window.hotspotApp) return false;
    const role = window.hotspotApp.role;
    return role === 'hider' || role === 'spectator';
  }

  initAudioContext() {
    if (!this.audioCtx) {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          this.audioCtx = new AudioCtx();
        }
      } catch (e) {
        console.warn('AudioContext creation error:', e);
      }
    }
  }

  toggleSpeech(enable) {
    this.speechEnabled = enable !== undefined ? enable : !this.speechEnabled;
    if (!this.speechEnabled && this.synth) {
      try { this.synth.cancel(); } catch(e) {}
    }
    return this.speechEnabled;
  }

  toggleAudioFx(enable) {
    this.audioFxEnabled = enable !== undefined ? enable : !this.audioFxEnabled;
    return this.audioFxEnabled;
  }

  speak(text, rate = 1.0, pitch = 1.0) {
    if (!this.speechEnabled || !this.synth) return;
    if (this.isHiderSilent()) return; // SILENT FOR HIDER!

    try {
      this.initAudioContext();
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      this.synth.cancel();

      const utterance = new SpeechSynthesisUtterance(this.humanize(text));
      // Rate and pitch are held near natural. The old callouts went up to 1.3x
      // speed and 1.2 pitch for "excitement", which is exactly what makes a
      // synthetic voice sound synthetic. Urgency now comes from the words.
      utterance.rate = Math.max(0.92, Math.min(1.08, rate));
      utterance.pitch = Math.max(0.94, Math.min(1.06, pitch));
      utterance.lang = 'en-US';

      if (!this.voices || this.voices.length === 0) {
        this.voices = this.synth.getVoices();
      }

      const voice = this.pickVoice();
      if (voice) {
        utterance.voice = voice;
        if (voice.lang) utterance.lang = voice.lang;
      }

      this.synth.speak(utterance);
    } catch (e) {
      console.warn('Speech synthesis failed:', e);
    }
  }

  playPulseBeep(band) {
    if (!this.audioFxEnabled) return;
    if (this.isProximityMuted()) return;

    try {
      this.initAudioContext();
      if (!this.audioCtx || this.audioCtx.state === 'suspended') return;

      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      let freq = 220;
      let duration = 0.12;

      if (band === 'WARM') { freq = 349.23; duration = 0.10; }
      else if (band === 'HOT') { freq = 523.25; duration = 0.08; }
      else if (band === 'HOTTER') { freq = 783.99; duration = 0.06; }
      else if (band === 'REDHOT') { freq = 1046.50; duration = 0.15; }

      osc.type = band === 'REDHOT' ? 'sawtooth' : 'sine';
      osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);

      gain.gain.setValueAtTime(0.15, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + duration);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start();
      osc.stop(this.audioCtx.currentTime + duration);
    } catch (e) {
      console.warn('Pulse beep failed:', e);
    }
  }

  playPowerupSound(type) {
    if (!this.audioFxEnabled) return;
    if (this.isHiderSilent()) return; // SILENT FOR HIDER!

    try {
      this.initAudioContext();
      if (!this.audioCtx || this.audioCtx.state === 'suspended') return;

      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      const now = this.audioCtx.currentTime;

      if (type === 'decoy') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1760, now + 0.2);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
      } else if (type === 'smoke') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.linearRampToValueAtTime(60, now + 0.4);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
      } else if (type === 'bearing') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1200, now);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      }

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start();
      osc.stop(now + (type === 'smoke' ? 0.4 : 0.35));
    } catch (e) {
      console.warn('Powerup sound failed:', e);
    }
  }

  playCountdownBeep(isFinal = false) {
    if (!this.audioFxEnabled) return;
    if (this.isHiderSilent()) return; // SILENT FOR HIDER!

    try {
      this.initAudioContext();
      if (!this.audioCtx || this.audioCtx.state === 'suspended') return;

      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      const now = this.audioCtx.currentTime;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(isFinal ? 880 : 440, now);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + (isFinal ? 0.4 : 0.15));

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start();
      osc.stop(now + (isFinal ? 0.4 : 0.15));
    } catch (e) {
      console.warn('Countdown beep failed:', e);
    }
  }

  playTagScream() {
    if (!this.audioFxEnabled) return;
    try {
      this.initAudioContext();
      if (!this.audioCtx || this.audioCtx.state === 'suspended') return;

      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.linearRampToValueAtTime(1200, now + 0.2);
      osc.frequency.linearRampToValueAtTime(300, now + 0.4);
      osc.frequency.linearRampToValueAtTime(1500, now + 0.6);

      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.8);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start();
      osc.stop(now + 0.8);
    } catch (e) {
      console.warn('Tag sound failed:', e);
    }
  }

  announceBandChange(band) {
    if (this.isProximityMuted()) return;

    const now = Date.now();
    if (this.lastSpokenBand === band && now - this.lastSpokenTime < 8000) {
      return;
    }
    this.lastSpokenBand = band;
    this.lastSpokenTime = now;

    // A person calling this out would not say the same sentence every time.
    // Several natural phrasings per band, never the same one twice running.
    const LINES = {
      COLD: [
        'Nothing yet. Keep searching.',
        'Still cold. Try a different direction.',
        'You are a long way off.'
      ],
      WARM: [
        'Getting warmer.',
        'Warmer. You are on the right track.',
        'That is warmer. Keep going.'
      ],
      HOT: [
        'Hot. You are getting close.',
        'Hot now. Stay with it.',
        'You are close. Slow down and look around.'
      ],
      HOTTER: [
        'Very close now.',
        'Hotter. They are right around here.',
        'Almost on top of them.'
      ],
      REDHOT: [
        'Red hot. They are right there.',
        'Right on top of them. Look around.',
        'They are within reach.'
      ]
    };

    const pool = LINES[band];
    if (!pool) return;
    this.lastLineIdx = this.lastLineIdx || {};
    let i = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && i === this.lastLineIdx[band]) i = (i + 1) % pool.length;
    this.lastLineIdx[band] = i;

    // Close calls run a touch quicker; nothing goes far from natural speech.
    const rate = band === 'REDHOT' ? 1.08 : band === 'HOTTER' ? 1.05 : 1.0;
    this.speak(pool[i], rate, 1.0);
  }
}

window.hotspotAudio = new HotspotAudio();
