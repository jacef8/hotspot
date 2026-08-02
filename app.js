/**
 * HOTSPOT - Main Game Engine & Controller
 * Standard US Customary Units (Feet & Yards).
 * PeerJS WebRTC Cloud Sync & Android GPS Permission Engine.
 */

window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;

class HotspotApp {
  constructor() {
    this.db = null;
    this.peer = null;
    this.peerConns = [];
    this.hostConn = null;

    this.roomCode = null;
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

    this.initFirebase();
    this.startGpsTracking(); // Immediate GPS start
  }

  requestGpsPermissionDirectly() {
    window.hotspotGeo.startTracking(
      (pos) => this.onGpsUpdate(pos),
      (err) => this.onGpsError(err)
    );
  }

  initFirebase() {
    if (window.FIREBASE_CONFIG && typeof firebase !== 'undefined' && firebase.apps) {
      try {
        if (!firebase.apps.length) {
          firebase.initializeApp(window.FIREBASE_CONFIG);
        }
        this.db = firebase.database();
      } catch (e) {}
    }
  }

  // --- PEERJS WEBRTC REAL-TIME SYNC ---
  initHostPeer() {
    if (typeof Peer === 'undefined') return;
    try {
      if (this.peer) this.peer.destroy();
      const peerId = 'hotspot_' + this.roomCode;
      this.peer = new Peer(peerId);

      this.peer.on('open', () => {
        console.log('Host Peer open:', peerId);
      });

      this.peer.on('connection', (conn) => {
        this.peerConns.push(conn);

        conn.on('data', (data) => {
          this.handlePeerData(data, conn);
        });

        conn.on('close', () => {
          this.peerConns = this.peerConns.filter(c => c !== conn);
        });

        conn.send({
          type: 'ROOM_SNAPSHOT',
          players: this.players,
          hiderId: this.hiderId,
          gameState: this.gameState,
          headStartSeconds: this.headStartSeconds,
          boundaryRadius: this.boundaryRadius,
          gameMode: this.gameMode
        });
      });
    } catch(e) {
      console.warn('PeerJS Host init warning:', e);
    }
  }

  initClientPeer() {
    if (typeof Peer === 'undefined') return;
    try {
      if (this.peer) this.peer.destroy();
      this.peer = new Peer();

      this.peer.on('open', () => {
        const hostPeerId = 'hotspot_' + this.roomCode;
        this.hostConn = this.peer.connect(hostPeerId);

        this.hostConn.on('open', () => {
          this.hostConn.send({
            type: 'JOIN_PLAYER',
            player: {
              id: this.playerId,
              name: this.playerName,
              role: this.role,
              lat: this.myPosition ? this.myPosition.lat : null,
              lng: this.myPosition ? this.myPosition.lng : null
            }
          });
        });

        this.hostConn.on('data', (data) => {
          this.handlePeerData(data, this.hostConn);
        });
      });
    } catch(e) {
      console.warn('PeerJS Client init warning:', e);
    }
  }

  handlePeerData(data, conn) {
    if (!data) return;

    if (data.type === 'JOIN_PLAYER' || data.type === 'UPDATE_PLAYER') {
      const p = data.player;
      this.players[p.id] = { ...this.players[p.id], ...p };
      this.updateLobbyList();
      
      if (this.role === 'hider' && this.peerConns.length > 0) {
        this.broadcastToAllPeers({ type: 'ROOM_SNAPSHOT', players: this.players, gameState: this.gameState });
      }
    } else if (data.type === 'ROOM_SNAPSHOT') {
      this.players = data.players || this.players;
      if (data.hiderId) this.hiderId = data.hiderId;
      if (data.gameState && data.gameState !== this.gameState) {
        this.gameState = data.gameState;
        this.handleGameStateChange(this.gameState, data);
      }
      this.updateLobbyList();
    } else if (data.type === 'GAME_STATE') {
      if (data.gameState !== this.gameState) {
        this.gameState = data.gameState;
        this.handleGameStateChange(this.gameState, data);
      }
    }
  }

  broadcastToAllPeers(data) {
    if (this.hostConn && this.hostConn.open) {
      try { this.hostConn.send(data); } catch(e) {}
    }
    this.peerConns.forEach(conn => {
      if (conn && conn.open) {
        try { conn.send(data); } catch(e) {}
      }
    });
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

    this.initHostPeer();

    window.hotspotAudio.speak(`Hunt created. Code is ${this.roomCode.split('').join(' ')}`);

    if (this.db) {
      try {
        this.db.ref('rooms/' + this.roomCode).set({
          code: this.roomCode,
          hostId: this.playerId,
          hiderId: this.hiderId,
          gameState: 'lobby',
          headStartSeconds: this.headStartSeconds,
          boundaryRadius: this.boundaryRadius,
          gameMode: this.gameMode,
          players: this.players,
          createdAt: Date.now()
        });

        this.listenToRoom();
      } catch (e) {}
    }
  }

  joinRoom(code, nickname, role = 'seeker') {
    if (!code || !code.trim()) {
      alert('Please enter a 4-letter room code.');
      return;
    }

    this.isSoloDrill = false;
    this.roomCode = code.toUpperCase().trim();
    this.playerName = nickname ? nickname.trim() : this.playerName;
    this.role = role;
    this.gameState = 'lobby';

    this.players[this.playerId] = {
      id: this.playerId,
      name: this.playerName,
      role: this.role,
      lat: this.myPosition ? this.myPosition.lat : null,
      lng: this.myPosition ? this.myPosition.lng : null
    };

    document.getElementById('lobby-code-display').innerText = this.roomCode;
    this.updateLobbyList();
    this.showScreen('lobby-screen');

    this.initClientPeer();

    window.hotspotAudio.speak(`Joined hunt ${this.roomCode.split('').join(' ')}`);

    if (this.db) {
      try {
        const roomRef = this.db.ref('rooms/' + this.roomCode);

        roomRef.once('value', snapshot => {
          if (snapshot.exists()) {
            const data = snapshot.val();
            this.hiderId = data.hiderId || this.hiderId;
            this.gameMode = data.gameMode || 'classic';
            this.headStartSeconds = data.headStartSeconds || 60;
            this.boundaryRadius = data.boundaryRadius || 250;
          }

          roomRef.child('players/' + this.playerId).set({
            id: this.playerId,
            name: this.playerName,
            role: this.role,
            lat: this.myPosition ? this.myPosition.lat : null,
            lng: this.myPosition ? this.myPosition.lng : null
          });

          this.listenToRoom();
        }, (err) => {});
      } catch (e) {}
    }
  }

  toggleRole() {
    this.role = this.role === 'hider' ? 'seeker' : 'hider';
    if (this.players[this.playerId]) {
      this.players[this.playerId].role = this.role;
    }

    this.broadcastToAllPeers({
      type: 'UPDATE_PLAYER',
      player: { id: this.playerId, name: this.playerName, role: this.role }
    });

    if (this.db && this.roomCode) {
      try {
        this.db.ref(`rooms/${this.roomCode}/players/${this.playerId}`).update({ role: this.role });
        if (this.role === 'hider') {
          this.db.ref(`rooms/${this.roomCode}`).update({ hiderId: this.playerId });
        }
      } catch (e) {}
    }
    this.updateLobbyList();
    window.hotspotAudio.speak(`Switched role to ${this.role.toUpperCase()}`);
  }

  listenToRoom() {
    if (!this.db || !this.roomCode) return;

    try {
      const roomRef = this.db.ref('rooms/' + this.roomCode);

      roomRef.on('value', snapshot => {
        if (!snapshot.exists()) return;
        const data = snapshot.val();

        this.players = data.players || {};
        this.hiderId = data.hiderId;
        this.gameMode = data.gameMode || 'classic';
        this.headStartSeconds = data.headStartSeconds || 60;
        this.boundaryRadius = data.boundaryRadius || 250;
        this.updateLobbyList();

        if (data.gameState !== this.gameState) {
          this.gameState = data.gameState;
          this.handleGameStateChange(this.gameState, data);
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
    } catch (e) {}
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

    this.broadcastToAllPeers({
      type: 'GAME_STATE',
      gameState: 'headstart',
      headStartStartTime: startTime,
      headStartSeconds: this.headStartSeconds
    });

    if (this.db) {
      try {
        this.db.ref(`rooms/${this.roomCode}`).update({
          gameState: 'headstart',
          headStartStartTime: startTime,
          headStartSeconds: this.headStartSeconds,
          yardCenterPos: this.yardCenterPos
        });
      } catch (e) {}
    }

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

    this.broadcastToAllPeers({ type: 'GAME_STATE', gameState: 'active' });

    if (this.db) {
      try { this.db.ref(`rooms/${this.roomCode}`).update({ gameState: 'active' }); } catch (e) {}
    }
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
            this.broadcastToAllPeers({ type: 'GAME_STATE', gameState: 'active' });
            if (this.db) {
              try { this.db.ref(`rooms/${this.roomCode}`).update({ gameState: 'active' }); } catch (e) {}
            }
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

    this.broadcastToAllPeers({
      type: 'UPDATE_PLAYER',
      player: { id: this.playerId, name: this.playerName, role: this.role, lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy }
    });

    if (this.db && this.roomCode) {
      try {
        this.db.ref(`rooms/${this.roomCode}/players/${this.playerId}`).update({
          lat: pos.lat,
          lng: pos.lng,
          accuracy: pos.accuracy,
          timestamp: Date.now()
        });
      } catch (e) {}
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
        this.triggerTag(this.playerId, this.playerName, this.hiderId);
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
        if (this.db) {
          try { this.db.ref(`rooms/${this.roomCode}/powerups`).update({ decoyPos: decoy }); } catch (e) {}
        }
      }

      setTimeout(() => {
        this.decoyPos = null;
        if (this.db) {
          try { this.db.ref(`rooms/${this.roomCode}/powerups/decoyPos`).remove(); } catch (e) {}
        }
      }, 30000);

    } else if (type === 'smoke' && !this.powerups.smokeUsed) {
      this.powerups.smokeUsed = true;
      const btn = document.getElementById('btn-powerup-smoke');
      if (btn) btn.disabled = true;

      window.hotspotAudio.playPowerupSound('smoke');
      window.hotspotAudio.speak('Smoke screen thrown! Seekers blinded for 15 seconds!');

      if (this.db) {
        try { this.db.ref(`rooms/${this.roomCode}/powerups`).update({ smokeActive: true }); } catch (e) {}
      } else {
        this.triggerSmokeVisual(true);
      }

      setTimeout(() => {
        if (this.db) {
          try { this.db.ref(`rooms/${this.roomCode}/powerups`).update({ smokeActive: false }); } catch (e) {}
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
        try { this.db.ref(`rooms/${this.roomCode}/players/${hiderId}`).update({ role: 'seeker' }); } catch (e) {}
      }
    } else {
      this.gameState = 'gameover';
      if (this.db) {
        try {
          this.db.ref(`rooms/${this.roomCode}`).update({
            gameState: 'gameover',
            tagEvent: this.tagEvent
          });
        } catch (e) {}
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
