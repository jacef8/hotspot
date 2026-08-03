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
    this.appliedTagByRound = {};
    this.lastCloudMessageAt = 0;
    this.syncFailCount = 0;
    // Whoever created the room owns the well-known peer id for it. Deliberately
    // NOT tied to hider/seeker, so role swaps and rematches cannot break the mesh.
    this.isRoomHost = false;
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

    this.matchDurationSeconds = 300;
    this.matchTimer = null;

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

  // Clear only this app's transient room state. The old version wiped ALL of
  // localStorage on every boot and restored one key, which would silently eat
  // any setting added later.
  clearStaleCache() {
    try {
      sessionStorage.clear();
      ['hotspot_room', 'hotspot_session', 'hotspot_players', 'hotspot_state']
        .forEach(k => localStorage.removeItem(k));
    } catch(e) {}
  }

  getTopic() {
    if (!this.roomCode) return null;
    return 'hotspot_r243_' + this.roomCode.toLowerCase();
  }

  updateSyncStatus(ok, note) {
    if (ok) this.syncFailCount = 0;
    else this.syncFailCount++;
    if (note) this.lastSyncNote = note;
    this.refreshTransportStatus();
  }

  // Report what is actually true about each transport. The old version showed a
  // single "cloud sync" verdict, so a dead relay looked identical to a dead
  // room even when the P2P mesh was carrying everything perfectly well.
  refreshTransportStatus() {
    const banner = document.getElementById('sync-warning-banner');
    const homeLabel = document.getElementById('cloud-sync-status');
    if (!this.roomCode) {
      if (banner) banner.style.display = 'none';
      return;
    }

    const peers = this.peerCount();
    const relayOk = this.rtdbConnected || this.syncFailCount < 8;

    let text;
    if (peers > 0) {
      text = `🟢 Connected — ${peers} direct link${peers === 1 ? '' : 's'}${this.rtdbConnected ? ' + cloud' : ''} · room ${this.roomCode}`
        + (relayOk ? '' : ' (relay unavailable, not needed)');
    } else if (relayOk) {
      text = this.rtdbConnected
        ? `🟢 Cloud sync active · room ${this.roomCode}`
        : `🟡 Looking for other devices… · room ${this.roomCode}`;
    } else {
      text = `🔴 No connection to other devices · room ${this.roomCode}`;
    }
    if (homeLabel) homeLabel.innerText = text;

    // Only alarm when BOTH transports are down — a blocked relay alone is fine.
    if (banner) {
      if (peers === 0 && !relayOk) {
        banner.innerText = '⚠️ Cannot reach other devices'
          + (this.lastSyncNote ? ' (' + this.lastSyncNote + ')' : '')
          + ' — check that both phones are on the internet.';
        banner.style.display = 'block';
      } else {
        banner.style.display = 'none';
      }
    }
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
        // SSE auto-reconnects natively. Only flag sync status if connection closes completely.
        if (this.eventSource && this.eventSource.readyState === EventSource.CLOSED) {
          this.updateSyncStatus(false, 'stream disconnected');
        }
      };
    } catch(e) {}

    // 3. Publish heartbeat every 3s. Poll ONLY when SSE has been silent for 12s.
    //    ntfy.sh free tier rate-limits per IP; the old 1s POST + 1s poll cadence
    //    exceeded it and every failure was swallowed silently.
    this.heartbeatInterval = setInterval(() => {
      // Keep hammering on the host until the P2P mesh is up. This is the path
      // that works when the relay is blocked or down.
      if (!this.isRoomHost) this.ensureHostConnection();

      this.sendHeartbeat();
      if (Date.now() - this.lastCloudMessageAt > 12000) {
        this.pollCloudMessages(this.getTopic());
      }
      this.refreshTransportStatus();
    }, 3000);

    // 4. Initialize WebRTC Direct P2P Sync (Zero Server Rate Limits)
    this.initPeerSync();

    // 5. Firebase Realtime Database relay — the path that keeps working when
    //    WebRTC cannot form a link or a phone changes network mid-game.
    this.initRtdbSync();

    // 5. Send initial heartbeat immediately
    this.sendHeartbeat();
  }

  initPeerSync() {
    if (!this.roomCode || typeof Peer === 'undefined') return;

    try {
      if (this.peer) {
        try { this.peer.destroy(); } catch(e) {}
        this.peer = null;
      }

      this.peerConnections = {};

      // Discovery MUST NOT depend on the ntfy relay. v2.5.10 made the relay the
      // only way to learn the host's peer id, so when ntfy was unreachable no
      // device ever found the room at all. The room creator claims a well-known
      // id derived from the room code; everyone else dials it directly.
      //
      // The id is tied to who created the room, NOT to hider/seeker, so role
      // swaps and rematches cannot invalidate it. The 60-120s ghost-id problem
      // that made us abandon this in v2.5.0 is handled two ways now: leaveRoom
      // destroys the peer (releasing the id immediately), and an unavailable-id
      // error retries until the ghost expires.
      const codeClean = this.roomCode.toLowerCase().trim();
      this.myPeerId = this.isRoomHost
        ? this.getHostPeerId()
        : `hotspot_${codeClean}_${this.playerId}`;

      this.peer = new Peer(this.myPeerId);

      this.peer.on('open', () => {
        this.updateSyncStatus(true);
        // Dial the host immediately — no relay round-trip needed.
        if (!this.isRoomHost) this.ensureHostConnection();
        this.sendHeartbeat();
      });

      this.peer.on('connection', (conn) => {
        this.setupPeerDataConnection(conn);
      });

      this.peer.on('error', (err) => {
        const type = err && err.type;

        if (type === 'unavailable-id') {
          if (this.isRoomHost) {
            // A ghost registration from a previous session of THIS room code.
            // It expires on its own; keep retrying rather than silently losing
            // the well-known id, which every other device is dialing.
            this.hostIdRetries = (this.hostIdRetries || 0) + 1;
            if (this.hostIdRetries <= 40) {
              try { if (this.peer) this.peer.destroy(); } catch(e) {}
              this.peer = null;
              setTimeout(() => this.initPeerSync(), 3000);
            }
          } else {
            this.myPeerId = `hotspot_${codeClean}_${this.playerId}_${Math.random().toString(36).slice(2, 6)}`;
            try { if (this.peer) this.peer.destroy(); } catch(e) {}
            this.peer = null;
            setTimeout(() => this.initPeerSync(), 1500);
          }
          return;
        }

        // peer-unavailable just means the host is not up yet; the 3s retry in
        // ensureHostConnection will keep trying.
        this.updateSyncStatus(this.peerCount() > 0);
      });
    } catch(e) {}
  }

  // --- FIREBASE REALTIME DATABASE RELAY ---
  // Google-hosted, so it works on any network and survives a phone switching
  // between WiFi and cellular — which a direct WebRTC link does not, and which
  // is the likeliest reason a match froze mid-game. ntfy.sh, the previous
  // relay, is simply unreachable. P2P stays as the low-latency fast path.
  initRtdbSync() {
    if (!this.roomCode) return;
    if (typeof firebase === 'undefined' || !window.FIREBASE_CONFIG) return;

    try {
      if (!firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(window.FIREBASE_CONFIG);
      }
      this.rtdb = firebase.database();
    } catch (e) {
      this.rtdb = null;
      return;
    }

    this.teardownRtdbListeners();

    const base = `rooms/${this.roomCode}`;
    const attach = () => {
      if (!this.rtdb || !this.roomCode) return;

      this.rtdbPlayersRef = this.rtdb.ref(`${base}/players`);
      this.rtdbEventsPushRef = this.rtdb.ref(`${base}/events`);
      this.rtdbEventsRef = this.rtdbEventsPushRef.limitToLast(30);
      this.rtdbMyRef = this.rtdb.ref(`${base}/players/${this.playerId}`);

      // If the phone dies or loses signal, drop our roster entry automatically.
      try { this.rtdbMyRef.onDisconnect().remove(); } catch (e) {}

      const onPlayer = (snap) => {
        const p = snap.val();
        if (!p || !p.id || p.id === this.playerId) return;
        this.lastCloudMessageAt = Date.now();
        this.handleCloudMessage({
          type: 'HEARTBEAT',
          senderId: p.id,
          peerId: p.peerId || null,
          player: p,
          headStartSeconds: p.headStartSeconds,
          boundaryRadius: p.boundaryRadius,
          matchDurationSeconds: p.matchDurationSeconds
        });
      };
      this.rtdbPlayersRef.on('child_added', onPlayer);
      this.rtdbPlayersRef.on('child_changed', onPlayer);
      this.rtdbPlayersRef.on('child_removed', (snap) => {
        if (snap.key && snap.key !== this.playerId) delete this.players[snap.key];
        this.updateLobbyList();
      });

      // Ignore whatever events are already sitting in the room when we attach,
      // so a leftover START_HEADSTART cannot yank a joining phone straight into
      // a finished round. child_added fires for existing children before the
      // first value event, so priming on that is reliable.
      this.rtdbPrimed = false;
      this.rtdbEventsRef.on('child_added', (snap) => {
        if (!this.rtdbPrimed) return;
        const data = snap.val();
        if (!data || data.senderId === this.playerId) return;
        this.lastCloudMessageAt = Date.now();
        this.handleCloudMessage(data);
      });
      this.rtdbEventsRef.once('value', () => { this.rtdbPrimed = true; });

      this.rtdb.ref('.info/connected').on('value', (s) => {
        this.rtdbConnected = !!s.val();
        this.refreshTransportStatus();
      });
    };

    // The room creator wipes any leftover state before anyone attaches.
    if (this.isRoomHost) {
      try {
        this.rtdb.ref(base).remove().then(attach).catch(attach);
      } catch (e) { attach(); }
    } else {
      attach();
    }
  }

  rtdbPublishSelf(player) {
    if (!this.rtdbMyRef || !player) return;
    try {
      this.rtdbMyRef.set({
        id: this.playerId,
        name: this.playerName,
        role: this.role,
        lat: player.lat,
        lng: player.lng,
        accuracy: player.accuracy,
        peerId: this.myPeerId || null,
        headStartSeconds: this.headStartSeconds,
        boundaryRadius: this.boundaryRadius,
        matchDurationSeconds: this.matchDurationSeconds,
        ts: firebase.database.ServerValue.TIMESTAMP
      }).catch(() => {});
    } catch (e) {}
  }

  rtdbPublishEvent(data) {
    if (!this.rtdbEventsPushRef) return;
    try { this.rtdbEventsPushRef.push(data).catch(() => {}); } catch (e) {}
  }

  teardownRtdbListeners() {
    try {
      if (this.rtdbPlayersRef) this.rtdbPlayersRef.off();
      if (this.rtdbEventsRef) this.rtdbEventsRef.off();
      if (this.rtdb) this.rtdb.ref('.info/connected').off();
    } catch (e) {}
    this.rtdbPlayersRef = null;
    this.rtdbEventsRef = null;
  }

  teardownRtdb() {
    this.teardownRtdbListeners();
    try {
      if (this.rtdbMyRef) {
        this.rtdbMyRef.onDisconnect().cancel();
        this.rtdbMyRef.remove();
      }
    } catch (e) {}
    this.rtdbMyRef = null;
    this.rtdbEventsPushRef = null;
    this.rtdbPrimed = false;
    this.rtdbConnected = false;
  }

  // Abort relay requests quickly. When ntfy is blocked the TCP connect never
  // completes, so without this a hung fetch accumulates every 3 seconds.
  cloudFetch(url, opts) {
    const o = Object.assign({}, opts || {});
    try {
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        o.signal = AbortSignal.timeout(6000);
      }
    } catch(e) {}
    return fetch(url, o);
  }

  getHostPeerId() {
    if (!this.roomCode) return null;
    return `hotspot_${this.roomCode.toLowerCase().trim()}_host`;
  }

  peerCount() {
    if (!this.peerConnections) return 0;
    return Object.values(this.peerConnections).filter(c => c && c.open).length;
  }

  // Non-hosts keep trying to reach the host until the DataChannel is open.
  ensureHostConnection() {
    if (this.isRoomHost || !this.roomCode || !this.peer) return;
    const hostId = this.getHostPeerId();
    const existing = this.peerConnections ? this.peerConnections[hostId] : null;
    if (existing && existing.open) return;
    this.connectToPeerId(hostId);
  }

  // Dial the hider's announced peer ID. Seekers AND spectators both need this;
  // previously spectators never connected at all and ran the spectator map on the slow,
  // rate-limited cloud relay alone.
  connectToPeerId(peerId) {
    if (!this.peer || !peerId || peerId === this.myPeerId) return;
    if (this.peerConnections && this.peerConnections[peerId]) return;
    if (this.pendingPeerDials && this.pendingPeerDials[peerId]) return;

    this.pendingPeerDials = this.pendingPeerDials || {};
    this.pendingPeerDials[peerId] = true;

    try {
      const conn = this.peer.connect(peerId, { reliable: true });
      this.setupPeerDataConnection(conn);
    } catch(e) {}

    setTimeout(() => {
      if (this.pendingPeerDials) delete this.pendingPeerDials[peerId];
    }, 5000);
  }

  destroyPeer() {
    if (this.peerConnections) {
      Object.values(this.peerConnections).forEach((conn) => {
        try { conn.close(); } catch(e) {}
      });
    }
    this.peerConnections = {};
    this.pendingPeerDials = {};
    if (this.peer) {
      try { this.peer.destroy(); } catch(e) {}
      this.peer = null;
    }
    this.myPeerId = null;
  }

  setupPeerDataConnection(conn) {
    if (!conn) return;

    conn.on('open', () => {
      this.peerConnections[conn.peer] = conn;
      this.updateSyncStatus(true);
      this.sendHeartbeat();
    });

    conn.on('data', (data) => {
      this.lastCloudMessageAt = Date.now();
      this.updateSyncStatus(true);
      if (data) this.handleCloudMessage(data);
    });

    conn.on('close', () => {
      delete this.peerConnections[conn.peer];
    });

    conn.on('error', () => {
      delete this.peerConnections[conn.peer];
    });
  }

  broadcastPeer(data) {
    if (this.peerConnections) {
      Object.values(this.peerConnections).forEach((conn) => {
        if (conn && conn.open) {
          try { conn.send(data); } catch(e) {}
        }
      });
    }
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

  // includeCloud=false sends only over the P2P DataChannel. GPS ticks use that
  // path: they fire several times a second, and POSTing each one to the public
  // relay is what was burning the ntfy.sh rate limit and causing the 429s.
  sendHeartbeat(includeCloud = true) {
    if (!this.roomCode || this.isSoloDrill) return;
    const topic = this.getTopic();

    const currentGeo = (window.hotspotGeo && window.hotspotGeo.currentPosition) ? window.hotspotGeo.currentPosition : null;
    const pos = this.myPosition || currentGeo;

    // Spectators are not on the field and must never broadcast a position. A
    // laptop without GPS falls back to a hardcoded default, which would drop a
    // phantom player on the map and stretch everyone's view to fit it.
    const isSpectator = (this.role === 'spectator');

    const data = {
      type: 'HEARTBEAT',
      senderId: this.playerId,
      timestamp: Date.now(),
      roundId: this.currentRoundId,
      peerId: this.myPeerId || null,
      player: {
        id: this.playerId,
        name: this.playerName,
        role: this.role,
        lat: isSpectator ? null : (pos ? pos.lat : null),
        lng: isSpectator ? null : (pos ? pos.lng : null),
        accuracy: isSpectator ? null : (pos ? (pos.accuracy || 25) : 25)
      },
      headStartSeconds: this.headStartSeconds,
      boundaryRadius: this.boundaryRadius
    };

    // 1. Send directly over WebRTC Peer-to-Peer DataChannel (0ms delay, 0 rate limits)
    this.broadcastPeer(data);

    // 2. Publish to the relays — throttled, unlike the P2P path.
    if (!includeCloud) return;

    this.rtdbPublishSelf(data.player);

    try {
      this.cloudFetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
        .then((res) => {
          if (res && res.ok) {
            this.updateSyncStatus(true);
          } else {
            // Silently ignore 429 rate limit responses from public ntfy relay
            if (res && res.status === 429) return;
            const code = res ? res.status : 0;
            this.updateSyncStatus(false, 'HTTP ' + code);
          }
        })
        .catch(() => {});
    } catch(e) {}
  }

  broadcastCloud(data) {
    if (!this.roomCode || this.isSoloDrill) return;
    data.senderId = this.playerId;
    data.timestamp = Date.now();
    const topic = this.getTopic();

    // Broadcast over WebRTC Direct P2P, and mirror to the relay so devices
    // without a working peer link still receive it.
    this.broadcastPeer(data);
    this.rtdbPublishEvent(data);

    try {
      this.cloudFetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
        .then((res) => {
          if (res && res.ok) {
            this.updateSyncStatus(true);
          }
        })
        .catch(() => {});
    } catch(e) {}
  }

  pollCloudMessages(topic) {
    if (!topic) return;
    try {
      this.cloudFetch(`https://ntfy.sh/${topic}/json?poll=1&since=15s`)
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
          // Everyone who is not the hider dials the hider, forming the mesh hub.
          if (this.role !== 'hider' && data.peerId) {
            this.connectToPeerId(data.peerId);
          }
        }

        if (data.headStartSeconds) this.headStartSeconds = data.headStartSeconds;
        if (data.boundaryRadius) this.boundaryRadius = data.boundaryRadius;
        if (data.matchDurationSeconds) this.matchDurationSeconds = data.matchDurationSeconds;

        // The room creator is the mesh hub and relays every heartbeat to all
        // other connected devices, so seekers see each other. Keyed on host,
        // not on role, so a role swap does not silently kill the relay.
        if (this.isRoomHost && data.senderId !== this.playerId) {
          this.broadcastPeer(data);
        }

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

    if (data.type === 'HIDER_ABANDONED') {
      if (this.gameState === 'active' || this.gameState === 'headstart') {
        this.stopPulseLoop();
        if (this.headStartTimer) clearInterval(this.headStartTimer);
        window.hotspotAudio.speak(`Attention! Hider ${data.name || ''} left the hunt. Game canceled!`);
        alert(`⚠️ HIDER LEFT THE HUNT!\n\nHider (${data.name || 'Hider'}) has abandoned the match.`);
        this.showScreen('home-screen');
        try { this.leaveRoom(); } catch(e) {}
      }
      return;
    }

    if (data.type === 'TAG') {
      this.applyTag(data);
      return;
    }

    if (data.type === 'REMATCH') {
      this.applyRematch();
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
    this.appliedTagByRound = {};

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
  createRoom(headStartSec = 60, mode = 'classic', boundaryFeet = 250, matchDurationSec = 300) {
    // Fully leave whatever room we were in. Without this the previous room's
    // roster, database listeners and player node all survived into the new one,
    // which is why players from the last game kept showing up under a new code.
    if (this.roomCode) { try { this.leaveRoom(); } catch(e) {} }

    this.isSoloDrill = false;
    this.headStartSeconds = parseInt(headStartSec, 10) || 60;
    this.boundaryRadius = parseInt(boundaryFeet, 10) || 250;
    this.gameMode = mode;
    this.matchDurationSeconds = parseInt(matchDurationSec, 10) || 300;
    this.roomCode = this.generateRoomCode();
    this.isRoomHost = true;   // owns the well-known peer id for this room
    this.hostIdRetries = 0;
    this.joinTime = Date.now();
    this.currentRoundId = null;
    this.seenRoundIds = {};
    this.taggedHiderIds = {};
    this.appliedTagByRound = {};
    this.role = 'hider';
    this.hiderId = this.playerId;
    this.gameState = 'lobby';

    const currentGeo = (window.hotspotGeo && window.hotspotGeo.currentPosition) ? window.hotspotGeo.currentPosition : null;
    const pos = this.myPosition || currentGeo;

    this.players = {
      [this.playerId]: {
        id: this.playerId,
        name: this.playerName,
        role: 'hider',
        lat: pos ? pos.lat : null,
        lng: pos ? pos.lng : null
      }
    };

    document.getElementById('lobby-code-display').innerText = this.roomCode;
    this.updateLobbyList();
    this.showScreen('lobby-screen');

    this.initCloudSync();

    window.hotspotAudio.speak(`Hunt created. Code is ${this.roomCode.split('').join(' ')}`);
  }

  generateRoomCode() {
    // 27-char unambiguous alphabet.
    // Strictly excludes confusing character pairs: 0/O, 1/I/L, and 2/Z.
    const alphabet = 'ABCDEFGHJKMNPQRSTVWX3456789';
    let out = '';
    for (let i = 0; i < 6; i++) {
      out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
  }

  leaveRoom() {
    if (this.role === 'hider' && this.roomCode && (this.gameState === 'headstart' || this.gameState === 'active')) {
      this.broadcastCloud({
        type: 'HIDER_ABANDONED',
        roundId: this.currentRoundId,
        name: this.playerName
      });
    }

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
    if (this.matchTimer) {
      clearInterval(this.matchTimer);
      this.matchTimer = null;
    }
    this.stopPulseLoop();

    this.teardownRtdb();

    // Tear the WebRTC peer down. Leaving it alive kept a stale registration on
    // the broker under the old room and leaked a connection per room joined.
    this.destroyPeer();

    this.roomCode = null;
    this.currentRoundId = null;
    this.isRoomHost = false;
    this.hostIdRetries = 0;
    this.isSoloDrill = false;
    this.gameState = 'lobby';
    this.players = {};
    this.hiderId = null;
    this.decoyPos = null;
    this.taggedHiderIds = {};
    this.appliedTagByRound = {};
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
    if (homeLabel) homeLabel.innerText = '🌐 hotspot-yardtag.web.app';

    ['btn-powerup-decoy', 'btn-powerup-smoke', 'btn-bearing-ping'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = false;
    });

    const soloControls = document.getElementById('solo-controls-card');
    if (soloControls) soloControls.style.display = 'none';

    const readyBtn = document.getElementById('btn-hider-ready');
    if (readyBtn) readyBtn.style.display = '';

    this.triggerSmokeVisual(false);
    this.blankSeekerRadar();
  }

  // "Winner becomes hider" used to be announced and then thrown away, because
  // the round simply ended and the next createRoom/joinRoom overwrote the role.
  // A rematch keeps the room and the players and replays with rotated roles.
  rematch() {
    if (!this.roomCode || this.isSoloDrill) {
      alert('Rematch is only available in a multiplayer room.');
      return;
    }
    if (this.role !== 'hider' && this.role !== 'spectator') {
      alert('Only the new Hider or the Spectator (Parent) can start the rematch.');
      return;
    }
    this.broadcastCloud({ type: 'REMATCH' });
    this.applyRematch();
  }

  applyRematch() {
    if (!this.roomCode) return;

    if (this.headStartTimer) { clearInterval(this.headStartTimer); this.headStartTimer = null; }
    if (this.matchTimer) { clearInterval(this.matchTimer); this.matchTimer = null; }
    this.stopPulseLoop();

    this.gameState = 'lobby';
    this.currentRoundId = null;
    this.taggedHiderIds = {};
    this.appliedTagByRound = {};
    this.tagEvent = null;
    this.matchTrackHistory = [];
    this.decoyPos = null;
    this.outOfBoundsSpoken = false;
    this.yardCenterPos = null;

    this.powerups = {
      decoyUsed: false,
      smokeUsed: false,
      bearingPingUsed: false,
      decoyActive: false,
      smokeActive: false,
      bearingActive: false
    };
    ['btn-powerup-decoy', 'btn-powerup-smoke', 'btn-bearing-ping'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = false;
    });

    const readyBtn = document.getElementById('btn-hider-ready');
    if (readyBtn) readyBtn.style.display = '';
    this.triggerSmokeVisual(false);
    this.blankSeekerRadar();

    // Roles were already rotated locally when the tag landed; publish the new
    // one so every roster agrees before the next round starts.
    if (this.players[this.playerId]) this.players[this.playerId].role = this.role;

    const codeEl = document.getElementById('lobby-code-display');
    if (codeEl) codeEl.innerText = this.roomCode;

    this.updateLobbyList();
    this.showScreen('lobby-screen');
    this.sendHeartbeat();

    window.hotspotAudio.speak(`Rematch ready! You are the ${this.role}.`);
  }

  goHome() {
    this.showScreen('home-screen');
    try {
      this.leaveRoom();
    } catch(e) {}
    this.updateSeasonStatsDisplay();
  }

  resetSeasonRecords() {
    if (confirm('🏆 Start New Season?\n\nThis will reset your Total Hunts, Fastest Tag, and Longest Hide records back to zero.')) {
      this.seasonStats = { totalHunts: 0, fastestTagMs: null, longestHideMs: 0 };
      try {
        localStorage.removeItem('hotspot_stats');
      } catch(e) {}
      this.updateSeasonStatsDisplay();
      window.hotspotAudio.speak('Season records reset! New Season started.');
    }
  }

  updateLobbyNickname() {
    const el = document.getElementById('lobby-nickname-input');
    const newName = el ? el.value.trim() : '';
    if (!newName) {
      alert('Please enter a nickname.');
      return;
    }

    this.playerName = newName;
    if (this.players[this.playerId]) {
      this.players[this.playerId].name = newName;
    }

    this.sendHeartbeat();
    this.updateLobbyList();
    window.hotspotAudio.speak(`Name updated to ${newName}`);
  }

  joinRoom(code, nickname, role = 'seeker') {
    const cleanCode = code ? code.trim() : '';
    if (cleanCode.length !== 6) {
      alert('Please enter the full 6-character room code from the host.');
      return;
    }

    if (this.roomCode) { try { this.leaveRoom(); } catch(e) {} }

    this.isSoloDrill = false;
    this.roomCode = code.toUpperCase().trim();
    this.isRoomHost = false;
    this.joinTime = Date.now();
    this.currentRoundId = null;
    this.seenRoundIds = {};
    this.taggedHiderIds = {};
    this.appliedTagByRound = {};
    this.playerName = nickname ? nickname.trim() : this.playerName;
    this.role = role;
    this.gameState = 'lobby';

    const currentGeo = (window.hotspotGeo && window.hotspotGeo.currentPosition) ? window.hotspotGeo.currentPosition : null;
    const pos = this.myPosition || currentGeo;

    this.players = {
      [this.playerId]: {
        id: this.playerId,
        name: this.playerName,
        role: this.role,
        lat: pos ? pos.lat : null,
        lng: pos ? pos.lng : null
      }
    };

    document.getElementById('lobby-code-display').innerText = this.roomCode;
    this.updateLobbyList();
    this.showScreen('lobby-screen');

    this.initCloudSync();

    window.hotspotAudio.speak(`Joined hunt ${this.roomCode.split('').join(' ')}`);
  }

  toggleRole() {
    if (this.gameState !== 'lobby') {
      alert('You can only switch roles in the lobby, before the round starts.');
      return;
    }

    const becomingHider = (this.role !== 'hider');

    // The game has exactly one hider. Nothing stopped two people claiming the
    // role at once, which left the roster showing two hiders and every seeker
    // measuring distance to whichever one it happened to pick.
    if (becomingHider) {
      const now = Date.now();
      const otherHider = Object.values(this.players).find(p =>
        p.id !== this.playerId &&
        p.role === 'hider' &&
        (!p.lastSeen || now - p.lastSeen <= 15000)
      );
      if (otherHider) {
        alert(`${otherHider.name || 'Someone else'} is already the Hider.\n\nThey need to switch to Seeker first, then you can take it.`);
        return;
      }
    }

    this.role = becomingHider ? 'hider' : 'seeker';
    if (this.players[this.playerId]) {
      this.players[this.playerId].role = this.role;
    }
    if (!becomingHider && this.hiderId === this.playerId) this.hiderId = null;

    // Publish immediately over every transport so the other phones redraw now
    // rather than on the next 3s tick.
    this.sendHeartbeat();
    this.updateLobbyList();
    window.hotspotAudio.speak(`You are now the ${this.role.toUpperCase()}`);
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

    // Rebuilding both roster lists via innerHTML on every incoming heartbeat
    // was pure DOM churn during a live hunt, when the lobby is not even on
    // screen — heartbeats arrive at GPS-tick rate and the host relays everyone
    // else's too, so this ran many times a second for nothing.
    const lobbyVisible = document.getElementById('lobby-screen');
    if (!lobbyVisible || !lobbyVisible.classList.contains('active')) return;

    const now = Date.now();
    // Keep active players seen in last 15s
    const activePlayers = Object.values(this.players).filter(p => !p.lastSeen || now - p.lastSeen <= 15000);

    const hidersList = activePlayers.filter(p => p.role === 'hider');
    const seekersList = activePlayers.filter(p => p.role === 'seeker');

    const hiderContainer = document.getElementById('lobby-hider-list');
    const seekerContainer = document.getElementById('lobby-seeker-list');

    if (hiderContainer) {
      hiderContainer.innerHTML = hidersList.map(p => `
        <div class="player-badge hider" style="border: 2px solid var(--accent-amber); background: rgba(245, 158, 11, 0.15); padding: 10px 14px; border-radius: 10px; display: flex; align-items: center; justify-content: space-between;">
          <span class="name" style="font-weight: 800; font-size: 15px; color: #FFF;">
            👑 ${p.name} <span style="font-size: 11px; background: var(--accent-amber); color: #000; padding: 2px 6px; border-radius: 8px; font-weight: 900; margin-left: 6px;">HOST</span> ${p.id === this.playerId ? '<b style="color:var(--accent-cyan);">(YOU)</b>' : ''}
          </span>
          <span style="font-size: 11px; color: var(--accent-amber); font-weight: 800; letter-spacing: 0.5px;">SOLE HIDER</span>
        </div>
      `).join('') || '<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:10px;">Waiting for Host to claim Hider...</div>';
    }

    if (seekerContainer) {
      seekerContainer.innerHTML = seekersList.map(p => `
        <div class="player-badge seeker" style="border: 1px solid var(--accent-cyan); background: rgba(0, 240, 255, 0.08); padding: 8px 12px; border-radius: 8px; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;">
          <span class="name" style="font-weight: 700; font-size: 14px; color: #FFF;">
            🎯 ${p.name} ${p.id === this.playerId ? '<b style="color:var(--accent-cyan);">(YOU)</b>' : ''}
          </span>
          <span style="font-size: 11px; color: var(--accent-cyan); font-weight: 700;">SEEKER</span>
        </div>
      `).join('') || '<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:10px;">No Seekers Joined Yet</div>';
    }

    // Host & Spectator Start Button Guard: Hider and Spectator (Parent) can start round!
    const startBtn = document.getElementById('btn-start-round');
    const waitMsg = document.getElementById('lobby-wait-msg');

    if (this.role === 'hider' || this.role === 'spectator') {
      if (startBtn) startBtn.style.display = 'block';
      if (waitMsg) waitMsg.style.display = 'none';
    } else {
      if (startBtn) startBtn.style.display = 'none';
      if (waitMsg) waitMsg.style.display = 'block';
    }
  }

  // --- GAME START & HEADSTART TIMING ENGINE ---
  startHeadstart() {
    // Both Hider (Host) and Spectator (Parent) can start the round!
    if (this.role !== 'hider' && this.role !== 'spectator') {
      alert('Only the Host or Spectator (Parent) can start the round!');
      return;
    }

    const startTime = Date.now();
    this.headStartStartTime = startTime;

    // The yard centre must be the HIDER's start point, not whoever pressed
    // Start. When a spectating parent starts the round, using their own
    // position put the geofence on their chair instead of the play area.
    const hiderPlayer = Object.values(this.players).find(p => p.role === 'hider');
    if (hiderPlayer && hiderPlayer.lat && hiderPlayer.lng) {
      this.yardCenterPos = { lat: hiderPlayer.lat, lng: hiderPlayer.lng };
    } else if (this.role !== 'spectator' && this.myPosition) {
      this.yardCenterPos = { lat: this.myPosition.lat, lng: this.myPosition.lng };
    }

    const roundId = 'rnd_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    this.currentRoundId = roundId;
    this.seenRoundIds[roundId] = true;
    this.taggedHiderIds = {};
    this.appliedTagByRound = {};
    this.gameState = 'headstart';

    this.broadcastCloud({
      type: 'START_HEADSTART',
      roundId: roundId,
      headStartStartTime: startTime,
      headStartSeconds: this.headStartSeconds,
      boundaryRadius: this.boundaryRadius,
      matchDurationSeconds: this.matchDurationSeconds,
      yardCenterPos: this.yardCenterPos
    });

    this.handleGameStateChange('headstart', {
      roundId: roundId,
      headStartStartTime: startTime,
      headStartSeconds: this.headStartSeconds,
      boundaryRadius: this.boundaryRadius,
      matchDurationSeconds: this.matchDurationSeconds,
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

      // No proximity information while the hider is still hiding. The radar
      // used to sit on a stale COLD/HOT reading during the countdown, which
      // leaks a hint before the hunt has even started.
      this.blankSeekerRadar();

      window.hotspotAudio.speak(`Hider has ${duration} seconds to hide!`);

      if (this.headStartTimer) clearInterval(this.headStartTimer);

      this.headStartTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const remaining = Math.max(0, duration - elapsed);
        this.headStartRemaining = remaining;

        document.querySelectorAll('.headstart-counter').forEach(el => {
          el.innerText = `⏳ HIDING TIME: ${remaining}s`;
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
      this.startMatchTimer();
    } else if (newState === 'gameover') {
      this.stopPulseLoop();
      if (this.headStartTimer) clearInterval(this.headStartTimer);
      if (this.matchTimer) clearInterval(this.matchTimer);

      // The headline was hardcoded "TAGGED!", so a round that ended on the
      // clock — with nobody caught at all — still announced a tag.
      const headline = document.getElementById('replay-headline');
      const subhead = document.getElementById('replay-subhead');
      if (headline) {
        if (this.tagEvent && this.tagEvent.seekerName) {
          headline.innerText = 'TAGGED!';
          headline.style.color = 'var(--primary-blaze)';
          if (subhead) subhead.innerText = `${this.tagEvent.seekerName} caught ${this.tagEvent.hiderName}`;
        } else {
          headline.innerText = 'HIDER SURVIVED!';
          headline.style.color = 'var(--accent-cyan)';
          if (subhead) subhead.innerText = 'Time expired — nobody was caught';
        }
      }

      this.showScreen('replay-screen');
      if (window.hotspotReplay) {
        window.hotspotReplay.loadReplayData(this.matchTrackHistory, this.tagEvent);
        window.hotspotReplay.setBoundary(this.yardCenterPos, this.boundaryRadius);
      }

      // Rematch only makes sense in a real room with the roster still present.
      const rematchBtn = document.getElementById('btn-rematch');
      if (rematchBtn) {
        rematchBtn.style.display = (this.roomCode && !this.isSoloDrill) ? 'block' : 'none';
      }
    }
  }

  startMatchTimer() {
    if (this.matchTimer) clearInterval(this.matchTimer);
    if (!this.matchDurationSeconds || this.matchDurationSeconds <= 0) {
      ['match-timer-seeker', 'match-timer-hider'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerText = '⏱️ NO TIME LIMIT';
      });
      return;
    }

    const matchStartTime = Date.now();

    this.matchTimer = setInterval(() => {
      if (this.gameState !== 'active') {
        clearInterval(this.matchTimer);
        this.matchTimer = null;
        return;
      }

      const elapsedSec = Math.floor((Date.now() - matchStartTime) / 1000);
      const remainingSec = Math.max(0, this.matchDurationSeconds - elapsedSec);

      const mins = Math.floor(remainingSec / 60);
      const secs = (remainingSec % 60).toString().padStart(2, '0');
      const timeStr = `⏱️ MATCH TIME: ${mins}:${secs}`;

      ['match-timer-seeker', 'match-timer-hider'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerText = timeStr;
      });

      if (remainingSec === 60) {
        window.hotspotAudio.speak("1 minute remaining in the hunt!");
      } else if (remainingSec === 30 || remainingSec === 15) {
        window.hotspotAudio.speak(`${remainingSec} seconds remaining!`);
      } else if (remainingSec <= 5 && remainingSec > 0) {
        window.hotspotAudio.playCountdownBeep(false);
      }

      if (remainingSec <= 0) {
        clearInterval(this.matchTimer);
        this.matchTimer = null;
        this.handleMatchTimeExpired();
      }
    }, 1000);
  }

  handleMatchTimeExpired() {
    if (this.gameState !== 'active') return;

    this.stopPulseLoop();
    this.gameState = 'gameover';

    const survivedMs = this.gameStartTime ? (Date.now() - this.gameStartTime) : 0;

    if (this.role === 'hider') {
      window.hotspotAudio.speak("TIME EXPIRED! YOU SURVIVED AND WON THE HUNT!");
      alert("🎉 TIME EXPIRED!\n\nYou successfully hid until time ran out! HIDER WINS!");
    } else {
      window.hotspotAudio.speak("TIME EXPIRED! THE HIDER ESCAPED! HIDER WINS!");
      alert("⌛ TIME EXPIRED!\n\nThe Hider survived the entire match duration! Hider wins!");
    }

    // Surviving the whole clock is exactly the Longest Hide record, and it was
    // the one outcome that never got saved.
    this.saveSeasonStats(survivedMs, 'escape');
    this.handleGameStateChange('gameover');
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
    if (warnBox && this.role === 'spectator') {
      // Watching from a laptop with no GPS is a supported setup, not a fault.
      warnBox.style.display = 'none';
    } else if (warnBox) {
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

    // Also run boundary feedback here, not just in the pulse loop — the hider is
    // moving during the hiding time, which is exactly when they stray.
    if (this.gameState === 'headstart' || this.gameState === 'active') {
      this.updateBoundaryWarning();
    }

    // Push position over the P2P DataChannel on every GPS tick — free and
    // instant. The cloud relay is left to the throttled 3s interval; posting
    // per-tick is what exhausted the ntfy.sh rate limit.
    if (this.roomCode && (this.gameState === 'headstart' || this.gameState === 'active')) {
      this.sendHeartbeat(false);
    }
  }

  onGpsError(errMessage) {
    const warnBox = document.getElementById('gps-warning-banner');
    if (!warnBox) return;

    // A spectator does not need a location fix — watching from a laptop or a
    // desktop with no GPS is a normal way to run the game, not an error.
    if (this.role === 'spectator') {
      warnBox.style.display = 'none';
      return;
    }

    warnBox.innerText = `📍 Tap to Allow GPS Access: ${errMessage}`;
    warnBox.style.display = 'block';
  }

  recordTrackPoint(playerId, name, role, pos) {
    let track = this.matchTrackHistory.find(t => t.playerId === playerId);
    if (!track) {
      track = { playerId, name, role, points: [] };
      this.matchTrackHistory.push(track);
    }

    const now = Date.now();

    // This is called from both the GPS watcher and every incoming heartbeat, so
    // the same player was logged many times a second and the array grew without
    // limit for the whole match. One point per second per player is plenty for
    // a replay trail.
    const last = track.points[track.points.length - 1];
    if (last && now - last.timestamp < 1000) return;

    track.points.push({ lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, timestamp: now });

    // Hard ceiling so a long match cannot exhaust memory on a phone.
    if (track.points.length > 2000) track.points.splice(0, track.points.length - 2000);
  }

  // Neutral radar: no band, no distance, no colour cue. Used while the hider
  // is still hiding, so nothing about their whereabouts is on screen yet.
  blankSeekerRadar() {
    this.currentBand = null;
    this.currentDistance = null;

    const bandLabel = document.getElementById('seeker-band-label');
    if (bandLabel) bandLabel.innerText = 'STAND BY';

    const distEl = document.getElementById('seeker-dist-readout');
    if (distEl) distEl.innerHTML = '';

    const pulseRing = document.getElementById('seeker-pulse-ring');
    if (pulseRing) {
      pulseRing.style.borderColor = '#64748B';
      pulseRing.style.boxShadow = 'none';
      pulseRing.style.animationDuration = '2200ms';
    }

    // Let the first real band of the round announce itself.
    if (window.hotspotAudio) {
      window.hotspotAudio.lastSpokenBand = null;
      window.hotspotAudio.lastAnnouncedBand = null;
    }
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
      let hiderPlayerForAcc = null;

      if (this.isSoloDrill) {
        hiderPos = window.hotspotGeo.soloHiderPosition;
      } else {
        const hiderPlayer = Object.values(this.players).find(p => p.role === 'hider');
        hiderPlayerForAcc = hiderPlayer || null;
        if (hiderPlayer && hiderPlayer.lat) {
          hiderPos = { lat: hiderPlayer.lat, lng: hiderPlayer.lng };
        }

        // Connection loss detection: notify Seekers if Hider stops sending heartbeats
        if (hiderPlayer && hiderPlayer.lastSeen) {
          const silentMs = Date.now() - hiderPlayer.lastSeen;
          if (silentMs > 35000) {
            this.stopPulseLoop();
            if (this.headStartTimer) clearInterval(this.headStartTimer);
            window.hotspotAudio.speak("Hider connection lost completely. Hunt canceled!");
            alert("⚠️ HIDER DISCONNECTED!\n\nHider signal was lost for over 35 seconds. Hunt canceled.");
            this.showScreen('home-screen');
            try { this.leaveRoom(); } catch(e) {}
            return;
          } else if (silentMs > 18000) {
            const bandLabel = document.getElementById('seeker-band-label');
            if (bandLabel) bandLabel.innerText = '⚠️ HIDER OFFLINE';
            if (!this.hiderWarnSpoken) {
              this.hiderWarnSpoken = true;
              window.hotspotAudio.speak("Warning! Hider connection lost. Waiting for signal.");
            }
          } else {
            this.hiderWarnSpoken = false;
          }
        }
      }

      if (this.decoyPos) {
        hiderPos = this.decoyPos;
      }

      // A reading is only meaningful if the hider's position is actually
      // arriving. Previously, with no position or a stale one, the loop just
      // returned and left whatever band was last on screen — which is how two
      // phones standing together ended up showing WARM and COLD.
      const hiderFixAgeMs = (!this.isSoloDrill && hiderPlayerForAcc && hiderPlayerForAcc.lastSeen)
        ? (Date.now() - hiderPlayerForAcc.lastSeen)
        : 0;

      if (!hiderPos || hiderFixAgeMs > 8000) {
        const bandLabel = document.getElementById('seeker-band-label');
        const distEl = document.getElementById('seeker-dist-readout');
        const pulseRing = document.getElementById('seeker-pulse-ring');
        if (bandLabel && !this.powerups.smokeActive) bandLabel.innerText = 'NO SIGNAL';
        if (distEl) {
          distEl.innerHTML = hiderPos
            ? `<span style="font-size:.55em;opacity:.8;">last fix ${Math.round(hiderFixAgeMs / 1000)}s ago</span>`
            : '<span style="font-size:.55em;opacity:.8;">waiting for hider…</span>';
        }
        if (pulseRing) {
          pulseRing.style.borderColor = '#64748B';
          pulseRing.style.boxShadow = 'none';
          pulseRing.style.animationDuration = '2200ms';
        }
        this.currentBand = null;
        return;
      }

      const bufferedHiderPos = window.hotspotGeo.getBufferedPosition(this.myPosition, hiderPos);

      const distFeet = window.hotspotGeo.calculateDistance(
        this.myPosition.lat, this.myPosition.lng,
        bufferedHiderPos.lat, bufferedHiderPos.lng
      );

      this.currentDistance = distFeet;

      // How much of this reading is GPS noise? Both phones contribute error.
      const hiderAcc = (hiderPlayerForAcc && hiderPlayerForAcc.accuracy) || 25;
      const marginFeet = window.hotspotGeo.combinedAccuracy(
        this.myPosition.accuracy, hiderAcc
      );
      this.currentMargin = marginFeet;

      const bandInfo = window.hotspotGeo.getDistanceBand(distFeet, marginFeet);
      this.currentBand = bandInfo.band;

      const pulseRing = document.getElementById('seeker-pulse-ring');
      const bandLabel = document.getElementById('seeker-band-label');

      if (bandLabel && !this.powerups.smokeActive) bandLabel.innerText = bandInfo.label;

      // Show the actual number and its uncertainty so "close" is interpretable.
      const distEl = document.getElementById('seeker-dist-readout');
      if (distEl && !this.powerups.smokeActive) {
        const shown = distFeet > 300
          ? `${Math.round(distFeet / 3)} yd`
          : `${Math.round(distFeet)} ft`;
        distEl.innerHTML = `${shown} <span style="opacity:.65;font-size:.6em;">±${marginFeet} ft</span>`
          + (bandInfo.capped ? '<div style="font-size:10px;color:#F59E0B;font-weight:700;margin-top:2px;">WEAK GPS — reading may be off</div>' : '');
      }

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

      // Auto-tag inside RED HOT (40ft). Latched per target so infection mode
      // cannot re-fire every 250ms while the seeker stays in range. Requires a
      // credible fix — a ±80ft reading must not be allowed to end the round.
      if (distFeet <= 40 && window.hotspotGeo.isTagCredible(marginFeet)
          && this.gameState === 'active' && !this.decoyPos) {
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
        let closestDistFeet = Infinity;
        let closestSeeker = null;
        seekerPlayers.forEach(s => {
          const d = window.hotspotGeo.calculateDistance(
            this.myPosition.lat, this.myPosition.lng,
            s.lat, s.lng
          );
          if (d < closestDistFeet) { closestDistFeet = d; closestSeeker = s; }
        });

        // Same GPS noise as the seeker radar, so show the same honesty about it.
        const margin = window.hotspotGeo.combinedAccuracy(
          this.myPosition.accuracy, closestSeeker ? closestSeeker.accuracy : 25
        );

        if (distEl) {
          const shown = closestDistFeet > 300
            ? `${Math.round(closestDistFeet / 3)}yd`
            : `${Math.round(closestDistFeet)}ft`;
          distEl.innerHTML = `${shown}<span style="font-size:.35em;opacity:.65;font-weight:600;"> ±${margin}ft</span>`;
        }
      } else {
        if (distEl) distEl.innerText = '--ft';
      }

    }

    // Boundary feedback runs for BOTH roles. Previously only the hider ever saw
    // it, and only once already at the edge — you cannot see a property line in
    // the dark, so everyone now gets a live "room left" readout.
    this.updateBoundaryWarning();

    if (this.role === 'spectator') {
      window.hotspotReplay.updateSpectatorView(this.players);
      window.hotspotReplay.setBoundary(this.yardCenterPos, this.boundaryRadius);
    }
  }

  updateBoundaryWarning() {
    const ids = ['hider-boundary-alert', 'seeker-boundary-alert'];
    const banners = ids.map(id => document.getElementById(id)).filter(Boolean);
    if (!banners.length) return;

    const noLimit = !this.yardCenterPos || !this.boundaryRadius || this.boundaryRadius <= 0 || !this.myPosition;
    if (noLimit || this.role === 'spectator') {
      banners.forEach(b => { b.style.display = 'none'; });
      return;
    }

    const distFromCenter = window.hotspotGeo.calculateDistance(
      this.myPosition.lat, this.myPosition.lng,
      this.yardCenterPos.lat, this.yardCenterPos.lng
    );
    const roomLeft = Math.max(0, Math.round(this.boundaryRadius - distFromCenter));

    let bg, text;
    if (distFromCenter > this.boundaryRadius) {
      bg = '#EF4444';
      text = `🛑 OUT OF BOUNDS — ${Math.round(distFromCenter - this.boundaryRadius)}ft past the ${this.boundaryRadius}ft line. Head back!`;
      if (!this.outOfBoundsSpoken) {
        this.outOfBoundsSpoken = true;
        if ('vibrate' in navigator) { try { navigator.vibrate([200, 100, 200]); } catch(e) {} }
        window.hotspotAudio.speak('Out of bounds! Head back inside the yard!');
      }
    } else if (distFromCenter > 0.8 * this.boundaryRadius) {
      this.outOfBoundsSpoken = false;
      bg = '#F59E0B';
      text = `⚠️ NEAR THE EDGE — only ${roomLeft}ft of room left`;
    } else {
      this.outOfBoundsSpoken = false;
      bg = 'rgba(34, 197, 94, 0.20)';
      text = `✅ In bounds — ${roomLeft}ft of room left`;
    }

    banners.forEach(b => {
      b.style.display = 'block';
      b.style.background = bg;
      b.innerText = text;
    });
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

    // FIRST TAG WINS, once per round. Two seekers can both be inside 40ft when
    // the hider is caught, and each device applied its own local tag before the
    // other's arrived — so both players were told they made the catch. The
    // earliest timestamp wins, with a deterministic tiebreak on seekerId so
    // every device independently agrees on the same winner.
    const roundKey = tag.roundId || 'noround';
    this.appliedTagByRound = this.appliedTagByRound || {};
    const prior = this.appliedTagByRound[roundKey];
    if (prior) {
      if (prior.seekerId === tag.seekerId) return;                 // our own tag echoed back
      if (prior.timestamp < (tag.timestamp || 0)) return;          // ours was first
      if (prior.timestamp === (tag.timestamp || 0) &&
          String(prior.seekerId) < String(tag.seekerId)) return;   // tiebreak
      // Otherwise the incoming tag genuinely beat ours; let it take over.
    }
    this.appliedTagByRound[roundKey] = {
      seekerId: tag.seekerId,
      timestamp: tag.timestamp || 0
    };

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

    // Winner Becomes Hider Rotation: The Seeker who made the tag becomes Hider for next round!
    if (this.playerId === tag.seekerId) {
      this.role = 'hider';
      window.hotspotAudio.speak(`YOU TAGGED THE HIDER! You are the new Hider for the next hunt!`);
      alert(`🎉 YOU TAGGED THE HIDER!\n\nAwesome catch! You are the Hider for the next round!`);
    }

    this.gameState = 'gameover';
    this.saveSeasonStats(Date.now() - this.gameStartTime);
    this.handleGameStateChange('gameover');
  }

  // outcome: 'tag'    — a seeker caught the hider
  //          'escape' — the match clock ran out and the hider survived
  // Fastest Tag only means anything for a tag; Longest Hide is how long the
  // hider stayed free either way. Previously both were fed the same number, so
  // they were really just min and max round length.
  saveSeasonStats(huntDurationMs, outcome = 'tag') {
    try {
      const stats = JSON.parse(localStorage.getItem('hotspot_stats') || '{"totalHunts":0,"fastestTagSec":9999,"longestHideSec":0}');
      stats.totalHunts += 1;
      const durationSec = Math.max(0, Math.floor(huntDurationMs / 1000));

      if (outcome === 'tag' && durationSec < stats.fastestTagSec) {
        stats.fastestTagSec = durationSec;
      }
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
