/**
 * HOTSPOT - Main Game Engine & Controller
 * Integrates Firebase RTDB, Game State, Solo Drill, Powerups, Proximity Engine,
 * Voice Announcer, Haptic Vibe, Spectator, and Replay.
 */

window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;

class HotspotApp {
  constructor() {
    this.db = null;
    this.roomCode = null;
    this.playerId = 'player_' + Math.random().toString(36).substr(2, 6);
    this.playerName = 'Runner_' + Math.floor(Math.random() * 899 + 100);
    this.role = 'seeker'; // 'hider' | 'seeker' | 'spectator'
    this.gameMode = 'classic'; // 'classic' | 'infection'
    this.gameState = 'lobby'; // 'lobby' | 'headstart' | 'active' | 'gameover'
    this.headStartSeconds = 60;
    this.headStartTimer = null;
    this.headStartRemaining = 60;

    this.isSoloDrill = false;
    this.players = {};
    this.hiderId = null;

    // Default immediate position fallback (Central Park coordinates if GPS pending)
    this.myPosition = { lat: 37.774929, lng: -122.419416, accuracy: 8, timestamp: Date.now() };

    this.powerups = {
      decoyUsed: false,
      smokeUsed: false,
      bearingPingUsed: false,
      decoyActive: false,
      smokeActive: false,
      bearingActive: false
    };

    this.decoyPos = null;
    this.decoyTimeout = null;
    this.smokeTimeout = null;
    this.bearingTimeout = null;

    this.matchTrackHistory = [];
    this.tagEvent = null;
    this.gameStartTime = 0;

    this.pulseInterval = null;
    this.currentBand = 'COLD';
    this.currentDistance = 999;
    this.lastPulseTime = 0;

    this.initFirebase();
    this.bindDOMEvents();
  }

  initFirebase() {
    if (window.FIREBASE_CONFIG && typeof firebase !== 'undefined' && firebase.apps) {
      try {
        if (!firebase.apps.length) {
          firebase.initializeApp(window.FIREBASE_CONFIG);
        }
        this.db = firebase.database();
        console.log('Firebase initialized successfully.');
      } catch (e) {
        console.warn('Firebase init error, using Local mode:', e);
      }
    }
  }

  toggleSound() {
    const speechEnabled = window.hotspotAudio.toggleSpeech();
    const btn = document.getElementById('sound-btn');
    if (btn) {
      btn.innerText = speechEnabled ? '🔊 Voice' : '🔇 Muted';
    }
  }

  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');
  }

  bindDOMEvents() {
    document.addEventListener('DOMContentLoaded', () => {
      this.updateSeasonStatsDisplay();
    });
  }

  // --- SOLO DRILL MODE ---
  startSoloDrill() {
    this.isSoloDrill = true;
    this.roomCode = 'SOLO';
    this.role = 'seeker';
    this.gameState = 'active';

    const hiderPos = window.hotspotGeo.startSoloDrill(100);

    this.players = {
      [this.playerId]: { id: this.playerId, name: this.playerName, role: 'seeker' },
      'solo_hider': { id: 'solo_hider', name: 'Virtual Hider', role: 'hider', lat: hiderPos.lat, lng: hiderPos.lng, accuracy: 5 }
    };
    this.hiderId = 'solo_hider';

    window.hotspotAudio.speak('Solo Drill initialized! Virtual hider planted 100 meters out.');

    this.startGpsTracking();
    this.showScreen('seeker-screen');
    
    // Enable solo controls UI
    const soloControls = document.getElementById('solo-controls-card');
    if (soloControls) soloControls.style.display = 'block';

    this.startPulseLoop();
  }

  moveSoloHider(deltaMeters) {
    if (!this.isSoloDrill) return;
    let hiderPos;
    if (deltaMeters < 0) {
      hiderPos = window.hotspotGeo.moveSoloHiderCloser(Math.abs(deltaMeters));
    } else {
      hiderPos = window.hotspotGeo.moveSoloHiderAway(deltaMeters);
    }

    if (this.players['solo_hider']) {
      this.players['solo_hider'].lat = hiderPos.lat;
      this.players['solo_hider'].lng = hiderPos.lng;
    }
    window.hotspotAudio.speak(`Virtual hider moved to ${Math.round(hiderPos.currentDistMeters)} meters`);
  }

  instantTagSoloHider() {
    if (!this.isSoloDrill) return;
    const hiderPos = window.hotspotGeo.setSoloHiderDistance(4);
    if (this.players['solo_hider']) {
      this.players['solo_hider'].lat = hiderPos.lat;
      this.players['solo_hider'].lng = hiderPos.lng;
    }
  }

  // --- MULTIPLAYER ROOM SETUP ---
  createRoom(headStartSec = 60, mode = 'classic') {
    this.isSoloDrill = false;
    this.headStartSeconds = parseInt(headStartSec, 10) || 60;
    this.gameMode = mode;
    this.roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.role = 'hider';
    this.hiderId = this.playerId;
    this.gameState = 'lobby';

    this.players = {
      [this.playerId]: { id: this.playerId, name: this.playerName, role: 'hider' }
    };

    if (this.db) {
      this.db.ref('rooms/' + this.roomCode).set({
        code: this.roomCode,
        hostId: this.playerId,
        hiderId: this.hiderId,
        gameState: 'lobby',
        headStartSeconds: this.headStartSeconds,
        gameMode: this.gameMode,
        players: this.players,
        createdAt: Date.now()
      });

      this.listenToRoom();
    }

    document.getElementById('lobby-code-display').innerText = this.roomCode;
    this.updateLobbyList();
    this.showScreen('lobby-screen');

    window.hotspotAudio.speak(`Hunt created. Code is ${this.roomCode.split('').join(' ')}`);
  }

  joinRoom(code, nickname, role = 'seeker') {
    this.isSoloDrill = false;
    this.roomCode = code.toUpperCase().trim();
    this.playerName = nickname || this.playerName;
    this.role = role;
    this.gameState = 'lobby';

    if (this.db) {
      const roomRef = this.db.ref('rooms/' + this.roomCode);
      roomRef.once('value', snapshot => {
        if (!snapshot.exists()) {
          alert('Room code not found! Check code and try again.');
          return;
        }

        const data = snapshot.val();
        this.hiderId = data.hiderId;
        this.gameMode = data.gameMode || 'classic';

        roomRef.child('players/' + this.playerId).set({
          id: this.playerId,
          name: this.playerName,
          role: this.role
        });

        this.listenToRoom();
        document.getElementById('lobby-code-display').innerText = this.roomCode;
        this.showScreen('lobby-screen');
      });
    } else {
      this.players[this.playerId] = { id: this.playerId, name: this.playerName, role: this.role };
      document.getElementById('lobby-code-display').innerText = this.roomCode;
      this.updateLobbyList();
      this.showScreen('lobby-screen');
    }
  }

  toggleRole() {
    this.role = this.role === 'hider' ? 'seeker' : 'hider';
    if (this.players[this.playerId]) {
      this.players[this.playerId].role = this.role;
    }

    if (this.db && this.roomCode) {
      this.db.ref(`rooms/${this.roomCode}/players/${this.playerId}`).update({ role: this.role });
      if (this.role === 'hider') {
        this.db.ref(`rooms/${this.roomCode}`).update({ hiderId: this.playerId });
      }
    }
    this.updateLobbyList();
    window.hotspotAudio.speak(`Switched role to ${this.role.toUpperCase()}`);
  }

  listenToRoom() {
    if (!this.db || !this.roomCode) return;

    const roomRef = this.db.ref('rooms/' + this.roomCode);

    roomRef.on('value', snapshot => {
      if (!snapshot.exists()) return;
      const data = snapshot.val();

      this.players = data.players || {};
      this.hiderId = data.hiderId;
      this.gameMode = data.gameMode || 'classic';
      this.updateLobbyList();

      if (data.gameState !== this.gameState) {
        this.gameState = data.gameState;
        this.handleGameStateChange(this.gameState);
      }

      if (data.powerups) {
        if (data.powerups.smokeActive && !this.powerups.smokeActive) {
          this.triggerSmokeVisual(true);
        } else if (!data.powerups.smokeActive && this.powerups.smokeActive) {
          this.triggerSmokeVisual(false);
        }
        if (data.powerups.decoyPos) {
          this.decoyPos = data.powerups.decoyPos;
        } else {
          this.decoyPos = null;
        }
      }

      if (data.tagEvent && !this.tagEvent) {
        this.handleTagEvent(data.tagEvent);
      }
    });
  }

  updateLobbyList() {
    const hidersList = Object.values(this.players).filter(p => p.role === 'hider');
    const seekersList = Object.values(this.players).filter(p => p.role === 'seeker');

    const hiderContainer = document.getElementById('lobby-hider-list');
    const seekerContainer = document.getElementById('lobby-seeker-list');

    if (hiderContainer) {
      hiderContainer.innerHTML = hidersList.map(p => `
        <div class="player-badge hider">
          <span class="role-icon">👑 HIDER</span>
          <span class="name">${p.name} ${p.id === this.playerId ? '<span class="you-badge">(YOU)</span>' : ''}</span>
        </div>
      `).join('') || '<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:6px;">No Hider Selected</div>';
    }

    if (seekerContainer) {
      seekerContainer.innerHTML = seekersList.map(p => `
        <div class="player-badge seeker">
          <span class="role-icon">🏃 SEEKER</span>
          <span class="name">${p.name} ${p.id === this.playerId ? '<span class="you-badge">(YOU)</span>' : ''}</span>
        </div>
      `).join('') || '<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:6px;">No Seekers Joined Yet</div>';
    }
  }

  // --- GAME START & HEADSTART ---
  startHeadstart() {
    if (this.db) {
      this.db.ref(`rooms/${this.roomCode}`).update({
        gameState: 'headstart',
        headStartStartTime: Date.now()
      });
    } else {
      this.handleGameStateChange('headstart');
    }
  }

  handleGameStateChange(newState) {
    if (newState === 'headstart') {
      this.headStartRemaining = this.headStartSeconds;
      this.startGpsTracking();

      if (this.role === 'hider') {
        this.showScreen('hider-screen');
      } else if (this.role === 'seeker') {
        this.showScreen('seeker-screen');
      } else if (this.role === 'spectator') {
        this.showScreen('spectator-screen');
        window.hotspotReplay.initMap('spectator-map');
      }

      window.hotspotAudio.speak(`Turn the pack loose! Hider gets ${this.headStartSeconds} seconds head start!`);

      this.headStartTimer = setInterval(() => {
        this.headStartRemaining -= 1;
        document.querySelectorAll('.headstart-counter').forEach(el => el.innerText = `${this.headStartRemaining}s`);

        if (this.headStartRemaining <= 5 && this.headStartRemaining > 0) {
          window.hotspotAudio.playCountdownBeep(false);
        }

        if (this.headStartRemaining === 30 || this.headStartRemaining === 15) {
          window.hotspotAudio.speak(`${this.headStartRemaining} seconds remaining!`);
        }

        if (this.headStartRemaining <= 0) {
          clearInterval(this.headStartTimer);
          window.hotspotAudio.playCountdownBeep(true);
          window.hotspotAudio.speak('PACK RELEASED! HUNT IS LIVE!');

          if (this.role === 'hider' && this.db) {
            this.db.ref(`rooms/${this.roomCode}`).update({ gameState: 'active' });
          } else if (!this.db) {
            this.handleGameStateChange('active');
          }
        }
      }, 1000);

    } else if (newState === 'active') {
      this.gameStartTime = Date.now();
      this.startPulseLoop();
    } else if (newState === 'gameover') {
      this.stopPulseLoop();
      this.showScreen('replay-screen');
      if (window.hotspotReplay) {
        window.hotspotReplay.loadReplayData(this.matchTrackHistory, this.tagEvent);
      }
    }
  }

  startGpsTracking() {
    window.hotspotGeo.startTracking(
      (pos) => this.onGpsUpdate(pos),
      (err) => this.onGpsError(err)
    );
  }

  onGpsUpdate(pos) {
    this.myPosition = pos;

    document.querySelectorAll('.accuracy-tag').forEach(el => {
      el.innerText = `±${Math.round(pos.accuracy)}m`;
    });

    const warnBox = document.getElementById('gps-warning-banner');
    if (warnBox) {
      if (pos.isProtocolWarning) {
        warnBox.innerText = '⚠️ Opened as local file — GPS requires HTTPS web server (e.g. Railway, Vercel).';
        warnBox.style.display = 'block';
      } else if (pos.accuracy > 15) {
        warnBox.innerText = `⚠️ Weak GPS Fix (±${Math.round(pos.accuracy)}m) — Move out from under heavy tree canopy!`;
        warnBox.style.display = 'block';
      } else {
        warnBox.style.display = 'none';
      }
    }

    if (this.db && this.roomCode) {
      this.db.ref(`rooms/${this.roomCode}/players/${this.playerId}`).update({
        lat: pos.lat,
        lng: pos.lng,
        accuracy: pos.accuracy,
        timestamp: Date.now()
      });
    }

    this.recordTrackPoint(this.playerId, this.playerName, this.role, pos);
  }

  onGpsError(errMessage) {
    const warnBox = document.getElementById('gps-warning-banner');
    if (warnBox) {
      warnBox.innerText = `❌ ${errMessage}`;
      warnBox.style.display = 'block';
    }
  }

  recordTrackPoint(playerId, name, role, pos) {
    let track = this.matchTrackHistory.find(t => t.playerId === playerId);
    if (!track) {
      track = { playerId, name, role, points: [] };
      this.matchTrackHistory.push(track);
    }
    track.points.push({ lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, timestamp: Date.now() });
  }

  // --- PULSE LOOP (SEEKER PROXIMITY) ---
  startPulseLoop() {
    if (this.pulseInterval) clearInterval(this.pulseInterval);

    this.pulseInterval = setInterval(() => {
      if (this.gameState !== 'active') return;
      this.updateProximityEngine();
    }, 250);
  }

  stopPulseLoop() {
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = null;
    }
  }

  updateProximityEngine() {
    if (!this.myPosition) return;

    let hiderPos = null;

    if (this.isSoloDrill) {
      hiderPos = window.hotspotGeo.soloHiderPosition;
    } else {
      const hiderPlayer = this.players[this.hiderId];
      if (hiderPlayer && hiderPlayer.lat) {
        hiderPos = { lat: hiderPlayer.lat, lng: hiderPlayer.lng };
      }
    }

    if (this.decoyPos) {
      hiderPos = this.decoyPos;
    }

    if (!hiderPos) return;

    const bufferedHiderPos = window.hotspotGeo.getBufferedPosition(this.myPosition, hiderPos);

    const distMeters = window.hotspotGeo.calculateDistance(
      this.myPosition.lat, this.myPosition.lng,
      bufferedHiderPos.lat, bufferedHiderPos.lng
    );

    this.currentDistance = distMeters;

    const bandInfo = window.hotspotGeo.getDistanceBand(distMeters);
    this.currentBand = bandInfo.band;

    if (this.role === 'seeker') {
      const pulseRing = document.getElementById('seeker-pulse-ring');
      const bandLabel = document.getElementById('seeker-band-label');

      if (bandLabel) bandLabel.innerText = bandInfo.label;

      if (pulseRing) {
        pulseRing.style.borderColor = bandInfo.color;
        pulseRing.style.boxShadow = `0 0 40px ${bandInfo.color}`;
        pulseRing.style.animationDuration = `${bandInfo.pulseMs}ms`;
      }

      const now = Date.now();
      if (!this.lastPulseTime || now - this.lastPulseTime >= bandInfo.pulseMs) {
        this.lastPulseTime = now;
        window.hotspotGeo.vibratePulse(bandInfo.pulseMs);
        window.hotspotAudio.playPulseBeep(bandInfo.band);
      }

      window.hotspotAudio.announceBandChange(bandInfo.band);

      if (this.powerups.bearingActive) {
        const bearing = window.hotspotGeo.calculateBearing(
          this.myPosition.lat, this.myPosition.lng,
          bufferedHiderPos.lat, bufferedHiderPos.lng
        );
        const arrow = document.getElementById('bearing-arrow');
        if (arrow) {
          arrow.style.display = 'block';
          arrow.style.transform = `rotate(${bearing}deg)`;
        }
      }
    }

    if (this.role === 'hider') {
      const distEl = document.getElementById('hider-nearest-dist');
      if (distEl) distEl.innerText = `${Math.round(distMeters)}m`;
    }

    if (this.role === 'spectator') {
      window.hotspotReplay.updateSpectatorView(this.players);
    }

    if (distMeters <= 8 && this.gameState === 'active') {
      this.triggerTag(this.playerId, this.playerName, this.hiderId);
    }
  }

  // --- POWERUPS ---
  usePowerup(type) {
    if (type === 'decoy' && !this.powerups.decoyUsed) {
      this.powerups.decoyUsed = true;
      const btn = document.getElementById('btn-powerup-decoy');
      if (btn) btn.disabled = true;

      window.hotspotAudio.playPowerupSound('decoy');
      window.hotspotAudio.speak('Decoy deployed! Fake hot signal active for 30 seconds!');

      if (this.myPosition) {
        const decoy = window.hotspotGeo.startSoloDrill(80);
        this.decoyPos = decoy;
        if (this.db) {
          this.db.ref(`rooms/${this.roomCode}/powerups`).update({ decoyPos: decoy });
        }
      }

      setTimeout(() => {
        this.decoyPos = null;
        if (this.db) {
          this.db.ref(`rooms/${this.roomCode}/powerups/decoyPos`).remove();
        }
      }, 30000);

    } else if (type === 'smoke' && !this.powerups.smokeUsed) {
      this.powerups.smokeUsed = true;
      const btn = document.getElementById('btn-powerup-smoke');
      if (btn) btn.disabled = true;

      window.hotspotAudio.playPowerupSound('smoke');
      window.hotspotAudio.speak('Smoke screen thrown! Seekers blinded for 15 seconds!');

      if (this.db) {
        this.db.ref(`rooms/${this.roomCode}/powerups`).update({ smokeActive: true });
      } else {
        this.triggerSmokeVisual(true);
      }

      setTimeout(() => {
        if (this.db) {
          this.db.ref(`rooms/${this.roomCode}/powerups`).update({ smokeActive: false });
        } else {
          this.triggerSmokeVisual(false);
        }
      }, 15000);

    } else if (type === 'bearing' && !this.powerups.bearingPingUsed) {
      this.powerups.bearingPingUsed = true;
      this.powerups.bearingActive = true;
      const btn = document.getElementById('btn-bearing-ping');
      if (btn) btn.disabled = true;

      window.hotspotAudio.playPowerupSound('bearing');
      window.hotspotAudio.speak('Bearing Ping active! Live compass arrow for 3 seconds!');

      setTimeout(() => {
        this.powerups.bearingActive = false;
        const arrow = document.getElementById('bearing-arrow');
        if (arrow) arrow.style.display = 'none';
      }, 3000);
    }
  }

  triggerSmokeVisual(active) {
    this.powerups.smokeActive = active;
    const pulseRing = document.getElementById('seeker-pulse-ring');
    const bandLabel = document.getElementById('seeker-band-label');

    if (active) {
      if (pulseRing) pulseRing.classList.add('smoke-blind');
      if (bandLabel) bandLabel.innerText = '💨 SMOKE SCREEN';
    } else {
      if (pulseRing) pulseRing.classList.remove('smoke-blind');
    }
  }

  triggerTag(seekerId, seekerName, hiderId) {
    if (this.gameState !== 'active') return;

    window.hotspotAudio.playTagScream();
    window.hotspotAudio.speak(`TREED AND TAGGED! ${seekerName} caught the hider!`);

    const hiderName = this.players[hiderId] ? this.players[hiderId].name : 'Hider';

    this.tagEvent = {
      seekerId,
      seekerName,
      hiderId,
      hiderName,
      lat: this.myPosition ? this.myPosition.lat : 0,
      lng: this.myPosition ? this.myPosition.lng : 0,
      timestamp: Date.now()
    };

    if (this.gameMode === 'infection') {
      window.hotspotAudio.speak(`Infection mode! ${hiderName} has joined the hider pack!`);
      if (this.db) {
        this.db.ref(`rooms/${this.roomCode}/players/${hiderId}`).update({ role: 'hider' });
      }
    } else {
      this.gameState = 'gameover';
      if (this.db) {
        this.db.ref(`rooms/${this.roomCode}`).update({
          gameState: 'gameover',
          tagEvent: this.tagEvent
        });
      } else {
        this.handleGameStateChange('gameover');
      }
    }

    this.saveSeasonStats(Date.now() - this.gameStartTime);
  }

  saveSeasonStats(huntDurationMs) {
    try {
      const stats = JSON.parse(localStorage.getItem('hotspot_stats') || '{"totalHunts":0,"fastestTagSec":9999,"longestHideSec":0}');
      stats.totalHunts += 1;
      const durationSec = Math.floor(huntDurationMs / 1000);

      if (durationSec < stats.fastestTagSec) stats.fastestTagSec = durationSec;
      if (durationSec > stats.longestHideSec) stats.longestHideSec = durationSec;

      localStorage.setItem('hotspot_stats', JSON.stringify(stats));
      this.updateSeasonStatsDisplay();
    } catch (e) {}
  }

  updateSeasonStatsDisplay() {
    try {
      const stats = JSON.parse(localStorage.getItem('hotspot_stats') || '{"totalHunts":0,"fastestTagSec":0,"longestHideSec":0}');
      const elHunts = document.getElementById('stat-total-hunts');
      const elFastest = document.getElementById('stat-fastest-tag');
      const elLongest = document.getElementById('stat-longest-hide');

      if (elHunts) elHunts.innerText = stats.totalHunts;
      if (elFastest) elFastest.innerText = stats.fastestTagSec === 9999 ? '--' : `${stats.fastestTagSec}s`;
      if (elLongest) elLongest.innerText = `${stats.longestHideSec}s`;
    } catch (e) {}
  }
}

window.hotspotApp = new HotspotApp();
