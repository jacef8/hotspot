/**
 * HOTSPOT - Main Game Engine & Controller
 * Standard US Customary Units (Feet & Yards).
 * 100% Bulletproof HTTPS EventSource & HTTP Polling Cloud Sync (Port 443).
 */

window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;

class HotspotApp {
  constructor() {
    this.db = null;
    this.eventSource = null;
    this.pollInterval = null;

    this.roomCode = null;
    this.sessionId = null;
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

    this.startGpsTracking(); // Immediate GPS start
  }

  requestGpsPermissionDirectly() {
    window.hotspotGeo.startTracking(
      (pos) => this.onGpsUpdate(pos),
      (err) => this.onGpsError(err)
    );
  }

  // --- BULLETPROOF HTTPS CLOUD SYNC (PORT 443 - EVENTSOURCE & HTTP POLL) ---
  initCloudSync() {
    if (!this.roomCode) return;
    const topic = 'hotspot_room_' + this.roomCode.toLowerCase();

    // 1. Close existing EventSource & Poller
    if (this.eventSource) {
      try { this.eventSource.close(); } catch(e) {}
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    // 2. Open HTTPS Server-Sent Events (SSE) over standard port 443
    try {
      this.eventSource = new EventSource(`https://ntfy.sh/${topic}/sse`);

      this.eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload && payload.message) {
            const data = JSON.parse(payload.message);
            this.handleCloudMessage(data);
          }
        } catch(e) {}
      };

      this.eventSource.onerror = () => {
        console.warn('SSE warning, HTTP polling fallback active.');
      };
    } catch(e) {
      console.warn('EventSource init warning:', e);
    }

    // 3. Fallback HTTP Polling every 2 seconds over standard HTTPS
    this.pollInterval = setInterval(() => {
      this.pollCloudMessages(topic);
    }, 2000);

    // 4. Announce presence immediately
    this.broadcastPresence();
  }

  broadcastPresence() {
    this.broadcastCloud({
      type: 'PLAYER_JOIN',
      senderId: this.playerId,
      sessionId: this.sessionId,
      player: {
        id: this.playerId,
        name: this.playerName,
        role: this.role,
        lat: this.myPosition ? this.myPosition.lat : null,
        lng: this.myPosition ? this.myPosition.lng : null,
        accuracy: this.myPosition ? this.myPosition.accuracy : 25
      }
    });
  }

  broadcastCloud(data) {
    if (!this.roomCode) return;
    data.senderId = this.playerId;
    data.sessionId = this.sessionId;
    const topic = 'hotspot_room_' + this.roomCode.toLowerCase();

    try {
      fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).catch(() => {});
    } catch(e) {}
  }

  pollCloudMessages(topic) {
    try {
      fetch(`https://ntfy.sh/${topic}/json?poll=1&since=10s`)
        .then(res => res.text())
        .then(text => {
          if (!text) return;
          const lines = text.trim().split('\n');
          lines.forEach(line => {
            try {
              const payload = JSON.parse(line);
              if (payload && payload.message) {
                const data = JSON.parse(payload.message);
                this.handleCloudMessage(data);
              }
            } catch(e) {}
          });
        })
        .catch(() => {});
    } catch(e) {}
  }

  handleCloudMessage(data) {
    if (!data || data.senderId === this.playerId) return;

    // Reject messages from different room sessions
    if (data.sessionId && this.sessionId && data.sessionId !== this.sessionId && this.role === 'seeker') {
      this.sessionId = data.sessionId;
      this.players = { [this.playerId]: this.players[this.playerId] };
    }

    if (data.type === 'PLAYER_JOIN' || data.type === 'PLAYER_UPDATE') {
      const p = data.player;
      if (p && p.id) {
        this.players[p.id] = { ...this.players[p.id], ...p };
        this.updateLobbyList();

        // If I am Host (Hider), send room snapshot back to new player
        if (this.role === 'hider') {
          this.broadcastCloud({
            type: 'ROOM_SNAPSHOT',
            players: this.players,
            hiderId: this.hiderId,
            gameState: this.gameState,
            headStartSeconds: this.headStartSeconds,
            boundaryRadius: this.boundaryRadius,
            gameMode: this.gameMode
          });
        }
      }
    } else if (data.type === 'ROOM_SNAPSHOT') {
      // Active Round Guard: If game is already live and Seeker was not in lobby, inform Seeker
      if ((data.gameState === 'active' || data.gameState === 'headstart') && this.gameState === 'lobby') {
        alert('⚠️ That round is already underway — ask the host for a new room code!');
        this.showScreen('join-screen');
        return;
      }

      this.players = { ...this.players, ...data.players };
      if (data.hiderId) this.hiderId = data.hiderId;
      this.updateLobbyList();

    } else if (data.type === 'START_HEADSTART') {
      if (this.gameState === 'lobby') {
        this.gameState = 'headstart';
        this.handleGameStateChange('headstart', data);
      }
    } else if (data.type === 'HIDER_READY_EARLY') {
      this.gameState = 'active';
      this.handleGameStateChange('active', data);
    } else if (data.type === 'POS_UPDATE') {
      if (data.playerId && this.players[data.playerId]) {
        this.players[data.playerId].lat = data.lat;
        this.players[data.playerId].lng = data.lng;
        this.players[data.playerId].accuracy = data.accuracy;
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

  // --- SOLO DRILL MODE ---
  startSoloDrill() {
    this.isSoloDrill = true;
    this.roomCode = 'SOLO';
    this.role = 'seeker';
    this.gameState = 'active';

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
    this.roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.sessionId = 'sess_' + Date.now(); // Fresh room session wipe
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

  joinRoom(code, nickname, role = 'seeker') {
    if (!code || !code.trim()) {
      alert('Please enter a 4-letter room code.');
      return;
    }

    this.isSoloDrill = false;
    this.roomCode = code.toUpperCase().trim();
    this.sessionId = null; // Will adopt Host's session ID on snapshot
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

    this.broadcastCloud({
      type: 'PLAYER_UPDATE',
      player: { id: this.playerId, name: this.playerName, role: this.role }
    });

    this.updateLobbyList();
    window.hotspotAudio.speak(`Switched role to ${this.role.toUpperCase()}`);
  }

  updateLobbyList() {
    const hidersList = Object.values(this.players).filter(p => p.role === 'hider');
    const seekersList = Object.values(this.players).filter(p => p.role === 'seeker');

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

    this.broadcastCloud({
      type: 'START_HEADSTART',
      headStartStartTime: startTime,
      headStartSeconds: this.headStartSeconds,
      yardCenterPos: this.yardCenterPos
    });

    this.handleGameStateChange('headstart', {
      headStartStartTime: startTime,
      headStartSeconds: this.headStartSeconds,
      yardCenterPos: this.yardCenterPos
    });
  }

  hiderReadyEarly() {
    window.hotspotAudio.speak('Hider is hidden early! Pack released!');
    if (this.headStartTimer) {
      clearInterval(this.headStartTimer);
      this.headStartTimer = null;
    }

    this.broadcastCloud({ type: 'HIDER_READY_EARLY' });
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

    this.broadcastCloud({
      type: 'POS_UPDATE',
      playerId: this.playerId,
      lat: pos.lat,
      lng: pos.lng,
      accuracy: pos.accuracy
    });

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

      // Auto-tag within 25 feet
      if (distFeet <= 25 && this.gameState === 'active') {
        const hiderPlayer = Object.values(this.players).find(p => p.role === 'hider');
        this.triggerTag(this.playerId, this.playerName, hiderPlayer ? hiderPlayer.id : 'hider');
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
      this.powerups.decoyUsed = true;
      const btn = document.getElementById('btn-powerup-decoy');
      if (btn) btn.disabled = true;

      window.hotspotAudio.playPowerupSound('decoy');
      window.hotspotAudio.speak('Decoy deployed! Fake hot signal active for 30 seconds!');

      if (this.myPosition) {
        const decoy = window.hotspotGeo.startSoloDrill(250);
        this.decoyPos = decoy;
      }

      setTimeout(() => {
        this.decoyPos = null;
      }, 30000);

    } else if (type === 'smoke' && !this.powerups.smokeUsed) {
      this.powerups.smokeUsed = true;
      const btn = document.getElementById('btn-powerup-smoke');
      if (btn) btn.disabled = true;

      window.hotspotAudio.playPowerupSound('smoke');
      window.hotspotAudio.speak('Smoke screen thrown! Seekers blinded for 15 seconds!');

      this.triggerSmokeVisual(true);

      setTimeout(() => {
        this.triggerSmokeVisual(false);
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
    } else {
      this.gameState = 'gameover';
      this.handleGameStateChange('gameover');
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
