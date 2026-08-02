/**
 * HOTSPOT - Main Game Engine & Controller
 * Standard US Customary Units (Feet & Yards).
 * HTTPS cloud sync over Port 443: SSE primary receive, 3s heartbeat publish,
 * HTTP GET polling only as a fallback when SSE goes silent.
 * Round identity is carried by roundId (no cross-device clock comparison).
 */

window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;

class HotspotApp {
  constructor() {
    this.eventSource = null;
    this.heartbeatInterval = null;

    this.roomCode = null;
    this.joinTime = 0;
    this.currentRoundId = null;
    this.seenRoundIds = {};
    this.seenMsgIds = {};
    this.seenMsgCount = 0;
    this.taggedHiderIds = {};
    this.lastCloudMessageAt = 0;
    this.syncFailCount = 0;
    this.playerId = 'player_' + Math.random().toString(36).substr(2, 6);
    this.playerName = 'Runner_' + Math.floor(Math.random() * 899 + 100);
    this.role = 'seeker'; // 'hider' | 'seeker' | 'spectator'
    this.gameMode = 'classic'; // 'classic' | 'infection'
    this.gameState = 'lobby'; // 'lobby' | 'headstart' | 'active' | 'gameover'
    this.headStartSeconds = 60;
    this.boundaryRadius = 250; // Feet
    this.yardCenterPos = null;

    this.headStartTimer = null;
    this.headStartRemaining = 60;
    this.headStartStartTime = 0;

    this.isSoloDrill = false;
    this.players = {};
    this.hiderId = null;

    this.myPosition = { lat: 37.774929, lng: -122.419416, accuracy: 25, timestamp: Date.now() };

    this.powerups = {
      decoyUsed: false,
      smokeUsed: false,
      bearingPingUsed: false,
      decoyActive: false,
      smokeActive: false,
      bearingActive: false
    };

    this.decoyPos = null;
    this.matchTrackHistory = [];
    this.tagEvent = null;
    this.gameStartTime = 0;

    this.pulseInterval = null;
    this.currentBand = 'COLD';
    this.currentDistance = 999;
    this.lastPulseTime = 0;

    this.clearStaleCache();
    this.startGpsTracking(); // Immediate GPS start
  }

  clearStaleCache() {
    try {
      sessionStorage.clear();
      const stats = localStorage.getItem('hotspot_stats');
      localStorage.clear();
      if (stats) localStorage.setItem('hotspot_stats', stats);
    } catch(e) {}
  }

  getTopic() {
    if (!this.roomCode) return null;
    return 'hotspot_r243_' + this.roomCode.toLowerCase();
  }

  updateSyncStatus(ok, note) {
    const banner = document.getElementById('sync-warning-banner');
    const homeLabel = document.getElementById('cloud-sync-status');

    if (ok) {
      this.syncFailCount = 0;
      if (banner) banner.style.display = 'none';
      if (homeLabel && this.roomCode) {
        homeLabel.innerText = '🟢 Cloud sync live — room ' + this.roomCode;
      }
      return;
    }

    this.syncFailCount++;
    if (this.syncFailCount < 3) return;

    const msg = '⚠️ CLOUD SYNC FAILING' + (note ? ' — ' + note : '') + ' — players may not update.';
    if (banner) {
      banner.innerText = msg;
      banner.style.display = 'block';
    }
    if (homeLabel) homeLabel.innerText = msg;
  }

  requestGpsPermissionDirectly() {
    window.hotspotGeo.startTracking(
      (pos) => this.onGpsUpdate(pos),
      (err) => this.onGpsError(err)
    );
  }

  // --- 100% BULLETPROOF HTTPS 1-SECOND HEARTBEAT CLOUD SYNC ---
  initCloudSync() {
    if (!this.roomCode) return;
    const topic = this.getTopic();

    // 1. Clear existing timers and streams
    if (this.eventSource) {
      try { this.eventSource.close(); } catch(e) {}
      this.eventSource = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    this.seenMsgIds = {};
    this.seenMsgCount = 0;
    this.lastCloudMessageAt = Date.now();
    this.syncFailCount = 0;

    // 2. Open HTTPS Server-Sent Events (SSE) over Port 443 — primary receive path.
    //    One long-lived connection, so it does not consume the request-rate budget.
    try {
      this.eventSource = new EventSource(`https://ntfy.sh/${topic}/sse`);

      this.eventSource.onmessage = (event) => {
        try {
          this.processCloudPayload(JSON.parse(event.data));
        } catch(e) {}
      };

      this.eventSource.onerror = () => {
        this.updateSyncStatus(false, 'stream dropped');
      };
    } catch(e) {}

    // 3. Publish heartbeat every 3s. Poll ONLY when SSE has been silent for 12s.
    //    ntfy.sh free tier rate-limits per IP; the old 1s POST + 1s poll cadence
    //    exceeded it and every failure was swallowed silently.
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
      if (Date.now() - this.lastCloudMessageAt > 12000) {
        this.pollCloudMessages(this.getTopic());
      }
    }, 3000);

    // 4. Send initial heartbeat immediately
    this.sendHeartbeat();
  }

  processCloudPayload(payload) {
    if (!payload) return;
    if (payload.event && payload.event !== 'message') return;

    // Any delivered frame proves the stream is alive.
    this.lastCloudMessageAt = Date.now();
    this.updateSyncStatus(true);

    if (!payload.message) return;

    // Deduplicate: SSE and the poll fallback can both deliver the same message.
    if (payload.id) {
      if (this.seenMsgIds[payload.id]) return;
      this.seenMsgIds[payload.id] = true;
      this.seenMsgCount++;
      if (this.seenMsgCount > 500) {
        this.seenMsgIds = {};
        this.seenMsgCount = 0;
      }
    }

    let data = null;
    try {
      data = JSON.parse(payload.message);
    } catch(e) {
      return;
    }
    this.handleCloudMessage(data);
  }

  sendHeartbeat() {
    if (!this.roomCode || this.isSoloDrill) return;
    const topic = this.getTopic();

    const data = {
      type: 'HEARTBEAT',
      senderId: this.playerId,
      timestamp: Date.now(),
      roundId: this.currentRoundId,
      player: {
        id: this.playerId,
        name: this.playerName,
        role: this.role,
        lat: this.myPosition ? this.myPosition.lat : null,
        lng: this.myPosition ? this.myPosition.lng : null,
        accuracy: this.myPosition ? this.myPosition.accuracy : 25
      },
      headStartSeconds: this.headStartSeconds,
      boundaryRadius: this.boundaryRadius
    };

    try {
      fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
        .then((res) => {
          if (res && res.ok) {
            this.updateSyncStatus(true);
          } else {
            const code = res ? res.status : 0;
            this.updateSyncStatus(false, code === 429 ? 'rate limited by ntfy.sh' : 'HTTP ' + code);
          }
        })
        .catch(() => this.updateSyncStatus(false, 'network unreachable'));
    } catch(e) {
      this.updateSyncStatus(false, 'send failed');
    }
  }

  broadcastCloud(data) {
    if (!this.roomCode || this.isSoloDrill) return;
    data.senderId = this.playerId;
    data.timestamp = Date.now();
    const topic = this.getTopic();

    try {
      fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
        .then((res) => {
          if (res && res.ok) {
            this.updateSyncStatus(true);
          } else {
            const code = res ? res.status : 0;
            this.updateSyncStatus(false, code === 429 ? 'rate limited by ntfy.sh' : 'HTTP ' + code);
          }
        })
        .catch(() => this.updateSyncStatus(false, 'network unreachable'));
    } catch(e) {
      this.updateSyncStatus(false, 'send failed');
    }
  }

  pollCloudMessages(topic) {
    if (!topic) return;
    try {
      fetch(`https://ntfy.sh/${topic}/json?poll=1&since=15s`)
        .then(res => {
          if (!res || !res.ok) {
            const code = res ? res.status : 0;
            this.updateSyncStatus(false, code === 429 ? 'rate limited by ntfy.sh' : 'HTTP ' + code);
            return '';
          }
          return res.text();
        })
        .then(text => {
          if (!text) return;
          const lines = text.trim().split('\n');
          lines.forEach(line => {
            try {
              this.processCloudPayload(JSON.parse(line));
            } catch(e) {}
          });
        })
        .catch(() => this.updateSyncStatus(false, 'network unreachable'));
    } catch(e) {}
  }

  handleCloudMessage(data) {
    if (!data || data.senderId === this.playerId) return;

    // Heartbeats update rosters and positions. They never change game state.
    if (data.type === 'HEARTBEAT' || data.type === 'PLAYER_JOIN' || data.type === 'PLAYER_UPDATE') {
      const p = data.player;
      if (p && p.id) {
        this.players[p.id] = { ...this.players[p.id], ...p, lastSeen: Date.now() };

        if (p.role === 'hider') {
          this.hiderId = p.id;
        }

        if (data.headStartSeconds) this.headStartSeconds = data.headStartSeconds;
        if (data.boundaryRadius) this.boundaryRadius = data.boundaryRadius;

        // Record every player's track, not just our own, so the replay has
        // something to draw for the rest of the field.
        if ((this.gameState === 'headstart' || this.gameState === 'active') && p.lat && p.lng) {
          this.recordTrackPoint(p.id, p.name, p.role, {
            lat: p.lat,
            lng: p.lng,
            accuracy: p.accuracy || 25
          });
        }

        this.updateLobbyList();
      }
      return;
    }

    if (data.type === 'START_HEADSTART') {
      // ROUND IDENTITY GUARD: no cross-device clock comparison. A round is
      // accepted once, by id. Phone clock skew cannot suppress a real start.
      if (!data.roundId) return;
      if (this.seenRoundIds[data.roundId]) return;
      this.seenRoundIds[data.roundId] = true;
      if (this.gameState !== 'lobby') return;

      this.currentRoundId = data.roundId;
      this.gameState = 'headstart';
      this.handleGameStateChange('headstart', data);
      return;
    }

    if (data.type === 'HIDER_READY_EARLY') {
      if (this.gameState !== 'lobby' && this.gameState !== 'headstart') return;
      this.gameState = 'active';
      this.handleGameStateChange('active', data);
      return;
    }

    if (data.type === 'TAG') {
      this.applyTag(data);
      return;
    }

    if (data.type === 'DECOY') {
      if (this.role !== 'seeker') return;
      if (typeof data.lat !== 'number' || typeof data.lng !== 'number') return;
      this.decoyPos = { lat: data.lat, lng: data.lng };
      window.hotspotAudio.speak('Warning! Signal may be spoofed!');
      setTimeout(() => { this.decoyPos = null; }, data.durationMs || 30000);
      return;
    }

    if (data.type === 'SMOKE') {
      if (this.role !== 'seeker') return;
      this.triggerSmokeVisual(true);
      setTimeout(() => this.triggerSmokeVisual(false), data.durationMs || 15000);
      return;
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

  // --- SOLO DRILL MODE ---
  startSoloDrill() {
    this.isSoloDrill = true;
    this.roomCode = 'SOLO';
    this.role = 'seeker';
    this.gameState = 'active';
    this.gameStartTime = Date.now();
    this.taggedHiderIds = {};

    const hiderPos = window.hotspotGeo.startSoloDrill(300);

    this.players = {
      [this.playerId]: { id: this.playerId, name: this.playerName, role: 'seeker' },
      'solo_hider': { id: 'solo_hider', name: 'Virtual Hider', role: 'hider', lat: hiderPos.lat, lng: hiderPos.lng, accuracy: 15 }
    };
    this.hiderId = 'solo_hider';

    window.hotspotAudio.speak('Solo Drill initialized! Virtual hider planted 300 feet out.');

    this.showScreen('seeker-screen');
    
    const soloControls = document.getElementById('solo-controls-card');
    if (soloControls) soloControls.style.display = 'block';

    const counter = document.getElementById('headstart-banner-seeker');
    if (counter) counter.innerText = '🔥 SOLO DRILL LIVE!';

    this.startPulseLoop();
  }

  moveSoloHider(deltaFeet) {
    if (!this.isSoloDrill) return;
    let hiderPos;
    if (deltaFeet < 0) {
      hiderPos = window.hotspotGeo.moveSoloHiderCloser(Math.abs(deltaFeet));
    } else {
      hiderPos = window.hotspotGeo.moveSoloHiderAway(deltaFeet);
    }

    if (this.players['solo_hider']) {
      this.players['solo_hider'].lat = hiderPos.lat;
      this.players['solo_hider'].lng = hiderPos.lng;
    }
    window.hotspotAudio.speak(`Virtual hider moved to ${Math.round(hiderPos.currentDistFeet)} feet`);
  }

  instantTagSoloHider() {
    if (!this.isSoloDrill) return;
    const hiderPos = window.hotspotGeo.setSoloHiderDistance(10);
    if (this.players['solo_hider']) {
      this.players['solo_hider'].lat = hiderPos.lat;
      this.players['solo_hider'].lng = hiderPos.lng;
    }
  }

  // --- MULTIPLAYER ROOM SETUP ---
  createRoom(headStartSec = 60, mode = 'classic', boundaryFeet = 250) {
    this.isSoloDrill = false;
    this.headStartSeconds = parseInt(headStartSec, 10) || 60;
    this.boundaryRadius = parseInt(boundaryFeet, 10) || 250;
    this.gameMode = mode;
    this.roomCode = this.generateRoomCode();
    this.joinTime = Date.now();
    this.currentRoundId = null;
    this.seenRoundIds = {};
    this.taggedHiderIds = {};
    this.role = 'hider';
    this.hiderId = this.playerId;
    this.gameState = 'lobby';

    this.players = {
      [this.playerId]: {
        id: this.playerId,
        name: this.playerName,
        role: 'hider',
        lat: this.myPosition ? this.myPosition.lat : null,
        lng: this.myPosition ? this.myPosition.lng : null
      }
    };

    document.getElementById('lobby-code-display').innerText = this.roomCode;
    this.updateLobbyList();
    this.showScreen('lobby-screen');

    this.initCloudSync();

    window.hotspotAudio.speak(`Hunt created. Code is ${this.roomCode.split('').join(' ')}`);
  }

  generateRoomCode() {
    // 32-char alphabet with no 0/O/1/I ambiguity. 32^6 ≈ 1.07 billion codes,
    // which is what keeps the public ntfy.sh topic from being enumerable.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) {
      out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
  }

  leaveRoom() {
    if (this.eventSource) {
      try { this.eventSource.close(); } catch(e) {}
      this.eventSource = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.headStartTimer) {
      clearInterval(this.headStartTimer);
      this.headStartTimer = null;
    }
    this.stopPulseLoop();

    this.roomCode = null;
    this.currentRoundId = null;
    this.isSoloDrill = false;
    this.gameState = 'lobby';
    this.players = {};
    this.hiderId = null;
    this.decoyPos = null;
    this.taggedHiderIds = {};
    this.seenMsgIds = {};
    this.seenMsgCount = 0;
    this.syncFailCount = 0;
    this.matchTrackHistory = [];
    this.tagEvent = null;
    this.powerups = {
      decoyUsed: false,
      smokeUsed: false,
      bearingPingUsed: false,
      decoyActive: false,
      smokeActive: false,
      bearingActive: false
    };

    const banner = document.getElementById('sync-warning-banner');
    if (banner) banner.style.display = 'none';

    const homeLabel = document.getElementById('cloud-sync-status');
    if (homeLabel) homeLabel.innerText = '🌐 hotspot-app-yardtag.web.app';

    ['btn-powerup-decoy', 'btn-powerup-smoke', 'btn-bearing-ping'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = false;
    });

    const soloControls = document.getElementById('solo-controls-card');
    if (soloControls) soloControls.style.display = 'none';

    const readyBtn = document.getElementById('btn-hider-ready');
    if (readyBtn) readyBtn.style.display = '';

    this.triggerSmokeVisual(false);
  }

  goHome() {
    this.showScreen('home-screen');
    try {
      this.leaveRoom();
    } catch(e) {}
    this.updateSeasonStatsDisplay();
  }

  joinRoom(code, nickname, role = 'seeker') {
    const cleanCode = code ? code.trim() : '';
    if (!cleanCode || (cleanCode.length !== 4 && cleanCode.length !== 6)) {
      alert('Please enter the room code from the host.');
      return;
    }

    this.isSoloDrill = false;
    this.roomCode = code.toUpperCase().trim();
    this.joinTime = Date.now();
    this.currentRoundId = null;
    this.seenRoundIds = {};
    this.taggedHiderIds = {};
    this.playerName = nickname ? nickname.trim() : this.playerName;
    this.role = role;
    this.gameState = 'lobby';

    this.players = {
      [this.playerId]: {
        id: this.playerId,
        name: this.playerName,
        role: this.role,
        lat: this.myPosition ? this.myPosition.lat : null,
        lng: this.myPosition ? this.myPosition.lng : null
      }
    };

    document.getElementById('lobby-code-display').innerText = this.roomCode;
    this.updateLobbyList();
    this.showScreen('lobby-screen');

    this.initCloudSync();

    window.hotspotAudio.speak(`Joined hunt ${this.roomCode.split('').join(' ')}`);
  }

  toggleRole() {
    this.role = this.role === 'hider' ? 'seeker' : 'hider';
    if (this.players[this.playerId]) {
      this.players[this.playerId].role = this.role;
    }

    this.sendHeartbeat();
    this.updateLobbyList();
    window.hotspotAudio.speak(`Switched role to ${this.role.toUpperCase()}`);
  }

  prunePlayers() {
    const now = Date.now();
    Object.keys(this.players).forEach((id) => {
      if (id === this.playerId) return;
      const p = this.players[id];
      if (!p) { delete this.players[id]; return; }
      if (p.id === 'solo_hider') return;
      if (!p.lastSeen || now - p.lastSeen > 15000) delete this.players[id];
    });
    if (this.hiderId && !this.players[this.hiderId]) this.hiderId = null;
  }

  updateLobbyList() {
    this.prunePlayers();
    const now = Date.now();
    // Keep active players seen in last 15s
    const activePlayers = Object.values(this.players).filter(p => !p.lastSeen || now - p.lastSeen <= 15000);

    const hidersList = activePlayers.filter(p => p.role === 'hider');
    const seekersList = activePlayers.filter(p => p.role === 'seeker');

    const hiderContainer = document.getElementById('lobby-hider-list');
    const seekerContainer = document.getElementById('lobby-seeker-list');

    if (hiderContainer) {
      hiderContainer.innerHTML = hidersList.map(p => `
        <div class="player-badge hider">
          <span class="name">👑 ${p.name} ${p.id === this.playerId ? '<b style="color:var(--accent-cyan);">(YOU)</b>' : ''}</span>
        </div>
      `).join('') || '<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:6px;">No Hider Selected</div>';
    }

    if (seekerContainer) {
      seekerContainer.innerHTML = seekersList.map(p => `
        <div class="player-badge seeker">
          <span class="name">🏃 ${p.name} ${p.id === this.playerId ? '<b style="color:var(--accent-cyan);">(YOU)</b>' : ''}</span>
        </div>
      `).join('') || '<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:6px;">No Seekers Joined Yet</div>';
    }
  }

  // --- GAME START & HEADSTART TIMING ENGINE ---
  startHeadstart() {
    const startTime = Date.now();
    this.headStartStartTime = startTime;

    if (this.myPosition) {
      this.yardCenterPos = { lat: this.myPosition.lat, lng: this.myPosition.lng };
    }

    const roundId = 'rnd_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    this.currentRoundId = roundId;
    this.seenRoundIds[roundId] = true;
    this.taggedHiderIds = {};
    this.gameState = 'headstart';

    this.broadcastCloud({
      type: 'START_HEADSTART',
      roundId: roundId,
      headStartStartTime: startTime,
      headStartSeconds: this.headStartSeconds,
      yardCenterPos: this.yardCenterPos
    });

    this.handleGameStateChange('headstart', {
      roundId: roundId,
      headStartStartTime: startTime,
      headStartSeconds: this.headStartSeconds,
      yardCenterPos: this.yardCenterPos
    });
  }

  hiderReadyEarly() {
    if (this.gameState !== 'lobby' && this.gameState !== 'headstart') return;

    window.hotspotAudio.speak('Hider is hidden early! Pack released!');
    if (this.headStartTimer) {
      clearInterval(this.headStartTimer);
      this.headStartTimer = null;
    }

    this.gameState = 'active';
    this.broadcastCloud({ type: 'HIDER_READY_EARLY', roundId: this.currentRoundId });
    this.handleGameStateChange('active');
  }

  handleGameStateChange(newState, roomData = null) {
    if (newState === 'headstart') {
      const startTime = (roomData && roomData.headStartStartTime) ? roomData.headStartStartTime : (this.headStartStartTime || Date.now());
      const duration = (roomData && roomData.headStartSeconds) ? roomData.headStartSeconds : this.headStartSeconds;
      if (roomData && roomData.yardCenterPos) this.yardCenterPos = roomData.yardCenterPos;

      if (this.role === 'hider') {
        this.showScreen('hider-screen');
      } else if (this.role === 'seeker') {
        this.showScreen('seeker-screen');
      } else if (this.role === 'spectator') {
        this.showScreen('spectator-screen');
        window.hotspotReplay.initMap('spectator-map');
      }

      window.hotspotAudio.speak(`Turn the pack loose! Hider gets ${duration} seconds head start!`);

      if (this.headStartTimer) clearInterval(this.headStartTimer);

      this.headStartTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const remaining = Math.max(0, duration - elapsed);
        this.headStartRemaining = remaining;

        document.querySelectorAll('.headstart-counter').forEach(el => {
          el.innerText = `⏳ HEAD START: ${remaining}s`;
        });

        const hiderCounter = document.getElementById('hider-timer-display');
        if (hiderCounter) hiderCounter.innerText = `${remaining}s`;

        if (remaining <= 5 && remaining > 0) {
          window.hotspotAudio.playCountdownBeep(false);
        }

        if (remaining === 30 || remaining === 15) {
          window.hotspotAudio.speak(`${remaining} seconds remaining!`);
        }

        if (remaining <= 0) {
          clearInterval(this.headStartTimer);
          this.headStartTimer = null;

          document.querySelectorAll('.headstart-counter').forEach(el => {
            el.innerText = '🔥 HUNT IS LIVE!';
          });
          if (hiderCounter) hiderCounter.innerText = 'LIVE!';

          window.hotspotAudio.playCountdownBeep(true);
          window.hotspotAudio.speak('PACK RELEASED! HUNT IS LIVE!');

          if (this.role === 'hider') {
            this.broadcastCloud({ type: 'HIDER_READY_EARLY' });
          }
          this.handleGameStateChange('active');
        }
      }, 1000);

    } else if (newState === 'active') {
      this.gameStartTime = Date.now();
      if (this.headStartTimer) clearInterval(this.headStartTimer);

      document.querySelectorAll('.headstart-counter').forEach(el => el.innerText = '🔥 HUNT IS LIVE!');
      const hiderCounter = document.getElementById('hider-timer-display');
      if (hiderCounter) hiderCounter.innerText = 'LIVE!';

      const readyBtn = document.getElementById('btn-hider-ready');
      if (readyBtn) readyBtn.style.display = 'none';

      if (this.role === 'hider') {
        if ('vibrate' in navigator) {
          try {
            navigator.vibrate([300, 150, 300, 150, 300]);
          } catch (e) {}
        }

        const hiderScreen = document.getElementById('hider-screen');
        if (hiderScreen) {
          hiderScreen.classList.add('flash-screen');
          setTimeout(() => hiderScreen.classList.remove('flash-screen'), 1500);
        }
      }

      this.startPulseLoop();
    } else if (newState === 'gameover') {
      this.stopPulseLoop();
      if (this.headStartTimer) clearInterval(this.headStartTimer);
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

    if (!this.yardCenterPos && this.role === 'hider') {
      this.yardCenterPos = { lat: pos.lat, lng: pos.lng };
    }

    document.querySelectorAll('.accuracy-tag').forEach(el => {
      el.innerText = `🎯 GPS: ±${Math.round(pos.accuracy)}ft`;
    });

    const warnBox = document.getElementById('gps-warning-banner');
    if (warnBox) {
      if (pos.isProtocolWarning) {
        warnBox.innerText = '⚠️ Opened as local file — GPS requires HTTPS web server.';
        warnBox.style.display = 'block';
      } else if (pos.accuracy > 50) {
        warnBox.innerText = `⚠️ Weak GPS Fix (±${Math.round(pos.accuracy)}ft) — Move out from under heavy tree canopy!`;
        warnBox.style.display = 'block';
      } else {
        warnBox.style.display = 'none';
      }
    }

    if (this.players[this.playerId]) {
      this.players[this.playerId].lat = pos.lat;
      this.players[this.playerId].lng = pos.lng;
      this.players[this.playerId].accuracy = pos.accuracy;
    }

    this.recordTrackPoint(this.playerId, this.playerName, this.role, pos);
  }

  onGpsError(errMessage) {
    const warnBox = document.getElementById('gps-warning-banner');
    if (warnBox) {
      warnBox.innerText = `📍 Tap to Allow GPS Access: ${errMessage}`;
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

  startPulseLoop() {
    if (this.pulseInterval) clearInterval(this.pulseInterval);

    this.pulseInterval = setInterval(() => {
      if (this.gameState !== 'active') return;
      if (!this.isSoloDrill) this.prunePlayers();
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

    if (this.role === 'seeker') {
      let hiderPos = null;

      if (this.isSoloDrill) {
        hiderPos = window.hotspotGeo.soloHiderPosition;
      } else {
        const hiderPlayer = Object.values(this.players).find(p => p.role === 'hider');
        if (hiderPlayer && hiderPlayer.lat) {
          hiderPos = { lat: hiderPlayer.lat, lng: hiderPlayer.lng };
        }
      }

      if (this.decoyPos) {
        hiderPos = this.decoyPos;
      }

      if (!hiderPos) return;

      const bufferedHiderPos = window.hotspotGeo.getBufferedPosition(this.myPosition, hiderPos);

      const distFeet = window.hotspotGeo.calculateDistance(
        this.myPosition.lat, this.myPosition.lng,
        bufferedHiderPos.lat, bufferedHiderPos.lng
      );

      this.currentDistance = distFeet;

      const bandInfo = window.hotspotGeo.getDistanceBand(distFeet);
      this.currentBand = bandInfo.band;

      const pulseRing = document.getElementById('seeker-pulse-ring');
      const bandLabel = document.getElementById('seeker-band-label');

      if (bandLabel && !this.powerups.smokeActive) bandLabel.innerText = bandInfo.label;

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
          // Subtract the phone's compass heading so the arrow points where the
          // player is actually facing, not at true north.
          const heading = window.hotspotGeo.deviceHeading;
          const shown = (typeof heading === 'number') ? (bearing - heading + 360) % 360 : bearing;
          arrow.style.display = 'block';
          arrow.style.transform = `rotate(${shown}deg)`;
        }
      }

      // Auto-tag within 25 feet. Latched per target so infection mode cannot
      // re-fire the tag every 250ms while the seeker stays in range.
      if (distFeet <= 25 && this.gameState === 'active' && !this.decoyPos) {
        const hiderPlayer = Object.values(this.players).find(p => p.role === 'hider');
        const targetId = hiderPlayer ? hiderPlayer.id : (this.isSoloDrill ? 'solo_hider' : null);
        if (targetId && !this.taggedHiderIds[targetId]) {
          this.taggedHiderIds[targetId] = Date.now();
          this.triggerTag(this.playerId, this.playerName, targetId);
        }
      }
    }

    if (this.role === 'hider') {
      const distEl = document.getElementById('hider-nearest-dist');
      const seekerPlayers = Object.values(this.players).filter(p => p.role === 'seeker' && p.lat && p.lng);

      if (seekerPlayers.length > 0) {
        const distances = seekerPlayers.map(s => {
          return window.hotspotGeo.calculateDistance(
            this.myPosition.lat, this.myPosition.lng,
            s.lat, s.lng
          );
        });

        const closestDistFeet = Math.min(...distances);
        if (distEl) {
          if (closestDistFeet > 300) {
            distEl.innerText = `${Math.round(closestDistFeet / 3)}yd`;
          } else {
            distEl.innerText = `${Math.round(closestDistFeet)}ft`;
          }
        }
      } else {
        if (distEl) distEl.innerText = '--ft';
      }

      const boundaryBanner = document.getElementById('hider-boundary-alert');
      if (this.yardCenterPos && this.boundaryRadius > 0 && boundaryBanner) {
        const distFromCenterFeet = window.hotspotGeo.calculateDistance(
          this.myPosition.lat, this.myPosition.lng,
          this.yardCenterPos.lat, this.yardCenterPos.lng
        );

        if (distFromCenterFeet > this.boundaryRadius) {
          boundaryBanner.style.display = 'block';
          boundaryBanner.style.background = '#EF4444';
          boundaryBanner.innerText = `🛑 OUT OF BOUNDS! Move back inside yard! (${Math.round(distFromCenterFeet)}ft from start)`;
        } else if (distFromCenterFeet > 0.8 * this.boundaryRadius) {
          boundaryBanner.style.display = 'block';
          boundaryBanner.style.background = '#F59E0B';
          boundaryBanner.innerText = `⚠️ APPROACHING YARD EDGE! (${Math.round(distFromCenterFeet)}ft / ${this.boundaryRadius}ft limit)`;
        } else {
          boundaryBanner.style.display = 'none';
        }
      }
    }

    if (this.role === 'spectator') {
      window.hotspotReplay.updateSpectatorView(this.players);
    }
  }

  usePowerup(type) {
    if (type === 'decoy' && !this.powerups.decoyUsed) {
      if (!this.myPosition) return;
      this.powerups.decoyUsed = true;
      const btn = document.getElementById('btn-powerup-decoy');
      if (btn) btn.disabled = true;

      window.hotspotAudio.playPowerupSound('decoy');
      window.hotspotAudio.speak('Decoy deployed! Fake hot signal active for 30 seconds!');

      // The decoy has to reach the SEEKERS. Setting it locally on the hider's
      // own device did nothing, because the hider never runs seeker logic.
      const bearing = Math.floor(Math.random() * 360);
      const fake = window.hotspotGeo.offsetPosition(
        this.myPosition.lat, this.myPosition.lng, 250, bearing
      );

      this.broadcastCloud({
        type: 'DECOY',
        lat: fake.lat,
        lng: fake.lng,
        durationMs: 30000
      });

    } else if (type === 'smoke' && !this.powerups.smokeUsed) {
      this.powerups.smokeUsed = true;
      const btn = document.getElementById('btn-powerup-smoke');
      if (btn) btn.disabled = true;

      window.hotspotAudio.playPowerupSound('smoke');
      window.hotspotAudio.speak('Smoke screen thrown! Seekers blinded for 15 seconds!');

      // Blur the SEEKERS' radar, not the hider's own screen.
      this.broadcastCloud({ type: 'SMOKE', durationMs: 15000 });

    } else if (type === 'bearing' && !this.powerups.bearingPingUsed) {
      this.powerups.bearingPingUsed = true;
      this.powerups.bearingActive = true;
      const btn = document.getElementById('btn-bearing-ping');
      if (btn) btn.disabled = true;

      // iOS requires a user gesture to grant compass access; this tap is it.
      window.hotspotGeo.requestCompassPermission();

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

    const hiderName = this.players[hiderId] ? this.players[hiderId].name : 'Hider';

    const tag = {
      type: 'TAG',
      roundId: this.currentRoundId,
      seekerId,
      seekerName,
      hiderId,
      hiderName,
      lat: this.myPosition ? this.myPosition.lat : 0,
      lng: this.myPosition ? this.myPosition.lng : 0,
      timestamp: Date.now()
    };

    // A tag has to reach the hider and every other seeker. Previously it only
    // ever ran on the one device that made the catch.
    this.broadcastCloud({ ...tag });
    this.applyTag(tag);
  }

  applyTag(tag) {
    if (!tag) return;
    if (this.gameState === 'gameover') return;
    if (tag.roundId && this.currentRoundId && tag.roundId !== this.currentRoundId) return;
    if (this.taggedHiderIds[tag.hiderId] && tag.seekerId !== this.playerId) {
      // Already processed this target locally.
      if (this.tagEvent && this.tagEvent.hiderId === tag.hiderId) return;
    }

    this.taggedHiderIds[tag.hiderId] = Date.now();

    this.tagEvent = {
      seekerId: tag.seekerId,
      seekerName: tag.seekerName,
      hiderId: tag.hiderId,
      hiderName: tag.hiderName,
      lat: tag.lat,
      lng: tag.lng,
      timestamp: tag.timestamp || Date.now()
    };

    const iWasTagged = (tag.hiderId === this.playerId);

    if (iWasTagged && 'vibrate' in navigator) {
      try { navigator.vibrate([400, 150, 400, 150, 400]); } catch(e) {}
    }

    if (this.gameMode === 'infection') {
      // Pack grows: the tagged hider flips to seeker. Flip the role BEFORE
      // speaking so the newly-converted player is no longer audio-muted.
      if (this.players[tag.hiderId]) this.players[tag.hiderId].role = 'seeker';
      if (iWasTagged) {
        this.role = 'seeker';
        this.powerups.bearingPingUsed = false;
        const bp = document.getElementById('btn-bearing-ping');
        if (bp) bp.disabled = false;
        this.showScreen('seeker-screen');
        this.sendHeartbeat();
      }

      window.hotspotAudio.playTagScream();
      window.hotspotAudio.speak(`TAGGED! ${tag.seekerName} caught ${tag.hiderName}!`);

      const stillHiding = Object.values(this.players).filter(p => p.role === 'hider');
      if (stillHiding.length === 0) {
        this.gameState = 'gameover';
        this.saveSeasonStats(Date.now() - this.gameStartTime);
        this.handleGameStateChange('gameover');
      } else {
        window.hotspotAudio.speak(`${stillHiding.length} still hiding!`);
      }
      return;
    }

    if (iWasTagged) this.role = 'seeker'; // unmute the caught hider for the callout
    window.hotspotAudio.playTagScream();
    window.hotspotAudio.speak(`TREED AND TAGGED! ${tag.seekerName} caught ${tag.hiderName}!`);

    this.gameState = 'gameover';
    this.saveSeasonStats(Date.now() - this.gameStartTime);
    this.handleGameStateChange('gameover');
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
      const stats = JSON.parse(localStorage.getItem('hotspot_stats') || '{"totalHunts":0,"fastestTagSec":9999,"longestHideSec":0}');
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
