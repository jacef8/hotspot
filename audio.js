/**
 * HOTSPOT - Audio & Announcer Engine
 * Web Speech API for dramatic voice commentary
 * Web Audio API for synthetic pulse sound effects, count-down beeps, and tag alerts
 */

class HotspotAudio {
  constructor() {
    this.speechEnabled = true;
    this.audioFxEnabled = true;
    this.synth = window.speechSynthesis || null;
    this.audioCtx = null;
    this.lastSpokenBand = null;
    this.lastSpokenTime = 0;
  }

  initAudioContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.audioCtx = new AudioCtx();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  toggleSpeech(enable) {
    this.speechEnabled = enable !== undefined ? enable : !this.speechEnabled;
    if (!this.speechEnabled && this.synth) {
      this.synth.cancel();
    }
    return this.speechEnabled;
  }

  toggleAudioFx(enable) {
    this.audioFxEnabled = enable !== undefined ? enable : !this.audioFxEnabled;
    return this.audioFxEnabled;
  }

  /**
   * Speak a voice prompt using Web Speech API
   * @param {string} text - Message to speak
   * @param {number} rate - Speech rate multiplier
   * @param {number} pitch - Speech pitch
   */
  speak(text, rate = 1.1, pitch = 1.0) {
    if (!this.speechEnabled || !this.synth) return;
    this.initAudioContext();

    // Cancel current speech to prevent queue build-up during fast movement
    this.synth.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.pitch = pitch;

    // Pick an English voice if available
    const voices = this.synth.getVoices();
    const engVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('US')));
    if (engVoice) utterance.voice = engVoice;

    this.synth.speak(utterance);
  }

  /**
   * Play a synthetic pulse beep scaling frequency and pitch with distance band
   * @param {string} band - 'COLD' | 'STRUCK' | 'TRAILING' | 'BAYING' | 'TREED'
   */
  playPulseBeep(band) {
    if (!this.audioFxEnabled) return;
    this.initAudioContext();
    if (!this.audioCtx) return;

    try {
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      let freq = 220; // Cold
      let duration = 0.12;

      if (band === 'STRUCK') { freq = 349.23; duration = 0.10; }
      else if (band === 'TRAILING') { freq = 523.25; duration = 0.08; }
      else if (band === 'BAYING') { freq = 783.99; duration = 0.06; }
      else if (band === 'TREED') { freq = 1046.50; duration = 0.15; }

      osc.type = band === 'TREED' ? 'sawtooth' : 'sine';
      osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);

      gain.gain.setValueAtTime(0.15, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + duration);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start();
      osc.stop(this.audioCtx.currentTime + duration);
    } catch (e) {
      console.warn('Audio FX play failed:', e);
    }
  }

  playPowerupSound(type) {
    if (!this.audioFxEnabled) return;
    this.initAudioContext();
    if (!this.audioCtx) return;

    try {
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
    this.initAudioContext();
    if (!this.audioCtx) return;

    try {
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
    this.initAudioContext();
    if (!this.audioCtx) return;

    try {
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
    const now = Date.now();
    if (this.lastSpokenBand === band && now - this.lastSpokenTime < 8000) {
      return;
    }
    this.lastSpokenBand = band;
    this.lastSpokenTime = now;

    switch (band) {
      case 'COLD':
        this.speak('Signal Cold. Keep searching!', 1.0, 0.9);
        break;
      case 'STRUCK':
        this.speak('Signal struck! You got a scent!', 1.1, 1.0);
        break;
      case 'TRAILING':
        this.speak('Warmer! Trailing closely!', 1.15, 1.05);
        break;
      case 'BAYING':
        this.speak('Baying range! You are burning up!', 1.25, 1.1);
        break;
      case 'TREED':
        this.speak('TREED! HIDER IN SIGHT!', 1.3, 1.2);
        break;
    }
  }
}

window.hotspotAudio = new HotspotAudio();
