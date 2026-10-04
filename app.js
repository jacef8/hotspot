/**
 * HOTSPOT - Main Game Engine & Controller
 * Standard US Customary Units (Feet & Yards).
 *
 * Sync runs on two transports at once:
 *   - WebRTC DataChannel (PeerJS) — low latency, every GPS tick.
 *   - Firebase Realtime Database — reliable; survives a phone changing network
 *     mid-game and works where WebRTC cannot form a link.
 * Room discovery never depends on the relay: the room creator claims a
 * well-known peer id derived from the room code and everyone else dials it.
 * Round identity is carried by roundId (no cross-device clock comparison).
 */

window.FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;

class HotspotApp {
  constructor() {
    this.heartbeatInterval = null;

    this.roomCode = null;
    this.joinTime = 0;
    this.currentRoundId = null;
    this.seenRoundIds = {};
    this.taggedHiderIds = {};
    this.appliedTagByRound = {};
    this.lastCloudMessageAt = 0;
    this.syncFailCount = 0;
    // Whoever created the room owns the well-known peer id for it. Deliberately
    // NOT tied to hider/seeker, so role swaps and rematches cannot break the mesh.
    this.isRoomHost = false;
    // A reload or a killed tab used to mint a brand-new id, which left the old
    // roster entry behind as a ghost twin and dropped the player out of the
    // round. Reuse the id from a recent session so the same node is simply
    // taken over again.
    this.session = this.loadSession();
    this.playerId = (this.session && this.session.playerId) || ('player_' + Math.random().toString(36).substr(2, 6));

    // Liveness of the two people the room depends on, independent of the roster
    // (which forgets anyone silent for 15s, long before a "lost" verdict).
    this.hostSeenAt = 0;
    this.hiderLastSeenAt = 0;
    this.hiderSilentMs = 0;
    this.hiderWarnSpoken = false;
    // Firebase server clock minus this phone's clock. Every shared timestamp is
    // expressed in server time, so a phone whose clock is off does not run its
    // countdown early or late.
    this.serverOffset = 0;
    this.serverOffsetKnown = false;
    this.activeSinceServer = null;
    this.headStartStartTime = 0;
    this.lastCloudPosPush = 0;
    // Asked for on the host screen, the join screen AND in the lobby — three
    // inputs for one value. Remember it so it is typed once, ever.
    this.playerName = this.loadSavedName() || ('Runner_' + Math.floor(Math.random() * 899 + 100));
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
    this.tagRadiusFeet = 20; // host-configurable catch distance, in feet
    this.matchTimer = null;

    this.isSoloDrill = false;
    this.players = {};
    this.hiderId = null;

    // No position until the phone reports a real one. This used to start on a
    // hardcoded coordinate, which was then broadcast as the player's location:
    // a phone with GPS off read "±25ft" and showed up 2,000 miles away.
    this.myPosition = null;
    this.hasGpsFix = false;

    // When the last seeker was heard from — the hider's side of the same
    // liveness check seekers run on the hider.
    this.seekerLastSeenAt = 0;
    this.wakeLock = null;
    this.wakeLockFailed = false;
    // A session restored at launch is provisional until the room proves it is
    // still there; see watchdog().
    this.resumed = false;
    this.resumePowerups = null;
    this.roomProbe = null;

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
  loadSavedName() {
    try {
      const n = (localStorage.getItem('hotspot_name') || '').trim();
      return n ? n.slice(0, 24) : null;
    } catch (e) { return null; }
  }

  saveName(name) {
    const clean = (name || '').trim().slice(0, 24);
    if (!clean) return false;
    this.playerName = clean;
    try { localStorage.setItem('hotspot_name', clean); } catch (e) {}
    this.fillNameInputs();
    return true;
  }

  // Keep every name box in the app showing the same value.
  fillNameInputs() {
    ['host-nickname', 'join-nickname-input', 'lobby-nickname-input'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.value !== this.playerName) el.value = this.playerName;
    });
  }

  clearStaleCache() {
    try {
      ['hotspot_room', 'hotspot_session', 'hotspot_players', 'hotspot_state']
        .forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
    } catch(e) {}
  }

  // --- SESSION RESUME ---
  // Phone browsers discard background tabs and reload them. The app used to wipe
  // every trace of the room at boot, so a reload dropped the player back at the
  // home screen and re-entering the code landed them in the lobby while the
  // hunt carried on without them. The room, role and id are kept for a few
  // minutes so a reload puts the player straight back where they were.
  loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem('hotspot_resume') || 'null');
      if (!s || !s.room || !s.playerId) return null;
      if (Date.now() - (s.ts || 0) > 10 * 60 * 1000) return null;
      return s;
    } catch (e) { return null; }
  }

  saveSession() {
    if (!this.roomCode || this.isSoloDrill) return;
    try {
      localStorage.setItem('hotspot_resume', JSON.stringify({
        room: this.roomCode,
        playerId: this.playerId,
        role: this.role,
        host: !!this.isRoomHost,
        opts: {
          hs: this.headStartSeconds,
          boundary: this.boundaryRadius,
          md: this.matchDurationSeconds,
          tag: this.tagRadiusFeet,
          mode: this.gameMode
        },
        // One-use power-ups already spent this round, so a reload cannot hand
        // them back.
        pu: this.currentRoundId ? {
          round: this.currentRoundId,
          decoy: !!this.powerups.decoyUsed,
          smoke: !!this.powerups.smokeUsed,
          bearing: !!this.powerups.bearingPingUsed
        } : null,
        ts: Date.now()
      }));
    } catch (e) {}
  }

  clearSession() {
    try { localStorage.removeItem('hotspot_resume'); } catch (e) {}
  }

  tryResume() {
    const s = this.session;
    this.session = null;
    if (!s || this.roomCode) return;
    const o = s.opts || {};
    this.resumePowerups = s.pu || null;
    if (s.host) {
      this.createRoom(o.hs, o.mode, o.boundary, o.md, o.tag, s.room, s.role);
    } else {
      this.joinRoom(s.room, null, s.role || 'seeker', true);
    }
    // Provisional. A reload mid-hunt should drop the player straight back in,
    // but an app that was simply closed and reopened later should not open on
    // a dead lobby. watchdog() keeps the room only if somebody is still there.
    this.resumed = true;
  }

  // --- KEEP THE SCREEN AWAKE ---
  // A locked phone stops running the page: no position goes out, the database
  // drops the player, and 35 seconds later everyone is told the hider has gone.
  // Hold a screen wake lock for as long as the player is in a room. The browser
  // releases it whenever the page is hidden, so it is taken again on return.
  async acquireWakeLock() {
    if (!('wakeLock' in navigator)) { this.wakeLockFailed = true; return; }
    if (this.wakeLock || document.visibilityState !== 'visible') return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      // The player may have left while the request was pending.
      if (!this.roomCode) { try { lock.release(); } catch (e) {} return; }
      this.wakeLock = lock;
      this.wakeLockFailed = false;
      lock.addEventListener('release', () => { if (this.wakeLock === lock) this.wakeLock = null; });
    } catch (e) {
      this.wakeLockFailed = true;
    }
    this.updateLobbyList();
  }

  releaseWakeLock() {
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (lock) { try { lock.release(); } catch (e) {} }
  }

  // Coming back to the app after a lock, a call or an app switch: take the
  // wake lock again and announce ourselves at once rather than on the next tick.
  initLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !this.roomCode) return;
      this.acquireWakeLock();
      this.sendHeartbeat();
      this.refreshTransportStatus();
    });
  }

  // Firebase's server clock, in this phone's terms. Falls back to the local
  // clock until the database has reported an offset.
  serverNow() {
    return Date.now() + (this.serverOffset || 0);
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
      text = `Connected — ${peers} direct link${peers === 1 ? '' : 's'}${this.rtdbConnected ? ' + cloud' : ''} · room ${this.roomCode}`
        + (relayOk ? '' : ' (relay unavailable, not needed)');
    } else if (relayOk) {
      text = this.rtdbConnected
        ? `Cloud sync active · room ${this.roomCode}`
        : `Looking for other devices… · room ${this.roomCode}`;
    } else {
      text = `No connection to other devices · room ${this.roomCode}`;
    }
    if (homeLabel) homeLabel.innerText = text;

    // Only alarm when BOTH transports are down — a blocked relay alone is fine.
    if (banner) {
      if (peers === 0 && !relayOk) {
        banner.innerText = 'Cannot reach other devices'
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

    // 1. Clear existing timers
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.lastCloudMessageAt = Date.now();
    this.syncFailCount = 0;

    // 2. WebRTC direct link — the low-latency path, updated on every GPS tick.
    this.initPeerSync();

    // 3. Firebase Realtime Database — the reliable path. Works on any network
    //    and survives a phone changing network mid-game.
    this.initRtdbSync();

    // 4. Keep dialling the host until the direct link is up, and republish our
    //    own state on a steady tick.
    this.heartbeatInterval = setInterval(() => {
      if (!this.isRoomHost) this.ensureHostConnection();
      this.sendHeartbeat();
      this.refreshTransportStatus();
      this.saveSession();
      this.watchdog();
      // Keeps the lobby honest when nothing else is arriving: a host alone in
      // the room, or a player who has dropped off the roster.
      if (this.gameState === 'lobby') this.updateLobbyList();
    }, 3000);

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

      // Discovery MUST NOT depend on a relay. v2.5.10 made the relay the only
      // way to learn the host's peer id, so when that relay went unreachable no
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
        this.lastPeerError = type || (err && err.message) || 'unknown';

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
  // is the likeliest reason a match froze mid-game. P2P stays as the
  // low-latency fast path; this is the one that always gets through.
  initRtdbSync() {
    if (!this.roomCode) return;
    if (typeof firebase === 'undefined' || !window.FIREBASE_CONFIG) return;

    try {
      if (!firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(window.FIREBASE_CONFIG);
      }
      this.rtdb = firebase.database();
      this.lastRtdbError = null;
    } catch (e) {
      this.rtdb = null;
      this.lastRtdbError = 'init: ' + (e && e.message ? e.message : e);
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
      // ...and if it is the host's phone, the event log goes too. Player entries
      // clear themselves this way, but the log had no owner, so a room everyone
      // simply closed the app on was left in the database for good.
      if (this.isRoomHost) { try { this.rtdbEventsPushRef.onDisconnect().remove(); } catch (e) {} }

      const onPlayer = (snap) => {
        const p = snap.val();
        if (!p || !p.id || p.id === this.playerId) return;
        // A node left behind by a phone that died is not a live player. Its
        // server timestamp says how long ago it was written, so anything
        // silent for 20s+ is ignored instead of being shown as present for
        // another 15s and, worse, mistaken for a live hider or host.
        if (this.serverOffsetKnown && p.ts && this.serverNow() - p.ts > 20000) return;
        this.lastCloudMessageAt = Date.now();
        this.handleCloudMessage({
          type: 'HEARTBEAT',
          senderId: p.id,
          peerId: p.peerId || null,
          round: p.round || null,
          player: p,
          headStartSeconds: p.headStartSeconds,
          boundaryRadius: p.boundaryRadius,
          matchDurationSeconds: p.matchDurationSeconds,
          tagRadiusFeet: p.tagRadiusFeet
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
        // onDisconnect is spent every time the connection drops, so it has to
        // be registered again on each reconnect — otherwise only the first
        // blip ever cleaned up after itself. Then reappear straight away.
        if (this.rtdbConnected && this.rtdbMyRef) {
          try { this.rtdbMyRef.onDisconnect().remove(); } catch (e) {}
          if (this.isRoomHost && this.rtdbEventsPushRef) { try { this.rtdbEventsPushRef.onDisconnect().remove(); } catch (e) {} }
          this.sendHeartbeat();
        }
        this.refreshTransportStatus();
      });

      this.rtdb.ref('.info/serverTimeOffset').on('value', (s) => {
        const off = Number(s.val());
        if (isFinite(off)) { this.serverOffset = off; this.serverOffsetKnown = true; }
      });

      // Appear in the room now, not on the next 3s tick.
      this.sendHeartbeat();
    };

    // Attach IMMEDIATELY — never gate the room on a server round-trip.
    //
    // This used to be `remove().then(attach)` for the host, so the host's
    // listeners and its own player node waited on a write acknowledgement from
    // Google. On a weak signal at the moment of room creation that promise can
    // take a long time or never settle at all, and the host then sat there for
    // the entire session invisible in the database and subscribed to nothing —
    // leaving WebRTC as the only way in, which is why joining "took a while".
    attach();

    // Ask the server once who is actually in this room. A joiner who mistyped
    // the code, or whose host has gone, used to sit in a healthy-looking lobby
    // for 25 seconds; with a definite answer from the database that can be
    // settled in a few. roomProbe stays null if the question never gets
    // answered (no signal), and the slower fallback in watchdog() applies.
    this.roomProbe = null;
    if (!this.isRoomHost) {
      const probedCode = this.roomCode;
      try {
        this.rtdb.ref(`${base}/players`).once('value').then((snap) => {
          if (this.roomCode !== probedCode) return;
          let hostFound = false;
          const now = this.serverNow();
          snap.forEach((child) => {
            const v = child.val() || {};
            // Without a known server clock the age test cannot be trusted, so
            // any host entry counts and the benefit of the doubt goes to the room.
            if (v.host && (!this.serverOffsetKnown || !v.ts || now - v.ts < 20000)) hostFound = true;
          });
          this.roomProbe = { at: Date.now(), hostFound };
        }).catch(() => {});
      } catch (e) {}
    }

    if (this.isRoomHost) {
      // Clear leftovers in the background instead. Never touch our own node and
      // never remove a player who is currently alive — only genuinely stale
      // entries from an earlier session that happened to reuse this code.
      try {
        this.rtdb.ref(`${base}/events`).remove().catch(() => {});
        this.rtdb.ref(`${base}/players`).once('value').then((snap) => {
          const cutoff = Date.now() - 60000;
          snap.forEach((child) => {
            if (child.key === this.playerId) return;
            const v = child.val() || {};
            if (!v.ts || v.ts < cutoff) child.ref.remove().catch(() => {});
          });
        }).catch(() => {});
      } catch (e) {}
    }
  }

  rtdbPublishSelf(player, round) {
    if (!this.rtdbMyRef || !player) return;
    try {
      this.rtdbMyRef.set({
        id: this.playerId,
        name: this.playerName,
        role: this.role,
        host: !!this.isRoomHost,
        round: round || null,
        lat: player.lat,
        lng: player.lng,
        accuracy: player.accuracy,
        peerId: this.myPeerId || null,
        headStartSeconds: this.headStartSeconds,
        boundaryRadius: this.boundaryRadius,
        matchDurationSeconds: this.matchDurationSeconds,
        tagRadiusFeet: this.tagRadiusFeet,
        ts: firebase.database.ServerValue.TIMESTAMP
      }).catch((err) => {
        // Swallowing this hid rule rejections and offline writes completely.
        this.lastRtdbError = 'write: ' + (err && err.message ? err.message : err);
        this.refreshTransportStatus();
      });
    } catch (e) {}
  }

  rtdbPublishEvent(data) {
    if (!this.rtdbEventsPushRef) return;
    try {
      this.rtdbEventsPushRef.push(data).catch((err) => {
        this.lastRtdbError = 'event: ' + (err && err.message ? err.message : err);
        this.refreshTransportStatus();
      });
    } catch (e) { this.lastRtdbError = 'event: ' + e.message; }
  }

  teardownRtdbListeners() {
    try {
      if (this.rtdbPlayersRef) this.rtdbPlayersRef.off();
      if (this.rtdbEventsRef) this.rtdbEventsRef.off();
      if (this.rtdb) {
        this.rtdb.ref('.info/connected').off();
        this.rtdb.ref('.info/serverTimeOffset').off();
      }
    } catch (e) {}
    this.rtdbPlayersRef = null;
    this.rtdbEventsRef = null;
  }

  teardownRtdb() {
    // The host owns the room node. Remove the whole thing on the way out so
    // rooms/<CODE> and its event log do not accumulate in the database forever
    // — nothing else prunes them and there is no TTL.
    // Deferred a moment so the ROOM_CLOSED event pushed just before this has
    // reached everyone still in the lobby before the node it lives in vanishes.
    if (this.isRoomHost && this.rtdb && this.roomCode) {
      const db = this.rtdb;
      const code = this.roomCode;
      setTimeout(() => {
        try { db.ref(`rooms/${code}`).remove().catch(() => {}); } catch (e) {}
      }, 2500);
    }

    this.teardownRtdbListeners();
    try {
      if (this.rtdbMyRef) {
        this.rtdbMyRef.onDisconnect().cancel();
        const removed = this.rtdbMyRef.remove();

        // Last one out removes the room. When a host's phone died instead of
        // leaving, whoever stayed kept the room alive and nothing ever cleared
        // it — which is how empty rooms piled up in the database.
        if (!this.isRoomHost && this.rtdb && this.roomCode) {
          const db = this.rtdb;
          const code = this.roomCode;
          removed.then(() => db.ref(`rooms/${code}/players`).once('value'))
            .then((snap) => { if (!snap.exists()) return db.ref(`rooms/${code}`).remove(); })
            .catch(() => {});
        }
      }
    } catch (e) {}
    this.rtdbMyRef = null;
    this.rtdbEventsPushRef = null;
    this.rtdbPrimed = false;
    this.rtdbConnected = false;
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


  // includeCloud=false sends only over the P2P DataChannel. GPS ticks use that
  // path: they fire several times a second, and writing each one to the
  // database would be needless traffic when the direct link is instant.
  sendHeartbeat(includeCloud = true) {
    if (!this.roomCode || this.isSoloDrill) return;

    // Only ever a real fix. A phone that has none sends no position at all, and
    // the other phones say so instead of measuring to a made-up point.
    const pos = this.hasGpsFix ? this.myPosition : null;

    // Spectators are not on the field and must never broadcast a position —
    // that would drop a phantom player on the map and stretch everyone's view
    // to fit it.
    const isSpectator = (this.role === 'spectator');

    const data = {
      type: 'HEARTBEAT',
      senderId: this.playerId,
      timestamp: Date.now(),
      roundId: this.currentRoundId,
      peerId: this.myPeerId || null,
      round: this.roundSnapshot(),
      player: {
        id: this.playerId,
        name: this.playerName,
        role: this.role,
        host: !!this.isRoomHost,
        lat: isSpectator ? null : (pos ? pos.lat : null),
        lng: isSpectator ? null : (pos ? pos.lng : null),
        accuracy: isSpectator ? null : (pos ? (pos.accuracy || 25) : null)
      },
      headStartSeconds: this.headStartSeconds,
      boundaryRadius: this.boundaryRadius,
      matchDurationSeconds: this.matchDurationSeconds,
      tagRadiusFeet: this.tagRadiusFeet
    };

    // 1. Send directly over WebRTC Peer-to-Peer DataChannel (0ms delay, 0 rate limits)
    this.broadcastPeer(data);

    // 2. Publish to the database — throttled, unlike the P2P path.
    if (!includeCloud) return;
    this.rtdbPublishSelf(data.player, data.round);
  }

  // What round is in progress, in terms a device that was not there for the
  // start can act on. Every player publishes this beside their position, so a
  // phone that reloads, or joins late, can pick the hunt up where it stands.
  // All times are in server time.
  roundSnapshot() {
    if (this.isSoloDrill || !this.currentRoundId) return null;
    if (this.gameState !== 'headstart' && this.gameState !== 'active') return null;
    return {
      id: this.currentRoundId,
      st: this.gameState,
      hs: this.headStartStartTime || null,
      as: this.activeSinceServer || null,
      yc: this.yardCenterPos ? { lat: this.yardCenterPos.lat, lng: this.yardCenterPos.lng } : null
    };
  }

  // Adopt a round that started while this device was not in it: a reload, a
  // rejoin, or a late arrival. Only ever from a lobby, only once per round.
  maybeCatchUp(data) {
    const r = data && data.round;
    if (!r || !r.id || !r.st) return;
    if (this.gameState !== 'lobby' || !this.roomCode || this.isSoloDrill) return;
    if (this.seenRoundIds[r.id]) return;
    if (r.st !== 'headstart' && r.st !== 'active') return;

    this.seenRoundIds[r.id] = true;
    this.currentRoundId = r.id;
    this.taggedHiderIds = {};
    this.appliedTagByRound = {};
    this.matchTrackHistory = [];
    if (r.yc) this.yardCenterPos = { lat: r.yc.lat, lng: r.yc.lng };
    this.hiderLastSeenAt = Date.now();
    this.seekerLastSeenAt = Date.now();
    this.resumed = false;

    // Rejoining the round this phone was already in: anything spent stays spent.
    const pu = this.resumePowerups;
    this.resumePowerups = null;
    if (pu && pu.round === r.id) {
      this.powerups.decoyUsed = !!pu.decoy;
      this.powerups.smokeUsed = !!pu.smoke;
      this.powerups.bearingPingUsed = !!pu.bearing;
    }

    const info = {
      roundId: r.id,
      headStartStartTime: r.hs || null,
      headStartSeconds: this.headStartSeconds,
      yardCenterPos: this.yardCenterPos,
      activeSince: r.as || null
    };

    if (r.st === 'headstart') {
      this.gameState = 'headstart';
      this.handleGameStateChange('headstart', info);
    } else {
      this.gameState = 'active';
      this.enterRoundScreen();
      this.handleGameStateChange('active', info);
    }
  }

  // Everyone in a round is looking at the screen for their role.
  enterRoundScreen() {
    if (this.role === 'hider') {
      this.showScreen('hider-screen');
    } else if (this.role === 'seeker') {
      this.showScreen('seeker-screen');
    } else if (this.role === 'spectator') {
      this.showScreen('spectator-screen');
      // Open on the yard. With no centre given the map fell back to its
      // built-in default and showed a city on the other side of the country
      // for the whole of the hiding time.
      const yc = this.yardCenterPos;
      if (yc && yc.lat && yc.lng) window.hotspotReplay.initMap('spectator-map', [yc.lat, yc.lng], 18);
      else window.hotspotReplay.initMap('spectator-map');
      this.updateSpectatorBoard(true);
    }
  }

  // The spectator's "Live Field Stats" card. It was an empty box: nothing ever
  // wrote to it. One line per player on the field, with each seeker's distance
  // to the hider — a spectator is the one person allowed to see that.
  updateSpectatorBoard(force = false) {
    const el = document.getElementById('spectator-leaderboard');
    if (!el) return;
    const now = Date.now();
    if (!force && this.lastBoardAt && now - this.lastBoardAt < 1000) return;
    this.lastBoardAt = now;

    const field = Object.values(this.players).filter(p => p && (p.role === 'hider' || p.role === 'seeker'));
    const hider = this.getActiveHider();
    const hasPos = (p) => !!(p && p.lat && p.lng);

    const rows = field
      .sort((a, b) => (a.role === 'hider' ? -1 : 0) - (b.role === 'hider' ? -1 : 0))
      .map((p) => {
        let right;
        if (!hasPos(p)) right = 'No GPS';
        else if (p.role === 'hider') right = 'Hiding';
        else if (hasPos(hider)) {
          const d = window.hotspotGeo.calculateDistance(p.lat, p.lng, hider.lat, hider.lng);
          right = d > 300 ? `${Math.round(d / 3)} yd` : `${Math.round(d)} ft`;
        } else right = '—';
        return `
          <div class="player-badge ${p.role}">
            <span class="badge-name">${window.hsEscape(p.name)}</span>
            <span class="badge-role">${right}</span>
          </div>`;
      });

    el.innerHTML = rows.join('') || '<div class="roster-empty">Waiting for players…</div>';
  }

  // Runs on the 3s tick. Two people hold a room together — the host and the
  // hider — and neither disappearing used to be noticed. The roster forgets
  // anyone silent for 15s, so the old "hider lost for 35s" check never had a
  // hider left to time out and seekers sat on NO SIGNAL indefinitely.
  watchdog() {
    if (!this.roomCode || this.isSoloDrill) return;
    const now = Date.now();
    const inRoomFor = now - this.joinTime;

    if (this.gameState === 'lobby') {
      // A session restored at launch. If the room turns out to be empty, the
      // player closed the app and came back later: go home quietly rather than
      // parking them in a dead lobby and popping an alert about a code they
      // never typed.
      if (this.resumed && inRoomFor > 8000) {
        const others = Object.keys(this.players).filter(id => id !== this.playerId).length;
        const dead = this.isRoomHost ? others === 0 : !this.hostSeenAt;
        if (dead) {
          this.showScreen('home-screen');
          try { this.leaveRoom(); } catch (e) {}
          const label = document.getElementById('cloud-sync-status');
          if (label) label.innerText = 'LAST ROOM ENDED';
          return;
        }
        this.resumed = false;
      }

      if (this.isRoomHost) return;

      // The database has said definitively that nobody is hosting this code.
      const probedEmpty = this.roomProbe && !this.roomProbe.hostFound;
      if (!this.hostSeenAt && ((probedEmpty && inRoomFor > 8000) || inRoomFor > 25000)) {
        this.abandonRoom('NO HOST FOUND', 'Nobody is hosting that code.\n\nCheck the code with the host, or ask them to start a new hunt.');
      } else if (this.hostSeenAt && now - this.hostSeenAt > 45000) {
        this.abandonRoom('HOST LEFT', 'The host is no longer in this room.\n\nAsk them to start a new hunt and share the new code.');
      }
      return;
    }

    if (this.gameState !== 'headstart' && this.gameState !== 'active') {
      this.hiderSilentMs = 0;
      return;
    }

    // The hider's side of the same check. With the only seeker gone the hider
    // used to stay hidden for the rest of the clock with nobody looking.
    if (this.role === 'hider') {
      const lastSeeker = this.seekerLastSeenAt || now;
      if (now - lastSeeker > 35000) {
        // Not quiet: anyone watching should hear that the hunt is off.
        this.abandonRoom('NO SEEKERS LEFT', 'Nobody has been chasing you for over 35 seconds. Hunt canceled.', false);
      }
      return;
    }

    const last = this.hiderLastSeenAt || now;
    this.hiderSilentMs = now - last;

    if (this.hiderSilentMs > 35000) {
      this.abandonRoom('HIDER DISCONNECTED', 'Hider signal was lost for over 35 seconds. Hunt canceled.');
    } else if (this.hiderSilentMs > 18000) {
      if (!this.hiderWarnSpoken) {
        this.hiderWarnSpoken = true;
        window.hotspotAudio.speak('Warning! Hider connection lost. Waiting for signal.');
      }
    } else {
      this.hiderWarnSpoken = false;
    }
  }

  // Tell the player why they are being sent home, then actually send them.
  abandonRoom(headline, detail, quiet = true) {
    this.stopPulseLoop();
    if (this.headStartTimer) { clearInterval(this.headStartTimer); this.headStartTimer = null; }
    this.showScreen('home-screen');
    // Quiet by default: in most cases the room is already over for everyone,
    // so there is nobody left to announce a departure to.
    try { this.leaveRoom({ quiet }); } catch (e) {}
    this.updateSeasonStatsDisplay();
    try { window.hotspotAudio.speak(headline.charAt(0) + headline.slice(1).toLowerCase() + '.'); } catch (e) {}
    alert(`${headline}\n\n${detail}`);
  }

  // Game settings off the wire. Each is accepted only as a sane number, and 0 is
  // allowed where it means "none".
  adoptSettings(data) {
    if (!data) return;
    const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
    const hs = num(data.headStartSeconds);
    const b = num(data.boundaryRadius);
    const md = num(data.matchDurationSeconds);
    const tag = num(data.tagRadiusFeet);
    if (hs !== null && hs > 0) this.headStartSeconds = hs;
    if (b !== null && b >= 0) this.boundaryRadius = b;
    if (md !== null && md >= 0) this.matchDurationSeconds = md;
    if (tag !== null && tag > 0) this.tagRadiusFeet = tag;
  }

  // Everything that has to be clean at the moment a round begins, on whichever
  // phone it begins. The replay used to include each player's wandering around
  // the lobby, because their own track was never cleared between rounds.
  beginRoundBookkeeping() {
    this.matchTrackHistory = [];
    this.tagEvent = null;
    this.taggedHiderIds = {};
    this.appliedTagByRound = {};
    this.decoyPos = null;
    this.outOfBoundsSpoken = false;
    this.hiderLastSeenAt = Date.now();
    this.seekerLastSeenAt = Date.now();
    this.hiderSilentMs = 0;
    this.hiderWarnSpoken = false;
    this.resumed = false;
  }

  broadcastCloud(data) {
    if (!this.roomCode || this.isSoloDrill) return;
    data.senderId = this.playerId;
    data.timestamp = Date.now();

    // Direct link for speed, database so devices without a peer link still get it.
    this.broadcastPeer(data);
    this.rtdbPublishEvent(data);
  }


  handleCloudMessage(data) {
    if (!data || data.senderId === this.playerId) return;

    // Heartbeats update rosters and positions. They never change game state.
    if (data.type === 'HEARTBEAT' || data.type === 'PLAYER_JOIN' || data.type === 'PLAYER_UPDATE') {
      const p = data.player;
      if (p && p.id) {
        this.players[p.id] = { ...this.players[p.id], ...p, lastSeen: Date.now() };

        if (p.host) this.hostSeenAt = Date.now();
        if (p.role === 'hider') this.hiderLastSeenAt = Date.now();
        if (p.role === 'seeker') this.seekerLastSeenAt = Date.now();

        if (p.role === 'hider') {
          // Everyone who is not the hider dials the hider, forming the mesh hub.
          if (this.role !== 'hider' && data.peerId) {
            this.connectToPeerId(data.peerId);
          }
        }
        const activeHider = this.getActiveHider();
        this.hiderId = activeHider ? activeHider.id : null;

        // The host chose these, so only the host's heartbeat sets them. Every
        // heartbeat carries its sender's copy, and letting any phone overwrite
        // the rest made the settings last-writer-wins: a phone holding a stale
        // or default value could quietly change the match length for everyone.
        // Tested by type, not truthiness: 0 is a real setting ("no time limit",
        // "no boundary") and used to be thrown away here.
        if (p.host) this.adoptSettings(data);

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

        this.maybeCatchUp(data);
        this.updateLobbyList();
      }
      return;
    }

    if (data.type === 'ROOM_CLOSED') {
      // The host leaving closes the room for everyone, whatever stage it is at.
      // It used to be announced only in the lobby, so a host who left from the
      // result screen let the others "rematch" into a room that threw them out
      // 40 seconds later.
      if (!this.roomCode || this.isRoomHost || this.isSoloDrill) return;
      const who = data.name || 'The host';

      if (this.gameState === 'gameover') {
        // Still reading the result: leave the room quietly and keep the screen.
        try { this.leaveRoom(); } catch (e) {}
        const rematchBtn = document.getElementById('btn-rematch');
        if (rematchBtn) rematchBtn.style.display = 'none';
        const wait = document.getElementById('rematch-wait');
        if (wait) { wait.style.display = 'block'; wait.innerText = `${who} closed the room — no rematch`; }
        return;
      }

      this.abandonRoom('HOST LEFT', `${who} closed the room.\n\nAsk them to start a new hunt and share the new code.`);
      return;
    }

    if (data.type === 'PLAYER_LEFT') {
      // Someone walked away mid-hunt. Take them off the board now rather than
      // 15 seconds from now, and if that was the last seeker, tell the hider.
      if (!this.roomCode || !data.id || data.id === this.playerId) return;
      if (!this.players[data.id]) return;
      delete this.players[data.id];
      if (this.gameState !== 'headstart' && this.gameState !== 'active') { this.updateLobbyList(); return; }

      if (this.role === 'hider') {
        const seekersLeft = Object.values(this.players).some(p => p && p.role === 'seeker');
        if (!seekersLeft) {
          this.abandonRoom('NO SEEKERS LEFT', `${data.name || 'The last seeker'} left the hunt, so nobody is chasing you.\n\nHunt canceled.`, false);
        }
      } else {
        window.hotspotAudio.speak(`${data.name || 'A player'} left the hunt.`);
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

      // The start message is the authoritative statement of this round's rules.
      this.adoptSettings(data);
      this.beginRoundBookkeeping();

      this.currentRoundId = data.roundId;
      this.gameState = 'headstart';
      this.handleGameStateChange('headstart', data);
      return;
    }

    if (data.type === 'HIDER_READY_EARLY') {
      // Only ever moves a phone from hiding time to live, and only for the
      // round it is actually in. It used to be accepted from the lobby too,
      // where a copy arriving late (every event travels twice, once per
      // transport) could flip a phone to "live" with no round and no screen.
      // A phone that missed the start picks the round up from heartbeats.
      if (this.gameState !== 'headstart') return;
      if (data.roundId && this.currentRoundId && data.roundId !== this.currentRoundId) return;
      this.gameState = 'active';
      this.handleGameStateChange('active', data);
      return;
    }


    if (data.type === 'HIDER_ABANDONED') {
      if (this.roomCode && (this.gameState === 'active' || this.gameState === 'headstart')) {
        this.abandonRoom('HIDER LEFT THE HUNT', `${data.name || 'The hider'} left, so this hunt is over.`);
      }
      return;
    }

    if (data.type === 'TAG') {
      this.applyTag(data);
      return;
    }

    if (data.type === 'REMATCH') {
      // Tied to the round it concludes. A second copy landing after the next
      // round had begun used to drag that phone back to the lobby mid-hunt.
      if (data.roundId && this.currentRoundId && data.roundId !== this.currentRoundId) return;
      if (data.roundId && !this.currentRoundId) return;
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
      btn.innerText = speechEnabled ? 'Voice' : 'Muted';
    }
  }

  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');
  }

  // --- SOLO DRILL MODE ---
  startSoloDrill() {
    if (this.roomCode) { try { this.leaveRoom({ quiet: true }); } catch (e) {} }

    this.isSoloDrill = true;
    this.roomCode = 'SOLO';
    this.role = 'seeker';
    this.gameState = 'active';
    this.gameStartTime = Date.now();
    this.beginRoundBookkeeping();
    this.acquireWakeLock();

    // The drill has to work on a couch with no GPS at all. Without a fix, stand
    // on the built-in practice point; if a real fix turns up mid-drill the
    // virtual hider is re-planted around it (see onGpsUpdate).
    if (!this.hasGpsFix) {
      const fallback = window.hotspotGeo.currentPosition;
      this.myPosition = { lat: fallback.lat, lng: fallback.lng, accuracy: 15, timestamp: Date.now(), simulated: true };
    }

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
    if (counter) counter.innerText = 'SOLO DRILL';
    // There is no match clock in a drill; the cell used to sit on "MATCH 5:00".
    const clock = document.getElementById('match-timer-seeker');
    if (clock) clock.innerText = 'NO CLOCK';
    this.setPowerupButtons(true);

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
  createRoom(headStartSec = 60, mode = 'classic', boundaryFeet = 250, matchDurationSec = 300, tagRadiusFeet = 20, resumeCode = null, resumeRole = null) {
    // Fully leave whatever room we were in. Without this the previous room's
    // roster, database listeners and player node all survived into the new one,
    // which is why players from the last game kept showing up under a new code.
    if (this.roomCode) { try { this.leaveRoom(); } catch(e) {} }

    // `parseInt(x) || default` turned a deliberate 0 into the default, so "No
    // Time Limit" quietly became 5 minutes and "No Boundary Limit" 250 feet.
    const whole = (v, fallback) => { const n = parseInt(v, 10); return isNaN(n) || n < 0 ? fallback : n; };

    this.isSoloDrill = false;
    this.headStartSeconds = whole(headStartSec, 60) || 60;
    this.boundaryRadius = whole(boundaryFeet, 250);          // 0 = no boundary
    this.gameMode = 'classic';
    this.matchDurationSeconds = whole(matchDurationSec, 300); // 0 = no time limit
    this.tagRadiusFeet = whole(tagRadiusFeet, 20) || 20;
    // resumeCode: a host whose page reloaded takes its own room back rather than
    // abandoning it and leaving everyone else stranded under the old code.
    this.roomCode = resumeCode || this.generateRoomCode();
    this.isRoomHost = true;   // owns the well-known peer id for this room
    this.hostIdRetries = 0;
    this.joinTime = Date.now();
    this.hostSeenAt = Date.now();
    this.hiderLastSeenAt = 0;
    this.currentRoundId = null;
    this.seenRoundIds = {};
    this.taggedHiderIds = {};
    this.appliedTagByRound = {};
    this.role = resumeRole || 'hider';
    this.hiderId = this.role === 'hider' ? this.playerId : null;
    this.gameState = 'lobby';
    this.resumed = false;

    const pos = this.hasGpsFix ? this.myPosition : null;

    this.players = {
      [this.playerId]: {
        id: this.playerId,
        name: this.playerName,
        role: this.role,
        lat: pos ? pos.lat : null,
        lng: pos ? pos.lng : null
      }
    };

    this.enterLobby();

    this.initCloudSync();
    this.saveSession();
    this.acquireWakeLock();

    if (!resumeCode) window.hotspotAudio.speak(`Hunt created. Code is ${this.roomCode.split('').join(' ')}`);
  }

  // Show the lobby, THEN draw it. The roster only draws while the lobby is on
  // screen, and it used to be drawn first — so a host alone in a new room saw
  // an empty list (not even themselves) until somebody else's heartbeat arrived.
  enterLobby() {
    const codeEl = document.getElementById('lobby-code-display');
    if (codeEl) codeEl.innerText = this.roomCode;
    this.fillNameInputs();
    this.showScreen('lobby-screen');
    this.updateLobbyList();
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

  // quiet: leave without telling the room — used when the room is already over
  // for everyone (it was closed, or the hunt was cancelled) so there is nobody
  // to tell.
  leaveRoom(opts = {}) {
    const inRound = (this.gameState === 'headstart' || this.gameState === 'active');
    const announce = !opts.quiet && this.roomCode && !this.isSoloDrill;

    if (announce && inRound && this.role === 'hider') {
      this.broadcastCloud({
        type: 'HIDER_ABANDONED',
        roundId: this.currentRoundId,
        name: this.playerName
      });
    }

    // A seeker walking away mid-hunt. Without this the hider was never told
    // that the only person chasing them had gone home.
    if (announce && inRound && this.role === 'seeker') {
      this.broadcastCloud({ type: 'PLAYER_LEFT', id: this.playerId, name: this.playerName, role: this.role });
    }

    // The host leaving closes the room for everyone, at any stage. It was only
    // ever announced from the lobby, which left the others to discover a dead
    // room for themselves.
    if (announce && this.isRoomHost) {
      this.broadcastCloud({ type: 'ROOM_CLOSED', name: this.playerName });
    }

    // Leaving on purpose. A reload never gets here, which is exactly why the
    // saved session survives one and not the other.
    this.clearSession();
    this.releaseWakeLock();

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
    this.hostSeenAt = 0;
    this.hiderLastSeenAt = 0;
    this.hiderSilentMs = 0;
    this.hiderWarnSpoken = false;
    this.activeSinceServer = null;
    this.headStartStartTime = 0;
    this.isSoloDrill = false;
    this.gameState = 'lobby';
    // Back to a neutral role. It used to stick — a spectator kept the GPS
    // warning suppressed on the home screen, a hider stayed muted there.
    this.role = 'seeker';
    this.resumed = false;
    this.resumePowerups = null;
    this.roomProbe = null;
    this.seekerLastSeenAt = 0;
    this.yardCenterPos = null;
    // The solo drill's stand-in position must not outlive the drill.
    if (this.myPosition && this.myPosition.simulated) this.myPosition = null;
    this.players = {};
    this.hiderId = null;
    this.decoyPos = null;
    this.taggedHiderIds = {};
    this.appliedTagByRound = {};
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
    if (homeLabel) homeLabel.innerText = 'STANDBY';

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
    if (window.hotspotGeo.clearLagBuffers) window.hotspotGeo.clearLagBuffers();
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
      alert('Only the next Hider or a Spectator can start the rematch.');
      return;
    }
    // A host whose phone died never got to close the room. Don't rematch into it.
    if (!this.isRoomHost && this.hostSeenAt && Date.now() - this.hostSeenAt > 20000) {
      this.abandonRoom('HOST LEFT', 'The host is no longer in this room, so there is nobody to rematch with.\n\nStart a new hunt and share the new code.');
      return;
    }
    this.broadcastCloud({ type: 'REMATCH', roundId: this.currentRoundId });
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
    if (window.hotspotGeo.clearLagBuffers) window.hotspotGeo.clearLagBuffers();

    // Roles were already rotated locally when the tag landed; publish the new
    // one so every roster agrees before the next round starts.
    if (this.players[this.playerId]) this.players[this.playerId].role = this.role;

    const already = document.getElementById('lobby-screen');
    const wasInLobby = already && already.classList.contains('active');
    this.enterLobby();
    this.sendHeartbeat();
    this.saveSession();

    // Each rematch arrives twice (once per transport); say it once.
    if (!wasInLobby) window.hotspotAudio.speak(`Rematch ready. You are the ${this.role}.`);
  }

  // The Home button sits on every screen, one tap from ending things for the
  // whole group — and it used to act instantly. Ask first whenever leaving
  // would cost somebody else their game.
  goHome() {
    const inRound = (this.gameState === 'headstart' || this.gameState === 'active');
    const others = Object.keys(this.players).filter(id => id !== this.playerId).length;

    if (this.roomCode && !this.isSoloDrill) {
      let question = null;
      if (inRound && this.role === 'hider') {
        question = 'Leave the hunt?\n\nYou are the Hider — leaving ends the hunt for everyone.';
      } else if (inRound && this.isRoomHost) {
        question = 'Leave the hunt?\n\nYou are the host — leaving closes the room for everyone.';
      } else if (inRound) {
        question = 'Leave the hunt?';
      } else if (this.isRoomHost && others > 0) {
        question = 'Close the room?\n\nYou are the host — everyone else will be sent home.';
      }
      if (question && !confirm(question)) return;
    }

    this.showScreen('home-screen');
    try {
      this.leaveRoom();
    } catch(e) {}
    this.updateSeasonStatsDisplay();
  }

  resetSeasonRecords() {
    if (confirm('Start New Season?\n\nThis will reset your Total Hunts, Fastest Tag, and Longest Hide records back to zero.')) {
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

    if (!this.saveName(newName)) return;
    if (this.players[this.playerId]) {
      this.players[this.playerId].name = this.playerName;
    }

    this.sendHeartbeat();
    this.updateLobbyList();
    window.hotspotAudio.speak(`Name updated to ${newName}`);
  }

  joinRoom(code, nickname, role = 'seeker', resumed = false) {
    const cleanCode = code ? code.trim().toUpperCase() : '';
    if (cleanCode.length !== 6) {
      alert('Please enter the full 6-character room code from the host.');
      return;
    }
    // The generator never emits O, I, L, Z, 0, 1 or 2. Accepting them silently
    // dropped the player into an empty room that could never fill.
    if (!/^[ABCDEFGHJKMNPQRSTVWX3456789]{6}$/.test(cleanCode)) {
      alert('That is not a valid room code.\n\nCodes never contain O, I, L, Z, 0, 1 or 2 — check for a mistyped character.');
      return;
    }

    if (this.roomCode) { try { this.leaveRoom(); } catch(e) {} }

    this.isSoloDrill = false;
    this.roomCode = code.toUpperCase().trim();
    this.isRoomHost = false;
    this.joinTime = Date.now();
    this.hostSeenAt = 0;
    this.hiderLastSeenAt = 0;
    this.currentRoundId = null;
    this.seenRoundIds = {};
    this.taggedHiderIds = {};
    this.appliedTagByRound = {};
    if (nickname && nickname.trim()) this.saveName(nickname);
    this.role = role;
    this.gameState = 'lobby';
    this.resumed = false;

    const pos = (this.hasGpsFix && role !== 'spectator') ? this.myPosition : null;

    this.players = {
      [this.playerId]: {
        id: this.playerId,
        name: this.playerName,
        role: this.role,
        lat: pos ? pos.lat : null,
        lng: pos ? pos.lng : null
      }
    };

    // A spectator needs no location fix, so the GPS warning does not apply.
    if (role === 'spectator') {
      const warnBox = document.getElementById('gps-warning-banner');
      if (warnBox) warnBox.style.display = 'none';
    }

    this.enterLobby();

    this.initCloudSync();
    this.saveSession();
    this.acquireWakeLock();

    if (!resumed) window.hotspotAudio.speak(`Joined hunt ${this.roomCode.split('').join(' ')}`);
  }

  toggleRole() {
    if (this.gameState !== 'lobby') {
      alert('You can only switch roles in the lobby, before the round starts.');
      return;
    }
    if (this.role === 'spectator') return;

    const becomingHider = (this.role !== 'hider');

    // The game has exactly one hider. Nothing stopped two people claiming the
    // role at once, which left the roster showing two hiders and every seeker
    // measuring distance to whichever one it happened to pick.
    if (becomingHider) {
      const otherHider = this.getActiveHider();
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
    this.saveSession();
    this.updateLobbyList();
    window.hotspotAudio.speak(`You are now the ${this.role.toUpperCase()}`);
  }

  // Exactly one hider, chosen the same way on every device. Object key order is
  // not guaranteed, so `find(role === 'hider')` could hand two seekers two
  // different targets. When more than one player claims the role, the lowest
  // player id wins so all devices independently agree.
  getActiveHider() {
    const now = Date.now();
    const hiders = Object.values(this.players).filter(p =>
      p && p.role === 'hider' && (!p.lastSeen || now - p.lastSeen <= 15000)
    );
    if (hiders.length === 0) return null;
    if (hiders.length === 1) return hiders[0];
    return hiders.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  }

  // Tap the version badge to open this. When two phones cannot see each other
  // the useful facts live in state that is otherwise invisible on a phone with
  // no console attached.
  toggleDiagnostics() {
    const el = document.getElementById('diag-panel');
    if (!el) return;
    const showing = el.style.display === 'block';
    el.style.display = showing ? 'none' : 'block';
    if (this.diagTimer) { clearInterval(this.diagTimer); this.diagTimer = null; }
    if (!showing) {
      this.renderDiagnostics();
      this.diagTimer = setInterval(() => this.renderDiagnostics(), 1000);
    }
  }

  renderDiagnostics() {
    const el = document.getElementById('diag-body');
    if (!el) return;
    const now = Date.now();
    const roster = Object.values(this.players).map(p => {
      const age = p.lastSeen ? Math.round((now - p.lastSeen) / 1000) + 's' : 'self';
      return `${window.hsEscape(p.name || '?')} [${p.role || '?'}] ${age}`;
    });
    const row = (k, v, bad) =>
      `<div style="display:flex;justify-content:space-between;gap:10px;padding:2px 0;">
         <span style="opacity:.6">${k}</span>
         <span style="text-align:right;font-weight:700;color:${bad ? 'var(--bad)' : 'var(--ink)'}">${v}</span>
       </div>`;

    el.innerHTML =
      row('app version', 'v3.2.0') +
      (() => {
        // Straight from the stylesheet. If this disagrees with the app version
        // above, the phone is running cached CSS - provable, not a guess.
        let css = 'not loaded';
        try {
          css = (getComputedStyle(document.documentElement)
            .getPropertyValue('--css-version') || '').replace(/["']/g, '').trim() || 'missing';
        } catch (e) {}
        return row('stylesheet', css, css !== '3.2.0');
      })() +
      row('room', this.roomCode || '(none)', !this.roomCode) +
      row('am I host', this.isRoomHost ? 'yes' : 'no') +
      row('my role', this.role) +
      row('my id', this.playerId) +
      row('online', navigator.onLine ? 'yes' : 'NO', !navigator.onLine) +
      row('screen kept awake', this.wakeLock ? 'yes' : (this.roomCode ? 'NO' : '-'), !!this.roomCode && !this.wakeLock) +
      row('clock vs server', this.serverOffsetKnown ? Math.round(this.serverOffset) + 'ms' : 'unknown', Math.abs(this.serverOffset) > 5000) +
      row('hider silent', this.hiderSilentMs ? Math.round(this.hiderSilentMs / 1000) + 's' : '-', this.hiderSilentMs > 18000) +
      '<hr style="border:0;border-top:1px solid rgba(255,255,255,.12);margin:6px 0">' +
      row('database', this.rtdbConnected ? 'CONNECTED' : 'not connected', !this.rtdbConnected) +
      row('db node written', this.rtdbMyRef ? 'yes' : 'NO', !this.rtdbMyRef) +
      row('db error', this.lastRtdbError ? window.hsEscape(this.lastRtdbError) : 'none', !!this.lastRtdbError) +
      '<hr style="border:0;border-top:1px solid rgba(255,255,255,.12);margin:6px 0">' +
      row('peer registered', (this.peer && this.peer.open) ? 'yes' : 'NO', !(this.peer && this.peer.open)) +
      row('my peer id', this.myPeerId || '(none)') +
      row('host peer id', this.getHostPeerId() || '(none)') +
      row('direct links', this.peerCount(), this.peerCount() === 0) +
      row('peer error', this.lastPeerError ? window.hsEscape(this.lastPeerError) : 'none', !!this.lastPeerError) +
      '<hr style="border:0;border-top:1px solid rgba(255,255,255,.12);margin:6px 0">' +
      row('GPS accuracy', this.hasGpsFix ? '±' + Math.round(this.myPosition.accuracy) + 'ft' : 'NO FIX', !this.hasGpsFix) +
      row('players seen', roster.length) +
      `<div style="margin-top:4px;opacity:.75;word-break:break-word">${roster.join('<br>') || '(nobody)'}</div>`;
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
    const watchers = activePlayers.filter(p => p.role === 'spectator');

    const hiderContainer = document.getElementById('lobby-hider-list');
    const seekerContainer = document.getElementById('lobby-seeker-list');

    // A player with no location fix cannot be found or do any finding, and
    // nothing used to say so until the round was already broken.
    const noGps = (p) => (p.id === this.playerId) ? !this.hasGpsFix : !(p.lat && p.lng);
    const badge = (p, kind, label) => `
        <div class="player-badge ${kind}">
          <span class="badge-name">${window.hsEscape(p.name)}${p.id === this.playerId ? '<span class="badge-you">you</span>' : ''}</span>
          <span class="badge-role">${noGps(p) ? '<span class="badge-nogps">No GPS</span>' : ''}${label}</span>
        </div>
      `;

    if (hiderContainer) {
      hiderContainer.innerHTML = hidersList.map(p => badge(p, 'hider', 'Hider')).join('')
        || '<div class="roster-empty">Nobody is hiding yet</div>';
    }

    if (seekerContainer) {
      seekerContainer.innerHTML = seekersList.map(p => badge(p, 'seeker', 'Seeker')).join('')
        || '<div class="roster-empty">No seekers yet — share the room code</div>';
    }

    // Spectators were in the room but on nobody's list, including their own.
    const watchEl = document.getElementById('lobby-watchers');
    if (watchEl) {
      if (watchers.length) {
        watchEl.style.display = 'block';
        watchEl.innerText = 'Watching: ' + watchers.map(p => p.name + (p.id === this.playerId ? ' (you)' : '')).join(', ');
      } else {
        watchEl.style.display = 'none';
      }
    }

    // The role button says what it will do. A spectator is not on the field,
    // so there is nothing for it to switch.
    const roleBtn = document.getElementById('btn-switch-role');
    if (roleBtn) {
      roleBtn.style.display = this.role === 'spectator' ? 'none' : '';
      roleBtn.innerText = this.role === 'hider' ? 'Switch to Seeker' : 'Become the Hider';
    }

    const wakeNote = document.getElementById('lobby-wake-note');
    if (wakeNote) wakeNote.style.display = (this.wakeLockFailed && !this.wakeLock) ? 'block' : 'none';

    // Whoever is hiding (or a spectator) starts the round. Everyone else is told
    // exactly what they are waiting for — the old message said "Waiting for
    // Host (Hider)" even to the host, and even when nobody was hiding at all.
    const startBtn = document.getElementById('btn-start-round');
    const waitMsg = document.getElementById('lobby-wait-msg');
    const hider = this.getActiveHider();
    const searching = !this.isRoomHost && !this.hostSeenAt;
    const canStart = !searching && (this.role === 'hider' || this.role === 'spectator');

    if (startBtn) startBtn.style.display = canStart ? 'block' : 'none';
    if (waitMsg) {
      waitMsg.style.display = canStart ? 'none' : 'block';
      if (searching) waitMsg.innerText = 'Looking for this room…';
      else if (!hider) waitMsg.innerText = 'Nobody is hiding yet — tap "Become the Hider" to hide';
      else waitMsg.innerText = `Waiting for ${hider.name || 'the Hider'} to start the round`;
    }
  }

  // --- GAME START & HEADSTART TIMING ENGINE ---
  startHeadstart() {
    // A round can only begin from the lobby. This had no such check, and the
    // spectator map carried a Start button that stayed live during a hunt:
    // tapping it put that one phone into a private round of its own, where it
    // then missed the tag and never saw the result.
    if (this.gameState !== 'lobby' || !this.roomCode || this.isSoloDrill) return;

    if (this.role !== 'hider' && this.role !== 'spectator') {
      alert('Only the Hider or a Spectator can start the round.');
      return;
    }

    // A round with nobody hiding leaves every seeker on NO SIGNAL for the whole
    // match, and no yard centre means the boundary silently does not exist.
    const hiderNow = this.getActiveHider();
    if (!hiderNow) {
      alert('Nobody is the Hider yet.\n\nSomeone needs to tap "Become the Hider" in the lobby before the round can start.');
      return;
    }

    // ...and one with nobody seeking is the hider crouching behind a shed alone.
    const seekers = Object.values(this.players).filter(p => p && p.role === 'seeker');
    if (seekers.length === 0) {
      alert('No seekers have joined yet.\n\nShare the room code and wait for someone to appear under Seekers.');
      return;
    }

    // The hider is the one thing everybody measures to. Without a real fix
    // there is nothing to find and no yard centre to draw the boundary around.
    const hiderIsMe = hiderNow.id === this.playerId;
    const hiderHasFix = hiderIsMe ? this.hasGpsFix : !!(hiderNow.lat && hiderNow.lng);
    if (!hiderHasFix) {
      alert(hiderIsMe
        ? 'Your phone has no GPS fix yet.\n\nTurn Location on (tap the GPS line at the top), step outside, and wait for the "No GPS" tag next to your name to clear.'
        : `${hiderNow.name || 'The Hider'} has no GPS fix yet.\n\nWait for the "No GPS" tag next to their name to clear, then start.`);
      return;
    }

    this.beginRoundBookkeeping();

    // Server time, not this phone's clock: every device measures the countdown
    // against this stamp, and a phone whose clock is off would otherwise run it
    // early or late.
    const startTime = this.serverNow();
    this.headStartStartTime = startTime;

    // The yard centre must be the HIDER's start point, not whoever pressed
    // Start. When a spectating parent starts the round, using their own
    // position put the geofence on their chair instead of the play area.
    if (hiderIsMe) {
      this.yardCenterPos = { lat: this.myPosition.lat, lng: this.myPosition.lng };
    } else {
      this.yardCenterPos = { lat: hiderNow.lat, lng: hiderNow.lng };
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
      tagRadiusFeet: this.tagRadiusFeet,
      yardCenterPos: this.yardCenterPos
    });

    this.handleGameStateChange('headstart', {
      roundId: roundId,
      headStartStartTime: startTime,
      headStartSeconds: this.headStartSeconds,
      boundaryRadius: this.boundaryRadius,
      matchDurationSeconds: this.matchDurationSeconds,
      tagRadiusFeet: this.tagRadiusFeet,
      yardCenterPos: this.yardCenterPos
    });
  }

  hiderReadyEarly() {
    if (this.gameState !== 'headstart') return;

    if (this.headStartTimer) {
      clearInterval(this.headStartTimer);
      this.headStartTimer = null;
    }

    this.gameState = 'active';
    const activeSince = this.serverNow();
    this.broadcastCloud({ type: 'HIDER_READY_EARLY', roundId: this.currentRoundId, activeSince });
    this.handleGameStateChange('active', { activeSince });
  }

  handleGameStateChange(newState, roomData = null) {
    if (newState === 'headstart') {
      const startTime = (roomData && roomData.headStartStartTime) ? roomData.headStartStartTime : (this.headStartStartTime || this.serverNow());
      const duration = (roomData && roomData.headStartSeconds) ? roomData.headStartSeconds : this.headStartSeconds;
      if (roomData && roomData.yardCenterPos) this.yardCenterPos = roomData.yardCenterPos;
      this.headStartStartTime = startTime;
      this.activeSinceServer = null;
      this.hiderLastSeenAt = Date.now();

      this.enterRoundScreen();

      // No proximity information while the hider is still hiding. The radar
      // used to sit on a stale COLD/HOT reading during the countdown, which
      // leaks a hint before the hunt has even started.
      this.blankSeekerRadar();

      // The clock cells used to keep whatever the previous round ended on, so
      // round two's hiding time opened with "MATCH TIME: 0:00".
      this.setMatchClock(this.matchClockText(this.matchDurationSeconds));
      // Power-ups do nothing until the hunt is live, and tapping one during
      // hiding time used to spend it anyway.
      this.setPowerupButtons(false);
      // A spectator's map has to show the hiding time too, not just the hunt.
      if (this.role === 'spectator') this.startPulseLoop();

      window.hotspotAudio.speak(`Hider has ${duration} seconds to hide!`);

      if (this.headStartTimer) clearInterval(this.headStartTimer);

      this.headStartTimer = setInterval(() => {
        const elapsed = Math.floor((this.serverNow() - startTime) / 1000);
        const remaining = Math.max(0, duration - elapsed);
        this.headStartRemaining = remaining;

        document.querySelectorAll('.headstart-counter').forEach(el => {
          el.innerText = `HIDING TIME: ${remaining}s`;
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
            el.innerText = 'HUNT IS LIVE!';
          });
          if (hiderCounter) hiderCounter.innerText = 'LIVE!';

          window.hotspotAudio.playCountdownBeep(true);

          // The clock ran out by itself. The state itself has to change here as
          // well as the screen: this line used to call handleGameStateChange
          // alone, which left the hider's own device sitting in 'headstart' for
          // the whole hunt — no nearest-seeker readout, a match clock frozen on
          // its starting value, and no result screen when the match ended.
          // Seekers only escaped it because the hider's message flipped them.
          const activeSince = startTime + duration * 1000;
          if (this.gameState === 'headstart') {
            this.gameState = 'active';
            if (this.role === 'hider') {
              this.broadcastCloud({ type: 'HIDER_READY_EARLY', roundId: this.currentRoundId, activeSince });
            }
            this.handleGameStateChange('active', { activeSince });
          }
        }
      }, 1000);

    } else if (newState === 'active') {
      // One shared moment for "the hunt went live", in server time, so every
      // device counts the same match clock and a rejoining phone resumes it
      // part-way through instead of restarting it.
      this.activeSinceServer = (roomData && roomData.activeSince) || this.serverNow();
      this.gameStartTime = Date.now() - Math.max(0, this.serverNow() - this.activeSinceServer);
      if (this.hiderLastSeenAt === 0) this.hiderLastSeenAt = Date.now();
      if (this.headStartTimer) clearInterval(this.headStartTimer);

      document.querySelectorAll('.headstart-counter').forEach(el => el.innerText = 'HUNT LIVE');
      const hiderCounter = document.getElementById('hider-timer-display');
      if (hiderCounter) hiderCounter.innerText = 'LIVE!';

      const readyBtn = document.getElementById('btn-hider-ready');
      if (readyBtn) readyBtn.style.display = 'none';
      this.setPowerupButtons(true);

      // Said here so it is heard however the hunt went live — the clock running
      // out or the hider tapping "ready early" (which used to be silent for
      // seekers). The hider's own phone stays quiet.
      window.hotspotAudio.speak('Seekers released. The hunt is live!');

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
      const tag = (this.tagEvent && this.tagEvent.seekerName) ? this.tagEvent : null;
      if (headline) {
        if (tag) {
          headline.innerText = 'TAGGED!';
          headline.style.color = 'var(--heat-2)';
          // Said to each player in their own terms. This replaces a pop-up that
          // stopped the phone dead until it was dismissed.
          let line = `${tag.seekerName} caught ${tag.hiderName}`;
          if (this.isSoloDrill) line = 'Drill complete — you reached the virtual hider';
          else if (tag.seekerId === this.playerId) line = `You caught ${tag.hiderName} — you hide next round`;
          else if (tag.hiderId === this.playerId) line = `${tag.seekerName} caught you`;
          if (subhead) subhead.innerText = line;
        } else {
          headline.innerText = 'HIDER SURVIVED!';
          headline.style.color = 'var(--accent)';
          if (subhead) subhead.innerText = 'Time expired — nobody was caught';
        }
      }

      this.showScreen('replay-screen');
      if (window.hotspotReplay) {
        window.hotspotReplay.loadReplayData(this.matchTrackHistory, this.tagEvent, this.yardCenterPos);
        window.hotspotReplay.setBoundary(this.yardCenterPos, this.boundaryRadius);
      }
      // The replay opens on the finished picture, so the scrubber sits at the end.
      const slider = document.getElementById('replay-slider');
      if (slider) slider.value = 100;

      // Only the next hider (or a spectator) can start the rematch. Everyone
      // used to be shown the button, and most of them got an error for tapping it.
      const inRoom = !!this.roomCode && !this.isSoloDrill;
      const canRematch = inRoom && (this.role === 'hider' || this.role === 'spectator');
      const rematchBtn = document.getElementById('btn-rematch');
      if (rematchBtn) rematchBtn.style.display = canRematch ? 'block' : 'none';

      const wait = document.getElementById('rematch-wait');
      if (wait) {
        const activeHider = this.getActiveHider();
        const next = tag ? tag.seekerName : (activeHider && activeHider.name);
        wait.style.display = (inRoom && !canRematch) ? 'block' : 'none';
        wait.innerText = `Waiting for ${next || 'the next Hider'} to start a rematch`;
      }
    }
  }

  // --- small shared pieces of round UI ---
  matchClockText(remainingSec) {
    if (!this.matchDurationSeconds || this.matchDurationSeconds <= 0) return 'NO TIME LIMIT';
    const left = Math.max(0, Math.floor(remainingSec));
    return `MATCH TIME: ${Math.floor(left / 60)}:${(left % 60).toString().padStart(2, '0')}`;
  }

  setMatchClock(text) {
    ['match-timer-seeker', 'match-timer-hider', 'match-timer-spectator'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerText = text;
    });
  }

  // live=false greys all three out; live=true enables whichever are unspent.
  setPowerupButtons(live) {
    const flags = { 'btn-powerup-decoy': 'decoyUsed', 'btn-powerup-smoke': 'smokeUsed', 'btn-bearing-ping': 'bearingPingUsed' };
    Object.keys(flags).forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = !live || !!this.powerups[flags[id]];
    });
  }

  startMatchTimer() {
    if (this.matchTimer) clearInterval(this.matchTimer);
    if (!this.matchDurationSeconds || this.matchDurationSeconds <= 0) {
      this.setMatchClock('NO TIME LIMIT');
      return;
    }

    const matchStartTime = this.activeSinceServer || this.serverNow();

    this.matchTimer = setInterval(() => {
      if (this.gameState !== 'active') {
        clearInterval(this.matchTimer);
        this.matchTimer = null;
        return;
      }

      const elapsedSec = Math.floor((this.serverNow() - matchStartTime) / 1000);
      const remainingSec = Math.max(0, this.matchDurationSeconds - elapsedSec);

      this.setMatchClock(this.matchClockText(remainingSec));

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

    const survivedMs = this.roundDurationMs();

    // The result screen says this in its headline; the pop-ups that used to say
    // it as well froze the phone until dismissed.
    if (this.role === 'hider') {
      window.hotspotAudio.speak('Time is up. You survived and won the hunt!');
    } else {
      window.hotspotAudio.speak('Time is up. The hider escaped!');
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

  // Only ever called with a real fix from the phone.
  onGpsUpdate(pos) {
    const firstFix = !this.hasGpsFix;
    this.myPosition = pos;
    this.hasGpsFix = true;

    // A drill that began on the practice point: now that the phone knows where
    // it really is, plant the virtual hider around the real position instead
    // of leaving it a continent away.
    if (firstFix && this.isSoloDrill) {
      const geo = window.hotspotGeo;
      const dist = (geo.soloHiderPosition && geo.soloHiderPosition.currentDistFeet) || 300;
      const hp = geo.setSoloHiderDistance(dist);
      if (this.players['solo_hider']) { this.players['solo_hider'].lat = hp.lat; this.players['solo_hider'].lng = hp.lng; }
      if (geo.clearLagBuffers) geo.clearLagBuffers();
    }
    if (firstFix) this.updateLobbyList();

    document.querySelectorAll('.accuracy-tag').forEach(el => {
      el.innerText = `GPS: ±${Math.round(pos.accuracy)}ft`;
    });

    const warnBox = document.getElementById('gps-warning-banner');
    if (warnBox && this.role === 'spectator') {
      // Watching from a laptop with no GPS is a supported setup, not a fault.
      warnBox.style.display = 'none';
    } else if (warnBox) {
      if (pos.isProtocolWarning) {
        warnBox.innerText = 'Opened as local file — GPS requires HTTPS web server.';
        warnBox.style.display = 'block';
      } else if (pos.accuracy > 50) {
        warnBox.innerText = `Weak GPS Fix (±${Math.round(pos.accuracy)}ft) — Move out from under heavy tree canopy!`;
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

    // Tracks are for the replay, so only a round is recorded. This used to log
    // every step from the moment the app opened, and the replay began with the
    // player's walk to the yard.
    const inRound = (this.gameState === 'headstart' || this.gameState === 'active');
    if (inRound && this.role !== 'spectator') {
      this.recordTrackPoint(this.playerId, this.playerName, this.role, pos);
    }

    // Also run boundary feedback here, not just in the pulse loop — the hider is
    // moving during the hiding time, which is exactly when they stray.
    if (inRound) {
      this.updateBoundaryWarning();
    }

    // Push position over the P2P DataChannel on every GPS tick — free and
    // instant. With a direct link the database write is left to the 3s
    // interval; without one (two phones on cellular often cannot form a link)
    // the database is the ONLY path, so it gets a position once a second
    // instead of leaving the other phone on 3s-old data.
    if (this.roomCode && (this.gameState === 'headstart' || this.gameState === 'active')) {
      const now = Date.now();
      const cloudDue = this.peerCount() === 0 && now - this.lastCloudPosPush >= 1000;
      if (cloudDue) this.lastCloudPosPush = now;
      this.sendHeartbeat(cloudDue);
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

    warnBox.innerText = `Tap to Allow GPS Access: ${errMessage}`;
    warnBox.style.display = 'block';

    // Don't keep claiming a fix the phone does not have. The top bar used to
    // read "GPS: ±25ft" with location switched off entirely.
    if (!this.hasGpsFix) {
      document.querySelectorAll('.accuracy-tag').forEach(el => { el.innerText = 'GPS: OFF'; });
    }
  }

  recordTrackPoint(playerId, name, role, pos) {
    let track = this.matchTrackHistory.find(t => t.playerId === playerId);
    if (!track) {
      track = { playerId, name, role, points: [] };
      this.matchTrackHistory.push(track);
    } else {
      // Keep these current: a player who swaps role mid-session was drawn on
      // the replay in the colour of whatever they were when first seen.
      if (name) track.name = name;
      if (role) track.role = role;
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
  // ---- the anchor gauge -------------------------------------------------
  // 270-degree sweep, r=130 in a 340 box. Circumference 817, full track 613.
  // Fill grows as the seeker closes, so the instrument reads at a glance from
  // arm's length in the dark without reading a single word.
  setGauge(distFeet, color) {
    const arc = document.getElementById('gauge-arc');
    if (!arc) return;

    let pct = 0;
    if (typeof distFeet === 'number' && isFinite(distFeet)) {
      pct = Math.max(0, Math.min(1, 1 - (distFeet / 300)));
    }
    arc.setAttribute('stroke-dasharray', (613 * pct).toFixed(1) + ' 817');
    // A zero-length stroke with round caps still paints its cap, which left a
    // lone glowing dot at the foot of an empty gauge.
    arc.style.opacity = pct > 0.004 ? '1' : '0';

    // Drive the gradient stops so the arc itself heats up.
    const g1 = document.getElementById('hg1');
    const g2 = document.getElementById('hg2');
    if (color && g1 && g2) {
      const hi = { '#4C5BA8': '#9EC5FF', '#5B6BC0': '#9EC5FF' }[color] || color;
      document.getElementById('hg0').setAttribute('stop-color', color);
      g1.setAttribute('stop-color', color);
      g2.setAttribute('stop-color', hi === color ? '#FFFFFF' : hi);
    }
  }

  // Season dials: r=26, circumference 163. Every number gets a visual cue.
  setDial(id, pct, ) {
    const el = document.getElementById(id);
    if (!el) return;
    const v = Math.max(0, Math.min(1, pct || 0));
    el.setAttribute('stroke-dasharray', (163 * v).toFixed(1) + ' 164');
  }

  blankSeekerRadar() {
    this.currentBand = null;
    this.currentDistance = null;

    const bandLabel = document.getElementById('seeker-band-label');
    if (bandLabel) bandLabel.innerText = 'STAND BY';

    const distEl = document.getElementById('seeker-dist-readout');
    if (distEl) distEl.innerHTML = '';

    this.setGauge(null, '#7DD3FC');

    // Let the first real band of the round announce itself.
    if (window.hotspotAudio) {
      window.hotspotAudio.lastSpokenBand = null;
      window.hotspotAudio.lastAnnouncedBand = null;
    }
  }

  startPulseLoop() {
    if (this.pulseInterval) clearInterval(this.pulseInterval);

    this.pulseInterval = setInterval(() => {
      // Players only get readings once the hunt is live. A spectator's map
      // runs through the hiding time as well.
      const watching = (this.role === 'spectator' && this.gameState === 'headstart');
      if (this.gameState !== 'active' && !watching) return;
      if (!this.isSoloDrill) this.prunePlayers();
      this.updateProximityEngine();
    }, 250);
  }

  // Radar with nothing to show, and the reason why.
  showRadarNotice(label, detail) {
    const bandLabel = document.getElementById('seeker-band-label');
    const distEl = document.getElementById('seeker-dist-readout');
    if (bandLabel && !this.powerups.smokeActive) bandLabel.innerText = label;
    if (distEl) distEl.innerHTML = `<span class="dist-sub">${detail}</span>`;
    this.setGauge(null, '#7DD3FC');
    this.currentBand = null;
  }

  stopPulseLoop() {
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = null;
    }
  }

  updateProximityEngine() {
    // A spectator has no position of their own and does not need one.
    if (this.role === 'spectator') {
      window.hotspotReplay.updateSpectatorView(this.players);
      window.hotspotReplay.setBoundary(this.yardCenterPos, this.boundaryRadius);
      this.updateSpectatorBoard();
      return;
    }

    if (!this.myPosition) {
      // Say so, rather than leaving the radar on whatever it showed last.
      if (this.role === 'seeker') this.showRadarNotice('NO GPS', 'your phone has no location fix');
      if (this.role === 'hider') {
        const d = document.getElementById('hider-nearest-dist');
        if (d) d.innerText = 'NO GPS';
      }
      return;
    }

    if (this.role === 'seeker') {
      let hiderPos = null;
      let hiderPlayerForAcc = null;

      if (this.isSoloDrill) {
        hiderPos = window.hotspotGeo.soloHiderPosition;
      } else {
        const hiderPlayer = this.getActiveHider();
        hiderPlayerForAcc = hiderPlayer || null;
        if (hiderPlayer && hiderPlayer.lat) {
          hiderPos = { lat: hiderPlayer.lat, lng: hiderPlayer.lng };
        }

        // Hider-gone detection lives in watchdog(). It cannot live here: the
        // roster drops a silent hider after 15s, so by the time a 18s / 35s
        // threshold was reached there was no hider left in this loop to judge.
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
        if (hiderPos) {
          this.showRadarNotice('NO SIGNAL', `last fix ${Math.round(hiderFixAgeMs / 1000)}s ago`);
        } else if (this.hiderSilentMs > 18000) {
          this.showRadarNotice('HIDER OFFLINE', 'hider lost — hunt cancels in ' + Math.max(0, Math.ceil((35000 - this.hiderSilentMs) / 1000)) + 's');
        } else if (hiderPlayerForAcc) {
          // The hider is here and talking, but their phone has no location.
          this.showRadarNotice('NO GPS', 'the hider’s phone has no location fix');
        } else {
          this.showRadarNotice('NO SIGNAL', 'waiting for hider…');
        }
        return;
      }

      // Key the anti-snipe buffer by which target this actually is.
      const targetKey = this.decoyPos ? 'decoy' : (this.isSoloDrill ? 'solo' : 'hider');
      const bufferedHiderPos = window.hotspotGeo.getBufferedPosition(this.myPosition, hiderPos, targetKey);

      const distFeet = window.hotspotGeo.calculateDistance(
        this.myPosition.lat, this.myPosition.lng,
        bufferedHiderPos.lat, bufferedHiderPos.lng
      );

      this.currentDistance = distFeet;

      // How much of this reading is GPS noise? Both phones contribute error.
      // Not in a solo drill: the virtual hider is planted relative to wherever
      // this phone thinks it is, so the phone's own GPS error cancels out.
      // Applying it anyway meant that indoors — where the drill is meant to be
      // run — the reading was capped at WARM and "Tag Hider" could never fire.
      const hiderAcc = (hiderPlayerForAcc && hiderPlayerForAcc.accuracy) || 25;
      const marginFeet = this.isSoloDrill ? 0 : window.hotspotGeo.combinedAccuracy(
        this.myPosition.accuracy, hiderAcc
      );
      this.currentMargin = marginFeet;

      const bandInfo = window.hotspotGeo.getDistanceBand(distFeet, marginFeet, this.tagRadiusFeet);
      this.currentBand = bandInfo.band;

      const pulseRing = document.getElementById('seeker-pulse-ring');
      const bandLabel = document.getElementById('seeker-band-label');

      if (bandLabel && !this.powerups.smokeActive) bandLabel.innerText = bandInfo.label;

      // Show the actual number and its uncertainty so "close" is interpretable.
      const distEl = document.getElementById('seeker-dist-readout');
      if (distEl && !this.powerups.smokeActive) {
        // Rounded first, so exactly 300ft reads "300 feet" rather than tipping
        // into "100 yards" on a hair of floating-point.
        const far = Math.round(distFeet) > 300;
        const value = far ? Math.round(distFeet / 3) : Math.round(distFeet);
        const unit = far ? 'yards' : 'feet';
        distEl.innerHTML =
          `<span class="dist-main">${value}</span>` +
          `<span class="dist-sub">${unit}${this.isSoloDrill ? ' &middot; simulated' : ' &middot; \u00b1' + marginFeet}</span>` +
          (bandInfo.capped ? '<span class="dist-warn">WEAK GPS FIX</span>' : '');
      }

      this.setGauge(distFeet, bandInfo.color);

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
        const note = document.getElementById('bearing-note');
        if (arrow) {
          // Subtract the phone's compass heading so the arrow points where the
          // player is actually facing. Only a true-north heading that is still
          // arriving is trusted — otherwise say plainly that the arrow is
          // north-referenced rather than pointing confidently in the wrong
          // direction.
          const geo = window.hotspotGeo;
          const usable = geo.hasUsableHeading();
          const shown = usable ? (bearing - geo.deviceHeading + 360) % 360 : bearing;
          arrow.style.display = 'block';
          arrow.style.transform = `rotate(${shown}deg)`;

          if (note) {
            note.style.display = 'block';
            note.innerText = usable
              ? 'Arrow points at the hider — hold the phone flat'
              : 'No compass — arrow is relative to NORTH';
            note.style.color = usable ? 'var(--accent)' : 'var(--warn)';
          }
        }
      }

      // Auto-tag inside RED HOT (host-configurable catch radius). Latched per
      // target so it cannot re-fire every 250ms while the seeker stays in
      // range. Requires a credible fix — a ±80ft reading must not be allowed
      // to end the round.
      if (distFeet <= this.tagRadiusFeet
          && window.hotspotGeo.isTagCredible(marginFeet, this.tagRadiusFeet)
          && this.gameState === 'active' && !this.decoyPos) {
        const hiderPlayer = this.getActiveHider();
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
          const shown = Math.round(closestDistFeet) > 300
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
      text = `OUT OF BOUNDS — ${Math.round(distFromCenter - this.boundaryRadius)}ft past the ${this.boundaryRadius}ft line. Head back!`;
      if (!this.outOfBoundsSpoken) {
        this.outOfBoundsSpoken = true;
        if ('vibrate' in navigator) { try { navigator.vibrate([200, 100, 200]); } catch(e) {} }
        window.hotspotAudio.speak('Out of bounds! Head back inside the yard!');
      }
    } else if (distFromCenter > 0.8 * this.boundaryRadius) {
      this.outOfBoundsSpoken = false;
      bg = '#F59E0B';
      text = `NEAR THE EDGE — only ${roomLeft}ft of room left`;
    } else {
      this.outOfBoundsSpoken = false;
      bg = 'rgba(34, 197, 94, 0.20)';
      text = `In bounds — ${roomLeft}ft of room left`;
    }

    banners.forEach(b => {
      b.style.display = 'block';
      b.style.background = bg;
      b.innerText = text;
    });
  }

  usePowerup(type) {
    // Each is single-use and only does anything while the hunt is live. Tapped
    // during hiding time they used to be spent for nothing.
    if (this.gameState !== 'active') return;

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
      window.hotspotAudio.speak('Bearing ping active!');

      const endPing = () => {
        this.powerups.bearingActive = false;
        const arrow = document.getElementById('bearing-arrow');
        if (arrow) arrow.style.display = 'none';
        const note = document.getElementById('bearing-note');
        if (note) note.style.display = 'none';
      };

      // The compass takes a moment to wake up, especially the first time on
      // iOS. Don't burn the player's single 3-second ping staring at a
      // north-referenced arrow — start the clock once a real heading arrives,
      // or after a 2s grace if the device has no usable compass at all.
      const startCountdown = (waitedMs) => {
        if (!this.powerups.bearingActive) return;
        if (window.hotspotGeo.hasUsableHeading() || waitedMs >= 2000) {
          setTimeout(endPing, 3000);
        } else {
          setTimeout(() => startCountdown(waitedMs + 200), 200);
        }
      };
      startCountdown(0);
    }
  }

  triggerSmokeVisual(active) {
    this.powerups.smokeActive = active;
    const pulseRing = document.getElementById('seeker-pulse-ring');
    const bandLabel = document.getElementById('seeker-band-label');

    if (active) {
      if (pulseRing) pulseRing.classList.add('smoke-blind');
      if (bandLabel) bandLabel.innerText = 'SMOKE SCREEN';
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
    // Only a phone that is in a round can be tagged out of it. A late copy of
    // a tag (each travels twice) reaching a phone already back in the lobby
    // used to throw it onto the result screen again.
    if (this.gameState !== 'active' && this.gameState !== 'headstart') return;
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
    const iTagged = (tag.seekerId === this.playerId);

    if (iWasTagged && 'vibrate' in navigator) {
      try { navigator.vibrate([400, 150, 400, 150, 400]); } catch(e) {}
    }

    // The hunt is over from this moment. Set first, so nobody is still muted as
    // "a hider in a live round" when the result is called out — the player who
    // made the catch used to become the next hider a line early and never
    // heard their own win.
    const durationMs = this.roundDurationMs();
    this.gameState = 'gameover';

    window.hotspotAudio.playTagScream();

    if (this.isSoloDrill) {
      // A drill has no next round and nobody to swap roles with.
      window.hotspotAudio.speak('Tagged! Drill complete.');
    } else {
      // Winner hides next: the seeker who made the tag becomes the hider, and
      // the hider who was caught joins the seekers.
      if (iWasTagged) this.role = 'seeker';
      if (iTagged) this.role = 'hider';
      if (this.players[this.playerId]) this.players[this.playerId].role = this.role;

      window.hotspotAudio.speak(iTagged
        ? `Tagged! You caught ${tag.hiderName}. You hide next round.`
        : `Tagged! ${tag.seekerName} caught ${iWasTagged ? 'you' : tag.hiderName}!`);
    }

    this.saveSeasonStats(durationMs, 'tag');
    this.handleGameStateChange('gameover');
    this.sendHeartbeat();
    this.saveSession();
  }

  // A device that joined mid-round has gameStartTime = 0, which would otherwise
  // record an epoch-sized duration as a season record.
  roundDurationMs() {
    if (!this.gameStartTime) return 0;
    return Math.max(0, Date.now() - this.gameStartTime);
  }

  // outcome: 'tag'    — a seeker caught the hider
  //          'escape' — the match clock ran out and the hider survived
  // Fastest Tag only means anything for a tag; Longest Hide is how long the
  // hider stayed free either way. Previously both were fed the same number, so
  // they were really just min and max round length.
  saveSeasonStats(huntDurationMs, outcome = 'tag') {
    // Season records are for real hunts the player took part in. A two-second
    // "Tag Hider" tap in the solo drill used to become the season's Fastest
    // Tag, and watching a hunt counted as playing one.
    if (this.isSoloDrill || this.role === 'spectator') return;
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

      // Give each number a ring. Scales chosen so a normal season reads mid-arc
      // rather than pinned: 20 hunts, a 20s tag, a 5 minute hide.
      this.setDial('dial-1', stats.totalHunts / 20);
      this.setDial('dial-2', stats.fastestTagSec === 9999 ? 0
        : 1 - Math.min(1, stats.fastestTagSec / 120));
      this.setDial('dial-3', stats.longestHideSec / 300);
    } catch (e) {}
  }
}

window.hotspotApp = new HotspotApp();
setTimeout(() => {
  const app = window.hotspotApp;
  // The home screen as it actually stands. Season records used to read 0 until
  // Home was tapped, and the name boxes sat empty though the name was saved.
  try { app.updateSeasonStatsDisplay(); } catch (e) {}
  try { if (app.loadSavedName()) app.fillNameInputs(); } catch (e) {}
  try { app.initLifecycle(); } catch (e) {}
  // After a reload, put the player straight back in the room they were in.
  try { app.tryResume(); } catch (e) {}
}, 0);
