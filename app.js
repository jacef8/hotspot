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
    this.seenEventIds = {};
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

    // How long each power-up takes to come back after a use, in seconds. The
    // effect itself runs inside that: Decoy 30s, Smoke 15s, Bearing Ping 3s.
    this.powerupCooldownSec = { decoy: 60, smoke: 45, bearing: 30 };
    this.powerupsLive = false;
    this.powerupTimer = null;

    this.powerups = this.freshPowerups();

    this.decoyPos = null;
    this.matchTrackHistory = [];
    this.tagEvent = null;
    this.gameStartTime = 0;

    this.pulseInterval = null;
    this.currentBand = 'COLD';
    this.currentDistance = 999;
    this.lastPulseTime = 0;

    this.clearStaleCache();
    // Location is asked for on the first tap of Host, Join or Practice, not at
    // first paint: a new player who hits Block on an app they have not read yet
    // is blocked for good. A phone that already allowed it starts at once.
    this.gpsStarted = false;
    this.startGpsIfAllowed();
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
        // Cooldowns still running this round, so a reload cannot skip them.
        pu: this.currentRoundId ? {
          round: this.currentRoundId,
          readyAt: { ...this.powerups.readyAt }
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
      // iOS drops the broker socket while the app is in the background.
      const p = this.peer;
      if (p && p.disconnected && !p.destroyed) {
        this.peerReconnectAt = Date.now();
        try { p.reconnect(); } catch (e) {}
      }
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
    if (!this.roomCode) {
      if (banner) banner.style.display = 'none';
      return;
    }

    const peers = this.peerCount();
    // No internet at all, or a relay down for ten seconds with no direct link
    // either, is a fault worth saying. This used to count only PeerJS errors,
    // which an offline host never gets, so the lobby looked healthy for ever.
    const offline = (typeof navigator.onLine === 'boolean') && !navigator.onLine;
    if (this.rtdbConnected) this.rtdbDownSince = 0; else if (!this.rtdbDownSince) this.rtdbDownSince = Date.now();
    const relayDownMs = this.rtdbConnected ? 0 : (Date.now() - this.rtdbDownSince);
    const relayOk = !offline && (this.rtdbConnected || (this.syncFailCount < 8 && relayDownMs < 10000));

    const lobbyLine = document.getElementById('lobby-net-status');
    if (lobbyLine) {
      lobbyLine.innerText = peers > 0
        ? `Connected · ${peers} phone${peers === 1 ? '' : 's'} linked`
        : (relayOk ? (this.rtdbConnected ? 'Connected' : 'Connecting…') : 'No connection');
      lobbyLine.dataset.state = (peers > 0 || relayOk) ? 'ok' : 'bad';
    }

    // Only alarm when BOTH transports are down — a blocked relay alone is fine.
    if (banner) {
      if (peers === 0 && !relayOk) {
        banner.innerText = offline
          ? 'No internet on this phone. Turn on Wi-Fi or data and the room reconnects by itself.'
          : 'Cannot reach other devices'
            + (this.lastSyncNote ? ' (' + this.lastSyncNote + ')' : '')
            + ' — check that both phones are on the internet.';
        banner.style.display = 'block';
      } else {
        banner.style.display = 'none';
      }
    }
  }

  // A fix that stopped arriving is not a fix. Once any fix had landed, the tag
  // stayed green and the readouts kept the last good number for ever.
  refreshFixFreshness() {
    if (!this.hasGpsFix || this.role === 'spectator') return;
    const stale = (Date.now() - (this.lastFixAt || 0)) > 10000;
    if (stale === !!this.fixStale) return;
    this.fixStale = stale;
    if (!stale) return;
    this.setGpsTag('GPS LOST', 'off');
    const box = document.getElementById('gps-warning-banner');
    if (box) { box.innerText = 'GPS stopped updating. Step into the open, or tap here to restart it.'; box.style.display = 'block'; }
  }

  // The one place the GPS line in the top bar is written. The words carry the
  // state (a weak fix used to be a faint amber dot and nothing else), and a
  // screen reader hears the line only when the state changes, not every new
  // accuracy number.
  setGpsTag(text, state) {
    document.querySelectorAll('.accuracy-tag').forEach(el => {
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle('weak', state === 'weak');
      el.classList.toggle('off', state === 'off');
    });
    if (state !== this.gpsTagState) {
      this.gpsTagState = state;
      const sr = document.getElementById('gps-tag-sr');
      if (sr) sr.textContent = text;
    }
  }

  requestGpsPermissionDirectly() {
    // Once the browser has remembered Block, asking again does nothing. After
    // the player allows it in the browser's own settings, a reload is what
    // picks the new answer up.
    if (window.hotspotGeo.lastErrorCode === 1 && !this.hasGpsFix) {
      try { location.reload(); } catch (e) {}
      return;
    }
    this.startGpsTracking();
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
      this.nudgePeerBroker();
      this.sendHeartbeat();
      this.refreshTransportStatus();
      this.refreshFixFreshness();
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
      this.pendingPeerDials = {};
      this.peerDialFails = {};
      this.peerLostAt = 0;
      this.peerReconnects = 0;

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
      // A non-host whose own id is still held by a ghost of its last session
      // falls back to a suffixed one. That fallback has to survive this
      // re-run, or the same taken id is asked for again every 1.5 seconds.
      this.myPeerId = this.isRoomHost
        ? this.getHostPeerId()
        : (this.peerIdOverride || `hotspot_${codeClean}_${this.playerId}`);

      this.peer = new Peer(this.myPeerId);
      const peer = this.peer;

      peer.on('open', () => {
        this.hostIdRetries = 0;
        this.peerLostAt = 0;
        this.peerReconnects = 0;
        this.updateSyncStatus(true);
        // Dial the host immediately — no relay round-trip needed.
        if (!this.isRoomHost) this.ensureHostConnection();
        this.sendHeartbeat();
      });

      peer.on('connection', (conn) => {
        this.setupPeerDataConnection(conn);
      });

      // The broker socket dropped: a cellular blip, or iOS parking the app in
      // the background. Open links survive it, but nothing new can be dialed
      // until the socket is back, and PeerJS does not reconnect on its own.
      // reconnect() keeps this peer's token, so the broker hands the same id
      // straight back instead of calling it a ghost for a minute.
      peer.on('disconnected', () => {
        if (this.peer !== peer || peer.destroyed || !this.roomCode) return;
        if (!this.peerLostAt) this.peerLostAt = Date.now();
        this.updateSyncStatus(this.peerCount() > 0);
        this.schedulePeerReconnect(peer);
      });

      peer.on('error', (err) => {
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
            this.peerIdOverride = `hotspot_${codeClean}_${this.playerId}_${Math.random().toString(36).slice(2, 6)}`;
            this.myPeerId = this.peerIdOverride;
            try { if (this.peer) this.peer.destroy(); } catch(e) {}
            this.peer = null;
            setTimeout(() => this.initPeerSync(), 1500);
          }
          return;
        }

        // peer-unavailable just means the host is not up yet; the 3s retry in
        // ensureHostConnection will keep trying. PeerJS leaves that dial and
        // its RTCPeerConnection open, so close it here rather than in 5s.
        if (type === 'peer-unavailable') {
          const m = /peer (\S+)$/.exec((err && err.message) || '');
          const id = m && m[1];
          const conn = (id && this.pendingPeerDials) ? this.pendingPeerDials[id] : null;
          if (conn && typeof conn.close === 'function' && !conn.open) {
            delete this.pendingPeerDials[id];
            this.dropPeerDial(id, conn);
          }
        }
        this.updateSyncStatus(this.peerCount() > 0);
      });
    } catch(e) {}
  }

  // Try the broker again under the same id, waiting longer each time: 2, 4,
  // 8, then 15 seconds. With no internet the wait just rolls over.
  schedulePeerReconnect(peer) {
    const n = this.peerReconnects || 0;
    this.peerReconnects = n + 1;
    const delay = Math.min(2000 * Math.pow(2, n), 15000);
    setTimeout(() => {
      if (this.peer !== peer || peer.destroyed || !peer.disconnected || !this.roomCode) return;
      if ((typeof navigator.onLine === 'boolean') && !navigator.onLine) { this.schedulePeerReconnect(peer); return; }
      this.peerReconnectAt = Date.now();
      try { peer.reconnect(); } catch (e) { this.initPeerSync(); }
    }, delay);
  }

  // The broker link has been down a while and no retry has gone out for 20
  // seconds, so the retry chain is dead or stuck. With no live link to lose,
  // start the peer over. Live links are kept and the retries carry on.
  nudgePeerBroker() {
    const p = this.peer;
    if (!p || p.destroyed || !this.peerLostAt) return;
    if (Date.now() - Math.max(this.peerLostAt, this.peerReconnectAt || 0) < 20000) return;
    if ((typeof navigator.onLine === 'boolean') && !navigator.onLine) return;
    if (this.peerCount() > 0) return;
    this.initPeerSync();
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
        const gone = (snap.key && snap.key !== this.playerId) ? this.players[snap.key] : null;
        if (gone) {
          delete this.players[snap.key];
          if (this.gameState === 'gameover') this.nextHiderLeft(snap.key, gone.name, gone.role);
        }
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
        if (!isFinite(off)) return;
        // Countdowns started before this arrived were anchored to this phone's
        // own clock. Move those anchors into server time by the same amount
        // serverNow() moves, so the countdown carries on without a jump.
        if (!this.serverOffsetKnown && this.clockAnchoredLocally) {
          const shift = off - (this.serverOffset || 0);
          if (this.headStartStartTime) this.headStartStartTime += shift;
          if (this.activeSinceServer) this.activeSinceServer += shift;
        }
        this.clockAnchoredLocally = false;
        this.serverOffset = off; this.serverOffsetKnown = true;
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
    if (!this.peer || this.peer.disconnected || this.peer.destroyed) return;
    if (!peerId || peerId === this.myPeerId) return;
    if (this.peerConnections && this.peerConnections[peerId]) return;
    if (this.pendingPeerDials && this.pendingPeerDials[peerId]) return;
    // A phone that is not answering is dialed less and less often: 5, 10, 20,
    // then 30 seconds apart. Every attempt is a full ICE round, and a host
    // whose phone had died used to be redialed every 6 seconds all hunt.
    const fail = this.peerDialFails && this.peerDialFails[peerId];
    if (fail && Date.now() < fail.nextAt) return;

    let conn = null;
    try { conn = this.peer.connect(peerId, { reliable: true }); } catch(e) {}
    if (!conn) return;

    this.pendingPeerDials = this.pendingPeerDials || {};
    this.pendingPeerDials[peerId] = conn;
    this.setupPeerDataConnection(conn);

    // A dial that has not opened in 5 seconds is closed, or its
    // RTCPeerConnection lives on with nobody holding it.
    setTimeout(() => {
      if (!this.pendingPeerDials || this.pendingPeerDials[peerId] !== conn) return;
      delete this.pendingPeerDials[peerId];
      if (!conn.open) this.dropPeerDial(peerId, conn);
    }, 5000);
  }

  // A dial that never opened: close it and push the next try out.
  dropPeerDial(peerId, conn) {
    try { conn.close(); } catch(e) {}
    this.peerDialFails = this.peerDialFails || {};
    const n = ((this.peerDialFails[peerId] || {}).n || 0) + 1;
    const wait = [5000, 10000, 20000][n - 1] || 30000;
    this.peerDialFails[peerId] = { n, nextAt: Date.now() + wait };
  }

  destroyPeer() {
    if (this.peerConnections) {
      Object.values(this.peerConnections).forEach((conn) => {
        try { conn.close(); } catch(e) {}
      });
    }
    this.peerConnections = {};
    this.pendingPeerDials = {};
    this.peerDialFails = {};
    if (this.peer) {
      try { this.peer.destroy(); } catch(e) {}
      this.peer = null;
    }
    // After the destroy: tearing the peer down fires its own disconnected
    // handler, which would mark the link lost again.
    this.peerLostAt = 0;
    this.myPeerId = null;
    this.peerIdOverride = null;
  }

  setupPeerDataConnection(conn) {
    if (!conn) return;

    conn.on('open', () => {
      // A redial from the same phone replaces the link we held. The old one
      // is closed; its own close handler sees it is no longer ours.
      this.peerConnections = this.peerConnections || {};
      const prev = this.peerConnections[conn.peer];
      this.peerConnections[conn.peer] = conn;
      if (prev && prev !== conn) { try { prev.close(); } catch(e) {} }
      if (this.pendingPeerDials && this.pendingPeerDials[conn.peer] === conn) delete this.pendingPeerDials[conn.peer];
      if (this.peerDialFails) delete this.peerDialFails[conn.peer];
      this.updateSyncStatus(true);
      this.sendHeartbeat();
    });

    conn.on('data', (data) => {
      this.lastCloudMessageAt = Date.now();
      this.updateSyncStatus(true);
      if (data) this.handleCloudMessage(data);
    });

    // Only the link we are holding. A stale one closing late used to delete
    // its live replacement, and that seeker quietly fell back to the 3-second
    // cloud tick for the rest of the hunt.
    const forget = () => {
      if (this.peerConnections && this.peerConnections[conn.peer] === conn) delete this.peerConnections[conn.peer];
    };
    conn.on('close', forget);
    conn.on('error', forget);
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
    const fixAgeMs = this.hasGpsFix ? (Date.now() - (this.lastFixAt || 0)) : null;
    const pos = (this.hasGpsFix && fixAgeMs <= 15000) ? this.myPosition : null;

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
        accuracy: isSpectator ? null : (pos ? (pos.accuracy || 25) : null),
        // How old this phone's fix is, so the others can tell a frozen GPS
        // from a live one. Relative, so clock differences do not matter.
        fixAgeMs: isSpectator ? null : fixAgeMs
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
    if (pu && pu.round === r.id && pu.readyAt) {
      Object.keys(this.powerups.readyAt).forEach((k) => {
        const t = Number(pu.readyAt[k]);
        if (isFinite(t) && t > 0) this.powerups.readyAt[k] = t;
      });
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
          right = `<span class="badge-unit">${this.fmtDist(d)}</span>`;
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
          this.toast('Your last room has ended. Host or join a new hunt.', 5000);
          return;
        }
        this.resumed = false;
      }

      if (this.isRoomHost) return;

      // The database has said definitively that nobody is hosting this code.
      const probedEmpty = this.roomProbe && !this.roomProbe.hostFound;
      if (!this.hostSeenAt && ((probedEmpty && inRoomFor > 8000) || inRoomFor > 25000)) {
        // With no network the probe never resolves, and the old wording sent
        // people off to re-check a code that was fine.
        const offline = ((typeof navigator.onLine === 'boolean') && !navigator.onLine) || (!this.rtdbConnected && this.peerCount() === 0);
        if (offline && !probedEmpty) this.abandonRoom('NO CONNECTION', "Could not reach the room.\n\nCheck this phone's internet connection, then try the code again.");
        else this.abandonRoom('NO HOST FOUND', 'Nobody is hosting that code.\n\nCheck the code with the host, or ask them to start a new hunt.');
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
        if (!this.rtdbConnected && this.peerCount() === 0) {
          this.abandonRoom('CONNECTION LOST', 'Your phone lost its connection to the other phones, so the hunt was canceled.', false);
        } else {
          this.abandonRoom('NO SEEKERS LEFT', 'Nobody has been chasing you for over 35 seconds. Hunt canceled.', false, 'no-seekers');
        }
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
        // The screen's words, and no number: a countdown would be stale by the
        // time the voice finished it.
        window.hotspotAudio.speak('Hider offline. The hunt may cancel soon.');
      }
    } else {
      this.hiderWarnSpoken = false;
    }
  }

  // Tell the player why they are being sent home, then actually send them.
  abandonRoom(headline, detail, quiet = true, reason = null) {
    this.stopPulseLoop();
    if (this.headStartTimer) { clearInterval(this.headStartTimer); this.headStartTimer = null; }
    this.showScreen('home-screen');
    // Quiet by default: in most cases the room is already over for everyone,
    // so there is nobody left to announce a departure to. reason travels with
    // the announcement so the others are told why, not just that we left.
    try { this.leaveRoom({ quiet, reason }); } catch (e) {}
    this.updateSeasonStatsDisplay();
    try { window.hotspotAudio.speak(headline.charAt(0) + headline.slice(1).toLowerCase() + '.'); } catch (e) {}
    this.notify(`${headline}\n\n${detail}`);
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
    // Every event travels twice, once per transport. The id lets the receiver
    // act on it once: a smoke or decoy used to arrive twice and say its line
    // twice.
    data.eid = this.playerId + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 7);

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

    // Second copy of an event already handled (see broadcastCloud).
    if (data.eid) {
      if (this.seenEventIds[data.eid]) return;
      this.seenEventIds[data.eid] = Date.now();
      const keys = Object.keys(this.seenEventIds);
      if (keys.length > 300) keys.slice(0, 100).forEach((k) => { delete this.seenEventIds[k]; });
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
      if (this.gameState === 'gameover') { this.nextHiderLeft(data.id, data.name, data.role); return; }
      if (this.gameState !== 'headstart' && this.gameState !== 'active') { this.updateLobbyList(); return; }

      if (this.role === 'hider') {
        const seekersLeft = Object.values(this.players).some(p => p && p.role === 'seeker');
        if (!seekersLeft) {
          this.abandonRoom('NO SEEKERS LEFT', `${data.name || 'The last seeker'} left the hunt, so nobody is chasing you.\n\nHunt canceled.`, false, 'no-seekers');
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
      // The stamp is server time, which this phone cannot read until the
      // database has told it the offset. Until then, count from the moment the
      // message arrived: a phone with a wrong clock used to release its seeker
      // early or late by however far off its clock was.
      if (!this.serverOffsetKnown) {
        data = { ...data, headStartStartTime: Date.now() };
        this.clockAnchoredLocally = true;
      }
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
      // Same as the start: no offset yet, so the hunt went live when this arrived.
      if (!this.serverOffsetKnown) {
        data = { ...data, activeSince: Date.now() };
        this.clockAnchoredLocally = true;
      }
      this.handleGameStateChange('active', data);
      return;
    }


    if (data.type === 'HIDER_ABANDONED') {
      if (this.roomCode && (this.gameState === 'active' || this.gameState === 'headstart')) {
        // The hider's phone also sends this when it cancelled because the last
        // seeker left. That is not the hider walking away, so say what happened.
        if (data.reason === 'no-seekers') this.abandonRoom('NO SEEKERS LEFT', 'No seekers are left, so the hunt is over.');
        else this.abandonRoom('HIDER LEFT THE HUNT', `${data.name || 'The hider'} left, so this hunt is over.`);
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
      // Said on screen as well as aloud (see the readout's warn line): a seeker
      // with the voice off, or an iPhone on silent, used to chase the fake
      // point with no hint at all.
      window.hotspotAudio.speak('Careful. That reading may be a decoy.');
      if ('vibrate' in navigator) { try { navigator.vibrate([120, 80, 120]); } catch (e) {} }
      const seq = (this.decoySeq = (this.decoySeq || 0) + 1);
      setTimeout(() => { if (seq === this.decoySeq) this.decoyPos = null; }, data.durationMs || 30000);
      return;
    }

    if (data.type === 'SMOKE') {
      if (this.role !== 'seeker') return;
      const ms = data.durationMs || 15000;
      // Said aloud as the decoy is, so a seeker not looking still knows.
      window.hotspotAudio.speak(`Smoke! Your radar is blind for ${Math.round(ms / 1000)} seconds.`);
      this.triggerSmokeVisual(true, ms);
      setTimeout(() => this.triggerSmokeVisual(false), ms);
      return;
    }
  }

  // --- THE APP'S OWN POP-UPS ---
  // Browser alert()/confirm() boxes froze the phone, looked like an error
  // page and could not be styled for daylight. These are the app's own.
  // Messages are written "HEADLINE\n\nDetail": the first paragraph becomes
  // the title when there is more than one.
  showDialog({ message, ok = 'OK', cancel = null, danger = false }) {
    return new Promise((resolve) => {
      this.dialogQueue = this.dialogQueue || [];
      this.dialogQueue.push({ message: String(message || ''), ok, cancel, danger, resolve });
      if (!this.dialogOpen) this.nextDialog();
    });
  }

  nextDialog() {
    const item = this.dialogQueue && this.dialogQueue.shift();
    const scrim = document.getElementById('hs-dialog');
    if (!item || !scrim) { this.dialogOpen = false; return; }
    this.dialogOpen = true;
    const parts = item.message.split(/\n\s*\n/);
    const title = parts.length > 1 ? parts[0] : '';
    const body = parts.length > 1 ? parts.slice(1).join('\n\n') : parts[0];
    const box = scrim.querySelector('.dialog');
    const t = document.getElementById('hs-dialog-title');
    const b = document.getElementById('hs-dialog-body');
    const okBtn = document.getElementById('hs-dialog-ok');
    const cancelBtn = document.getElementById('hs-dialog-cancel');
    t.innerText = title; t.style.display = title ? '' : 'none';
    b.innerText = body;
    okBtn.innerText = item.ok;
    okBtn.classList.toggle('btn-danger', !!item.danger);
    cancelBtn.style.display = item.cancel ? '' : 'none';
    if (item.cancel) cancelBtn.innerText = item.cancel;
    // A plain message has no headline, and the hidden empty title left it
    // with no name for a screen reader. A message is a dialog; only a
    // question that needs an answer is an alert dialog.
    if (box) {
      box.setAttribute('role', item.cancel ? 'alertdialog' : 'dialog');
      if (title) { box.setAttribute('aria-labelledby', 'hs-dialog-title'); box.removeAttribute('aria-label'); }
      else { box.removeAttribute('aria-labelledby'); box.setAttribute('aria-label', item.cancel ? 'Question' : 'Message'); }
    }
    // Focus goes back where it was when the pop-up closes.
    const opener = document.activeElement;
    scrim.hidden = false;
    const done = (val) => {
      okBtn.onclick = cancelBtn.onclick = null;
      scrim.onkeydown = scrim.onclick = null;
      this.dialogDone = null;
      scrim.hidden = true;
      if (opener && opener !== document.body && document.contains(opener)) {
        try { opener.focus({ preventScroll: true }); } catch (e) {}
      }
      item.resolve(val);
      setTimeout(() => this.nextDialog(), 0);
    };
    this.dialogDone = done;
    okBtn.onclick = () => done(true);
    cancelBtn.onclick = () => done(false);
    // Escape answers with the safe choice (Cancel, or OK for a plain
    // message), and Tab stays on the pop-up's own buttons instead of
    // wandering to the screen behind it.
    scrim.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(!item.cancel); return; }
      if (e.key !== 'Tab') return;
      const btns = [cancelBtn, okBtn].filter((x) => x.style.display !== 'none' && !x.disabled);
      e.preventDefault();
      if (!btns.length) return;
      const i = btns.indexOf(document.activeElement);
      const next = i === -1 ? 0 : (i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length;
      btns[next].focus();
    };
    // A tap on the dimmed screen around it closes it the safe way too, after
    // the same third of a second as the buttons. Never for a destructive
    // question: that one needs a real answer.
    scrim.onclick = (e) => {
      if (e.target !== scrim || item.danger || okBtn.disabled) return;
      done(!item.cancel);
    };
    if (box) { try { box.focus({ preventScroll: true }); } catch (e) {} }
    // The sheet opens right under the finger that tapped a bottom button, so
    // a double tap used to land on Leave. Ignore taps for a third of a second,
    // then put focus on the safe button when the main one is destructive.
    okBtn.disabled = true; cancelBtn.disabled = true;
    setTimeout(() => {
      okBtn.disabled = false; cancelBtn.disabled = false;
      try { ((item.cancel && item.danger) ? cancelBtn : okBtn).focus(); } catch (e) {}
    }, 350);
    // Lets tests (and anything else) see what was shown.
    window.dispatchEvent(new CustomEvent('hotspot-dialog', { detail: { type: item.cancel ? 'confirm' : 'alert', text: item.message.replace(/\n+/g, ' | ') } }));
  }

  // Tell the player something. Does not block the code that called it.
  notify(message) { this.showDialog({ message }); }

  // Ask yes/no. Resolves true for the main button.
  ask(message, ok = 'Yes', cancel = 'Cancel', danger = false) {
    return this.showDialog({ message, ok, cancel, danger });
  }

  // A short message that slides in and goes away by itself.
  toast(text, ms = 2600) {
    const el = document.getElementById('hs-toast');
    if (!el) return;
    el.innerText = text;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // A problem with something the player typed, shown right under it.
  fieldError(inputId, message) {
    const input = document.getElementById(inputId);
    window.dispatchEvent(new CustomEvent('hotspot-dialog', { detail: { type: 'error', text: message.replace(/\n+/g, ' | ') } }));
    const visible = input && input.offsetParent !== null;
    if (!visible) { this.notify(message); return; }
    let err = input.parentElement.querySelector('.field-error');
    if (!err) {
      err = document.createElement('div');
      err.className = 'field-error';
      err.setAttribute('role', 'alert');
      input.insertAdjacentElement('afterend', err);
      input.addEventListener('input', () => { err.innerText = ''; input.removeAttribute('aria-invalid'); });
    }
    err.innerText = message.replace(/\n+/g, ' ');
    input.setAttribute('aria-invalid', 'true');
    try { input.focus(); } catch (e) {}
  }

  toggleSound(silent = false) {
    const speechEnabled = window.hotspotAudio.toggleSpeech();
    // One button, all sound: beeps, countdown and power-up sounds used to keep
    // playing with the voice off.
    window.hotspotAudio.toggleAudioFx(speechEnabled);
    const btn = document.getElementById('sound-btn');
    if (btn) {
      btn.classList.toggle('muted', !speechEnabled);
      btn.setAttribute('aria-label', speechEnabled ? 'Turn sound off' : 'Turn sound on');
    }
    try { localStorage.setItem('hotspot_muted', speechEnabled ? '0' : '1'); } catch (e) {}
    if (!silent) this.toast(speechEnabled ? 'Sound on' : 'Sound off');
  }

  // --- BRIGHT / NIGHT MODE ---
  // Daylight needs a light screen and the dark needs a dim one. The phone's
  // own setting decides until the player taps the sun/moon button; that
  // choice is kept on this phone.
  effectiveTheme() {
    const t = document.documentElement.dataset.theme;
    if (t === 'light' || t === 'dark') return t;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }

  toggleTheme() {
    const next = this.effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('hotspot_theme', next); } catch (e) {}
    this.syncThemeChrome();
    window.dispatchEvent(new CustomEvent('hotspot-theme', { detail: next }));
    const btn = document.querySelector('.theme-btn');
    if (btn) btn.setAttribute('aria-label', next === 'dark' ? 'Switch to bright mode' : 'Switch to night mode');
    this.toast(next === 'dark' ? 'Night mode' : 'Bright mode');
  }

  // The browser's own bar colour follows the mode too.
  syncThemeChrome() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (!bg) return;
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute('content', bg));
  }

  showScreen(screenId) {
    // The invite card is a fixed overlay. If the round starts or the room
    // closes while it is up, it used to stay on top of the new screen.
    if (screenId !== 'lobby-screen') this.closeInvite();
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');
    if (screenId !== 'home-screen') this.armBackButton();
    // The player taps Host, Join or Practice before the phone asks for location.
    if (screenId === 'host-setup-screen' || screenId === 'join-screen') this.ensureGps();
  }

  // Installed on a phone there is no browser bar, so the back gesture is the
  // only "back" there is. With nothing in the history it used to leave the app
  // mid-hunt, which stops GPS. One sentinel entry catches it instead.
  armBackButton() {
    if (this.backArmed) return;
    this.backArmed = true;
    try { history.pushState({ hotspot: 1 }, ''); } catch (e) {}
  }

  async onBackButton() {
    this.backArmed = false;
    const scrim = document.getElementById('hs-dialog');
    if (scrim && !scrim.hidden) {
      if (this.dialogDone) this.dialogDone(false);
      this.armBackButton();
      return;
    }
    const invite = document.getElementById('invite-panel');
    if (invite && invite.style.display === 'block') { this.closeInvite(); this.armBackButton(); return; }
    const diag = document.getElementById('diag-panel');
    if (diag && diag.style.display === 'block') { this.toggleDiagnostics(); this.armBackButton(); return; }
    const home = document.getElementById('home-screen');
    if (home && home.classList.contains('active')) return;
    await this.goHome();
    // They chose Stay: catch the next press too.
    if (home && !home.classList.contains('active')) this.armBackButton();
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
    this.ambientMode('hunt');
    this.ensureGps();

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
      'solo_hider': { id: 'solo_hider', name: 'Pretend hider', role: 'hider', lat: hiderPos.lat, lng: hiderPos.lng, accuracy: 15 }
    };
    this.hiderId = 'solo_hider';

    window.hotspotAudio.speak('Practice started. A pretend hider is 300 feet away.');

    this.showScreen('seeker-screen');
    
    const soloControls = document.getElementById('solo-controls-card');
    if (soloControls) soloControls.style.display = 'block';

    const counter = document.getElementById('headstart-banner-seeker');
    if (counter) counter.innerText = 'PRACTICE';
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
    window.hotspotAudio.speak(`The pretend hider moved to ${Math.round(hiderPos.currentDistFeet)} feet`);
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
    // A reload or a deep link lands here without passing the home screen.
    if (this.role !== 'spectator') this.ensureGps();

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
    this.lobbyEnteredAt = Date.now();
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
        name: this.playerName,
        reason: opts.reason || null
      });
    }

    // A seeker walking away mid-hunt. Without this the hider was never told
    // that the only person chasing them had gone home.
    // Also from the result screen: the player who hides next walking away used
    // to leave everyone else waiting for a rematch that could never start.
    if (announce && ((inRound && this.role === 'seeker') || (this.gameState === 'gameover' && !this.isRoomHost))) {
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
    this.clockAnchoredLocally = false;
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
    this.powerups = this.freshPowerups();

    const banner = document.getElementById('sync-warning-banner');
    if (banner) banner.style.display = 'none';

    this.setPowerupButtons(false);

    const soloControls = document.getElementById('solo-controls-card');
    if (soloControls) soloControls.style.display = 'none';

    this.cancelReadyEarly();
    const readyBtn = document.getElementById('btn-hider-ready');
    if (readyBtn) readyBtn.style.display = '';

    this.ambientMode('idle');
    this.triggerSmokeVisual(false);
    this.blankSeekerRadar();
    if (window.hotspotGeo.clearLagBuffers) window.hotspotGeo.clearLagBuffers();
  }

  // "Winner becomes hider" used to be announced and then thrown away, because
  // the round simply ended and the next createRoom/joinRoom overwrote the role.
  // A rematch keeps the room and the players and replays with rotated roles.
  rematch() {
    if (!this.roomCode || this.isSoloDrill) {
      this.notify('Rematch is only available in a multiplayer room.');
      return;
    }
    if (this.role !== 'hider' && this.role !== 'spectator' && !this.isRoomHost) {
      this.notify('Only the next Hider, a watcher or the host can start the rematch.');
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

    this.powerups = this.freshPowerups();
    this.setPowerupButtons(false);

    const readyBtn = document.getElementById('btn-hider-ready');
    if (readyBtn) readyBtn.style.display = '';
    this.ambientMode('idle');
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

  // The player who hides next left the result screen. Everyone else used to
  // wait on "Waiting for X to start a rematch" for ever. The host hides next
  // instead (or the first remaining player); every phone applies the same
  // rule, so the rosters agree without another message.
  nextHiderLeft(id, name, role) {
    if (!this.roomCode || this.isSoloDrill || this.gameState !== 'gameover') return;
    const wasNext = role === 'hider' || (this.tagEvent && this.tagEvent.seekerId === id);
    if (!wasNext || this.nextHiderReassigned === id) return;
    this.nextHiderReassigned = id;

    const field = Object.values(this.players)
      .filter(p => p && p.id && p.role !== 'spectator')
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const next = field.find(p => p.host) || field[0] || null;
    field.forEach(p => { p.role = (next && p.id === next.id) ? 'hider' : 'seeker'; });
    if (next && next.id === this.playerId) this.role = 'hider';
    else if (this.role === 'hider') this.role = 'seeker';

    const canRematch = this.role === 'hider' || this.role === 'spectator' || this.isRoomHost;
    const btn = document.getElementById('btn-rematch');
    if (btn) btn.style.display = canRematch ? 'block' : 'none';
    const wait = document.getElementById('rematch-wait');
    if (wait) {
      wait.style.display = canRematch ? 'none' : 'block';
      wait.innerText = next
        ? `${name || 'The next hider'} left. ${next.name || 'The host'} hides next and can start the rematch.`
        : `${name || 'The next hider'} left. Start a new hunt from Home.`;
    }
    if (next && next.id === this.playerId) window.hotspotAudio.speak(`${name || 'The next hider'} left. You hide next. Tap Rematch when everyone is ready.`);
    this.sendHeartbeat();
    this.saveSession();
  }

  // The Home button sits on every screen, one tap from ending things for the
  // whole group — and it used to act instantly. Ask first whenever leaving
  // would cost somebody else their game.
  async goHome() {
    const inRound = (this.gameState === 'headstart' || this.gameState === 'active');
    const others = Object.keys(this.players).filter(id => id !== this.playerId).length;

    if (this.roomCode && !this.isSoloDrill) {
      let question = null;
      if (inRound && this.role === 'hider') {
        question = 'Leave the hunt?\n\nYou are the Hider — leaving ends the hunt for everyone.';
      } else if (inRound && this.isRoomHost) {
        question = 'Leave the hunt?\n\nYou are the host — leaving closes the room for everyone.';
      } else if (inRound && this.role !== 'spectator') {
        // A watcher leaving costs nobody their game, so they just go.
        question = 'Leave the hunt?';
      } else if (this.isRoomHost && others > 0) {
        question = 'Close the room?\n\nYou are the host — everyone else will be sent home.';
      }
      if (question && !(await this.ask(question, 'Leave', 'Stay', true))) return;
    }

    this.showScreen('home-screen');
    try {
      this.leaveRoom();
    } catch(e) {}
    this.updateSeasonStatsDisplay();
  }

  async resetSeasonRecords() {
    if (await this.ask('Start a new season?\n\nThis resets your Hunts, Fastest Tag and Longest Hide back to zero.', 'Reset', 'Keep', true)) {
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
      this.fieldError('lobby-nickname-input', 'Type a name first.');
      return;
    }

    if (!this.saveName(newName)) return;
    if (this.players[this.playerId]) {
      this.players[this.playerId].name = this.playerName;
    }

    this.lobbyNameEditing = false;
    this.sendHeartbeat();
    this.updateLobbyList();
    window.hotspotAudio.speak(`Name updated to ${newName}`);
  }

  // The lobby shows the saved name on one line and opens the editor only to
  // change it. The open editor used to take a whole row from the roster, and
  // a name typed but never saved was not used anyway.
  syncLobbyName() {
    const line = document.getElementById('lobby-name-line');
    const editor = document.getElementById('lobby-name-editor');
    const shown = document.getElementById('lobby-name-shown');
    if (!line || !editor) return;
    const saved = this.loadSavedName();
    const open = this.lobbyNameEditing || !saved;
    line.style.display = open ? 'none' : 'flex';
    editor.style.display = open ? 'flex' : 'none';
    if (shown) shown.innerText = saved || '';
  }

  editLobbyName() {
    this.lobbyNameEditing = true;
    this.syncLobbyName();
    const el = document.getElementById('lobby-nickname-input');
    if (el) { try { el.focus(); el.select(); } catch (e) {} }
  }

  // "+2 more below" under the seeker well. On a short phone the well fits a
  // row or two, and a row cut off at its foot looked like a glitch rather than
  // a list to scroll, so a host could think a joiner never arrived.
  refreshRosterMore() {
    const well = document.getElementById('lobby-seeker-scroll');
    const more = document.getElementById('lobby-seeker-more');
    if (!well || !more) return;
    if (!this.rosterMoreBound) {
      this.rosterMoreBound = true;
      well.addEventListener('scroll', () => this.refreshRosterMore(), { passive: true });
    }
    const foot = well.getBoundingClientRect().bottom;
    const below = [...well.querySelectorAll('.player-badge')].filter(r => r.getBoundingClientRect().bottom > foot + 2).length;
    well.dataset.more = below ? '1' : '0';
    well.dataset.above = well.scrollTop > 2 ? '1' : '0';
    more.style.display = below ? 'block' : 'none';
    more.innerText = below ? `+${below} more below` : '';
  }

  // nameField: the Join screen passes its name box when a first-time player
  // left it blank, so the code is checked first and then the name.
  joinRoom(code, nickname, role = 'seeker', resumed = false, nameField = null) {
    const cleanCode = code ? code.trim().toUpperCase() : '';
    if (cleanCode.length !== 6) {
      this.fieldError(role === 'spectator' ? 'spectator-code-input' : 'join-code-input', 'Please enter the full 6-character room code from the host.');
      return;
    }
    // The generator never emits O, I, L, Z, 0, 1 or 2. Accepting them silently
    // dropped the player into an empty room that could never fill.
    if (!/^[ABCDEFGHJKMNPQRSTVWX3456789]{6}$/.test(cleanCode)) {
      this.fieldError(role === 'spectator' ? 'spectator-code-input' : 'join-code-input', 'That is not a valid room code. Codes never contain O, I, L, Z, 0, 1 or 2 — check for a mistyped character.');
      return;
    }
    if (nameField) {
      this.fieldError(nameField, 'Type your name so the others know who you are');
      return;
    }

    if ((typeof navigator.onLine === 'boolean') && !navigator.onLine) {
      this.notify('No internet connection.\n\nTurn on Wi-Fi or mobile data, then try the code again.');
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
    // A scanned link or a reload lands here without passing the home screen.
    if (role !== 'spectator') this.ensureGps();

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
      this.notify('You can only switch roles in the lobby, before the hunt starts.');
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
        this.notify(`${otherHider.name || 'Someone else'} is already the Hider.\n\nThey need to switch to Seeker first, then you can take it.`);
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

  // --- INVITING PLAYERS ---
  // The room code is six characters that had to be read out and typed in. A
  // QR code on one phone's screen, or a link sent by text, carries the same
  // code and lands the player straight in the room.
  inviteLink(role = 'seeker') {
    if (!this.roomCode || this.isSoloDrill) return null;
    const base = location.origin + location.pathname.replace(/index\.html$/, '');
    return `${base}?${role === 'spectator' ? 'watch' : 'join'}=${this.roomCode}`;
  }

  openInvite() {
    const link = this.inviteLink();
    const panel = document.getElementById('invite-panel');
    if (!link || !panel) return;

    const codeEl = document.getElementById('invite-code');
    if (codeEl) codeEl.innerText = this.roomCode;
    const linkEl = document.getElementById('invite-link');
    if (linkEl) linkEl.innerText = link;

    // Drawn here, on the phone; nothing is sent to any service.
    const qrEl = document.getElementById('invite-qr');
    if (qrEl) {
      let svg = '';
      try {
        if (typeof qrcode === 'function') {
          const qr = qrcode(0, 'M');
          qr.addData(link);
          qr.make();
          svg = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
        }
      } catch (e) { svg = ''; }
      qrEl.innerHTML = svg || '<div class="qr-missing">QR code unavailable — send the link instead</div>';
    }

    // Phones that can open a share sheet get "Send link" plus a plain copy;
    // anything else gets one button that copies.
    const shareBtn = document.getElementById('btn-invite-share');
    const copyBtn = document.getElementById('btn-invite-copy');
    const canShare = !!navigator.share;
    if (shareBtn) { shareBtn.innerText = canShare ? 'Send link' : 'Copy link'; shareBtn.dataset.label = shareBtn.innerText; }
    if (copyBtn) { copyBtn.innerText = 'Copy link'; copyBtn.dataset.label = 'Copy link'; copyBtn.style.display = canShare ? '' : 'none'; }

    panel.style.display = 'block';
    panel.scrollTop = 0;
  }

  closeInvite() {
    const panel = document.getElementById('invite-panel');
    if (panel) panel.style.display = 'none';
  }

  async shareInvite() {
    const link = this.inviteLink();
    if (!link) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'HOTSPOT hunt', text: `Join my HOTSPOT hunt — room ${this.roomCode}`, url: link });
        return;
      } catch (e) {
        // Cancelled by the player: nothing more to do. Refused by the browser:
        // fall back to copying.
        if (e && e.name === 'AbortError') return;
      }
    }
    await this.copyInvite('btn-invite-share');
  }

  async copyInvite(btnId = 'btn-invite-copy') {
    const link = this.inviteLink();
    if (!link) return;
    let ok = false;
    try { await navigator.clipboard.writeText(link); ok = true; } catch (e) {}
    if (!ok) {
      // Older browsers: select the link text and ask the browser to copy it.
      try {
        const el = document.getElementById('invite-link');
        const range = document.createRange(); range.selectNodeContents(el);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        ok = document.execCommand('copy');
        sel.removeAllRanges();
      } catch (e) {}
    }
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const label = btn.dataset.label || btn.innerText;
    btn.innerText = ok ? 'Copied' : 'Could not copy — long-press the link below';
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => { btn.innerText = label; }, ok ? 1800 : 4000);
  }

  // A link or QR code carrying a room code: ?join=CODE joins as a seeker,
  // ?watch=CODE as a spectator. Consumed once at launch, then removed from the
  // address bar so a reload does not join again. Returns true if it took over.
  consumeDeepLink() {
    let params;
    try { params = new URLSearchParams(location.search); } catch (e) { return false; }
    const join = (params.get('join') || '').trim().toUpperCase();
    const watch = (params.get('watch') || '').trim().toUpperCase();
    const code = join || watch;
    if (!code) return false;
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    if (!/^[ABCDEFGHJKMNPQRSTVWX3456789]{6}$/.test(code)) {
      // Said, not dropped: the player followed a link and would otherwise just
      // see the home screen with the code gone from the address bar.
      this.toast('That invite link did not have a valid room code. Ask the host to share it again.', 5000);
      return false;
    }

    // The scanned room wins over whatever session was left from before.
    this.session = null;
    this.clearSession();

    const role = (watch && !join) ? 'spectator' : 'seeker';
    if (role === 'spectator' || this.loadSavedName()) {
      this.joinRoom(code, null, role);
    } else {
      // No name on this phone yet: the Join screen with the code already in,
      // so all that is left to type is a name.
      const codeEl = document.getElementById('join-code-input');
      if (codeEl) codeEl.value = code;
      this.showScreen('join-screen');
      const nick = document.getElementById('join-nickname-input');
      if (nick) { try { nick.focus(); } catch (e) {} }
    }
    return true;
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
         <span style="opacity:.78">${k}</span>
         <span style="text-align:right;font-weight:700;color:${bad ? 'var(--bad)' : 'var(--ink)'}">${v}</span>
       </div>`;

    el.innerHTML =
      row('app version', 'v3.5.2') +
      (() => {
        // Straight from the stylesheet. If this disagrees with the app version
        // above, the phone is running cached CSS - provable, not a guess.
        let css = 'not loaded';
        try {
          css = (getComputedStyle(document.documentElement)
            .getPropertyValue('--css-version') || '').replace(/["']/g, '').trim() || 'missing';
        } catch (e) {}
        return row('stylesheet', css, css !== '3.5.2');
      })() +
      row('room', this.roomCode || '(none)', !this.roomCode) +
      row('am I host', this.isRoomHost ? 'yes' : 'no') +
      row('my role', this.role) +
      row('my id', this.playerId) +
      row('online', navigator.onLine ? 'yes' : 'NO', !navigator.onLine) +
      row('screen kept awake', this.wakeLock ? 'yes' : (this.roomCode ? 'NO' : '-'), !!this.roomCode && !this.wakeLock) +
      (() => {
        // What is drawing the background, and what it costs per frame.
        const a = window.hotspotAmbient;
        if (!a) {
          const why = window.hotspotAmbientError ? ' (' + window.hsEscape(String(window.hotspotAmbientError)).slice(0, 40) + ')' : '';
          return row('background', 'CSS fallback' + why, true);
        }
        const s = a.status();
        return row('background', `WebGL ${s.mode} · ${s.particles} pts · ${s.fps} fps · ${s.frameMs}ms`, s.paused && document.visibilityState === 'visible');
      })() +
      (() => {
        const sc = window.hotspotScroll;
        if (!sc) return row('smooth scroll', 'not loaded', true);
        if (sc.ok) return row('smooth scroll', sc.instances.length + ' panels');
        return row('smooth scroll', 'off' + (sc.error ? ' (' + window.hsEscape(String(sc.error)) + ')' : ''), true);
      })() +
      row('clock vs server', this.serverOffsetKnown ? Math.round(this.serverOffset) + 'ms' : 'clock not synced', (!!this.roomCode && !this.serverOffsetKnown) || Math.abs(this.serverOffset) > 5000) +
      row('hider silent', this.hiderSilentMs ? Math.round(this.hiderSilentMs / 1000) + 's' : '-', this.hiderSilentMs > 18000) +
      '<hr class="diag-rule">' +
      row('database', this.rtdbConnected ? 'CONNECTED' : 'not connected', !this.rtdbConnected) +
      row('db node written', this.rtdbMyRef ? 'yes' : 'NO', !this.rtdbMyRef) +
      row('db error', this.lastRtdbError ? window.hsEscape(this.lastRtdbError) : 'none', !!this.lastRtdbError) +
      '<hr class="diag-rule">' +
      row('peer registered', (this.peer && this.peer.open) ? 'yes' : 'NO', !(this.peer && this.peer.open)) +
      row('my peer id', this.myPeerId || '(none)') +
      row('host peer id', this.getHostPeerId() || '(none)') +
      row('direct links', this.peerCount(), this.peerCount() === 0) +
      row('peer error', this.lastPeerError ? window.hsEscape(this.lastPeerError) : 'none', !!this.lastPeerError) +
      '<hr class="diag-rule">' +
      row('GPS accuracy', this.hasGpsFix ? '±' + this.fmtDist(this.myPosition.accuracy, false) : 'NO FIX', !this.hasGpsFix) +
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
        || '<div class="roster-empty">No seekers yet — tap Invite to share a QR code or link</div>';
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

    const hider = this.getActiveHider();
    // The host's phone has gone quiet. The roster drops it at 15 s but the
    // room is only called dead at 45 s, and in between the lobby looked like a
    // live room with an empty hider slot, inviting someone to take it.
    const hostLost = !this.isRoomHost && !!this.hostSeenAt && Date.now() - this.hostSeenAt > 15000;

    // The role button says what it will do. A spectator is not on the field,
    // so there is nothing for it to switch. While someone else is hiding it
    // says so and stays off, instead of opening a pop-up that says no.
    // The 3 s lobby tick re-enables it when that hider drops out.
    const roleBtn = document.getElementById('btn-switch-role');
    if (roleBtn) {
      const taken = this.role !== 'hider' && !!hider && hider.id !== this.playerId;
      roleBtn.style.display = (this.role === 'spectator' || hostLost) ? 'none' : '';
      roleBtn.disabled = taken;
      roleBtn.innerText = taken ? `${hider.name || 'Someone'} is hiding`
        : (this.role === 'hider' ? 'Switch to Seeker' : 'Become the Hider');
    }

    const wakeNote = document.getElementById('lobby-wake-note');
    if (wakeNote) wakeNote.style.display = (this.wakeLockFailed && !this.wakeLock) ? 'block' : 'none';

    // Whoever is hiding (or a spectator) starts the round. Everyone else is told
    // exactly what they are waiting for — the old message said "Waiting for
    // Host (Hider)" even to the host, and even when nobody was hiding at all.
    const startBtn = document.getElementById('btn-start-round');
    const waitMsg = document.getElementById('lobby-wait-msg');
    const searching = !this.isRoomHost && !this.hostSeenAt;
    // The host keeps Start too, even after handing the hider role to a child.
    const canStart = !searching && !hostLost && (this.role === 'hider' || this.role === 'spectator' || this.isRoomHost);

    if (startBtn) startBtn.style.display = canStart ? 'block' : 'none';
    if (waitMsg) {
      waitMsg.style.display = canStart ? 'none' : 'block';
      waitMsg.dataset.state = hostLost ? 'lost' : '';
      if (searching) waitMsg.innerText = 'Looking for this room…';
      else if (hostLost) waitMsg.innerText = 'Lost contact with the host — waiting…';
      else if (!hider) waitMsg.innerText = 'Nobody is hiding yet — tap "Become the Hider" to hide';
      else waitMsg.innerText = `Waiting for ${hider.name || 'the Hider'} to start the hunt`;
    }

    this.syncLobbyName();
    this.refreshRosterMore();
  }

  // --- GAME START & HEADSTART TIMING ENGINE ---
  startHeadstart() {
    // A round can only begin from the lobby. This had no such check, and the
    // spectator map carried a Start button that stayed live during a hunt:
    // tapping it put that one phone into a private round of its own, where it
    // then missed the tag and never saw the result.
    if (this.gameState !== 'lobby' || !this.roomCode || this.isSoloDrill) return;
    // The lobby appears under the finger that just tapped Create Room, with
    // Start in the same spot. A second tap that quickly is not a decision.
    if (Date.now() - (this.lobbyEnteredAt || 0) < 700) return;

    if (this.role !== 'hider' && this.role !== 'spectator' && !this.isRoomHost) {
      this.notify('Only the Hider, a watcher or the host can start the hunt.');
      return;
    }

    // A round with nobody hiding leaves every seeker on NO SIGNAL for the whole
    // match, and no yard centre means the boundary silently does not exist.
    const hiderNow = this.getActiveHider();
    if (!hiderNow) {
      this.notify('Nobody is the Hider yet.\n\nSomeone needs to tap "Become the Hider" in the lobby before the hunt can start.');
      return;
    }

    // ...and one with nobody seeking is the hider crouching behind a shed alone.
    const seekers = Object.values(this.players).filter(p => p && p.role === 'seeker');
    if (seekers.length === 0) {
      this.notify('No seekers have joined yet.\n\nShare the room code and wait for someone to appear under Seekers.');
      return;
    }

    // The hider is the one thing everybody measures to. Without a real fix
    // there is nothing to find and no yard centre to draw the boundary around.
    const hiderIsMe = hiderNow.id === this.playerId;
    const hiderHasFix = hiderIsMe ? this.hasGpsFix : !!(hiderNow.lat && hiderNow.lng);
    if (!hiderHasFix) {
      this.notify(hiderIsMe
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
    // With no offset yet that stamp is this phone's own clock; it moves into
    // server time when the offset arrives.
    if (!this.serverOffsetKnown) this.clockAnchoredLocally = true;

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

  // "I'm hidden" sits under the hider's thumb while they run, and one brushed
  // tap used to release the seekers early with no way back. It now counts
  // three seconds on the button first; a second tap in that time cancels.
  hiderReadyEarly() {
    if (this.gameState !== 'headstart') return;
    if (this.readyEarlyTimer) { this.cancelReadyEarly(); return; }
    const btn = document.getElementById('btn-hider-ready');
    if (!btn) { this.releaseSeekersEarly(); return; }
    if (!btn.dataset.label) btn.dataset.label = btn.innerText.trim();
    let left = 3;
    const show = () => { btn.innerText = `Starting in ${left} — tap to cancel`; };
    btn.classList.add('arming');
    show();
    this.readyEarlyTimer = setInterval(() => {
      if (this.gameState !== 'headstart') { this.cancelReadyEarly(); return; }
      left -= 1;
      if (left > 0) { show(); return; }
      this.cancelReadyEarly();
      this.releaseSeekersEarly();
    }, 1000);
  }

  // Stops the countdown above and puts the button back as it was.
  cancelReadyEarly() {
    if (this.readyEarlyTimer) { clearInterval(this.readyEarlyTimer); this.readyEarlyTimer = null; }
    const btn = document.getElementById('btn-hider-ready');
    if (!btn) return;
    btn.classList.remove('arming');
    if (btn.dataset.label) btn.innerText = btn.dataset.label;
  }

  releaseSeekersEarly() {
    if (this.gameState !== 'headstart') return;

    if (this.headStartTimer) {
      clearInterval(this.headStartTimer);
      this.headStartTimer = null;
    }

    this.gameState = 'active';
    const activeSince = this.serverNow();
    if (!this.serverOffsetKnown) this.clockAnchoredLocally = true;
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
      this.cancelReadyEarly();

      this.enterRoundScreen();

      // No proximity information while the hider is still hiding. The radar
      // used to sit on a stale COLD/HOT reading during the countdown, which
      // leaks a hint before the hunt has even started.
      this.blankSeekerRadar();
      this.ambientMode('hunt');

      // The clock cells used to keep whatever the previous round ended on, so
      // round two's hiding time opened with "MATCH TIME: 0:00".
      this.setMatchClock(this.matchClockText(this.matchDurationSeconds));
      // Power-ups do nothing until the hunt is live, and tapping one during
      // hiding time used to spend it anyway.
      this.setPowerupButtons(false);
      // A spectator's map has to show the hiding time too, not just the hunt.
      if (this.role === 'spectator') this.startPulseLoop();

      // A phone that joins or reloads mid-countdown hears what is left, not
      // the full hiding time the counter is about to contradict. At zero the
      // tick below announces the hunt itself.
      const left = Math.max(0, duration - Math.floor((this.serverNow() - startTime) / 1000));
      if (left >= duration - 2) window.hotspotAudio.speak(`Hider has ${duration} seconds to hide!`);
      else if (left > 0) window.hotspotAudio.speak(`Hider has ${left} seconds left to hide!`);

      if (this.headStartTimer) clearInterval(this.headStartTimer);

      // Read the anchor each tick: it moves into server time if the offset
      // arrives mid-countdown (see the serverTimeOffset listener).
      const anchor = () => this.headStartStartTime || startTime;
      this.headStartTimer = setInterval(() => {
        const elapsed = Math.floor((this.serverNow() - anchor()) / 1000);
        const remaining = Math.max(0, duration - elapsed);
        this.headStartRemaining = remaining;

        document.querySelectorAll('.headstart-counter').forEach(el => {
          el.innerText = `HIDING ${remaining}s`;
        });

        const hiderCounter = document.getElementById('hider-timer-display');
        if (hiderCounter) hiderCounter.innerText = `HIDING ${remaining}s`;
        if (this.role === 'hider') this.setHiderPanel('Seekers start in', `${remaining}s`, 'Find your spot. Your phone stays silent.');

        if (remaining <= 5 && remaining > 0) {
          window.hotspotAudio.playCountdownBeep(false);
        }

        if (remaining === 30 || remaining === 15) {
          window.hotspotAudio.speak(`${remaining} seconds until the hunt starts!`);
        }

        if (remaining <= 0) {
          clearInterval(this.headStartTimer);
          this.headStartTimer = null;

          document.querySelectorAll('.headstart-counter').forEach(el => {
            el.innerText = 'HUNT LIVE';
          });
          if (hiderCounter) hiderCounter.innerText = 'HUNT LIVE';

          window.hotspotAudio.playCountdownBeep(true);

          // The clock ran out by itself. The state itself has to change here as
          // well as the screen: this line used to call handleGameStateChange
          // alone, which left the hider's own device sitting in 'headstart' for
          // the whole hunt — no nearest-seeker readout, a match clock frozen on
          // its starting value, and no result screen when the match ended.
          // Seekers only escaped it because the hider's message flipped them.
          const activeSince = anchor() + duration * 1000;
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
      if (hiderCounter) hiderCounter.innerText = 'HUNT LIVE';
      if (this.role === 'hider') this.setHiderPanel('Nearest seeker', '-- ft', 'Silent — only you can see this');

      this.cancelReadyEarly();
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

      this.ambientMode('hunt');
      this.startPulseLoop();
      this.startMatchTimer();
    } else if (newState === 'gameover') {
      this.stopPulseLoop();
      this.ambientMode('idle');
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
          // Plain ink: orange means "you are close" and nothing else.
          headline.style.color = 'var(--ink)';
          // Said to each player in their own terms. This replaces a pop-up that
          // stopped the phone dead until it was dismissed.
          let line = `${tag.seekerName} caught ${tag.hiderName}`;
          if (this.isSoloDrill) line = 'Practice complete — you reached the pretend hider';
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
      // An indoor practice run has no real place to show: the map opened on
      // the built-in practice point, a satellite view of the wrong city.
      const noPlace = this.isSoloDrill && (!this.hasGpsFix || !this.myPosition || !!this.myPosition.simulated);
      const resultScreen = document.getElementById('replay-screen');
      if (resultScreen) resultScreen.classList.toggle('drill', noPlace);
      if (window.hotspotReplay && !noPlace) {
        window.hotspotReplay.loadReplayData(this.matchTrackHistory, this.tagEvent, this.yardCenterPos);
        window.hotspotReplay.setBoundary(this.yardCenterPos, this.boundaryRadius);
      }
      // The replay opens on the finished picture, so the scrubber sits at the end.
      const slider = document.getElementById('replay-slider');
      if (slider) slider.value = 100;

      // Only the next hider (or a spectator) can start the rematch. Everyone
      // used to be shown the button, and most of them got an error for tapping it.
      const inRoom = !!this.roomCode && !this.isSoloDrill;
      const canRematch = inRoom && (this.role === 'hider' || this.role === 'spectator' || this.isRoomHost);
      const rematchBtn = document.getElementById('btn-rematch');
      if (rematchBtn) {
        rematchBtn.style.display = canRematch ? 'block' : 'none';
        // Nobody swaps after the hider survives; say what actually happens next.
        rematchBtn.innerText = !tag ? 'Rematch — same hider hides again'
          : (tag.seekerId === this.playerId ? 'Rematch — you hide next' : `Rematch — ${tag.seekerName} hides next`);
      }

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
    // Short enough for half the rail; "NO TIME LIMIT" was cut off on every phone.
    if (!this.matchDurationSeconds || this.matchDurationSeconds <= 0) return 'NO LIMIT';
    const left = Math.max(0, Math.floor(remainingSec));
    return `${Math.floor(left / 60)}:${(left % 60).toString().padStart(2, '0')} LEFT`;
  }

  // One way to write a distance: a space before the unit, and yards past
  // 300 ft unless yards would make no sense (GPS accuracy).
  fmtDist(feet, yards = true) {
    const ft = Math.round(feet);
    return yards && ft > 300 ? `${Math.round(feet / 3)} yd` : `${ft} ft`;
  }

  setMatchClock(text) {
    ['match-timer-seeker', 'match-timer-hider', 'match-timer-spectator'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerText = text;
    });
  }

  // --- POWER-UPS ---
  // Each power-up can be used again once its cooldown has run. They used to be
  // one use per round, which meant the buttons were dead for most of the hunt.
  freshPowerups() {
    return {
      readyAt: { decoy: 0, smoke: 0, bearing: 0 },   // when each may be used again
      decoyActive: false,
      smokeActive: false,
      bearingActive: false
    };
  }

  powerupReady(type) {
    const at = (this.powerups.readyAt && this.powerups.readyAt[type]) || 0;
    return Date.now() >= at;
  }

  startCooldown(type) {
    const sec = (this.powerupCooldownSec && this.powerupCooldownSec[type]) || 30;
    this.powerups.readyAt[type] = Date.now() + sec * 1000;
    this.updatePowerupButtons();
    this.saveSession();
  }

  // live=false greys all three out (lobby, hiding time, result); live=true
  // enables whichever are not cooling down.
  setPowerupButtons(live) {
    this.powerupsLive = !!live;
    this.updatePowerupButtons();
  }

  // Labels, enabled state and the fill bar on each button. Ticks once a second
  // while anything is cooling, and stops itself when nothing is.
  updatePowerupButtons() {
    const now = Date.now();
    const map = { decoy: 'btn-powerup-decoy', smoke: 'btn-powerup-smoke', bearing: 'btn-bearing-ping' };
    let pending = false;

    Object.keys(map).forEach((type) => {
      const b = document.getElementById(map[type]);
      if (!b) return;
      const readyAt = (this.powerups.readyAt && this.powerups.readyAt[type]) || 0;
      const left = readyAt - now;
      const cooling = left > 0;
      if (cooling) pending = true;

      const label = b.dataset.label || b.innerText.trim();
      const short = b.dataset.short || label;
      const total = ((this.powerupCooldownSec && this.powerupCooldownSec[type]) || 30) * 1000;

      b.disabled = !this.powerupsLive || cooling;
      b.classList.toggle('cooling', cooling);
      const text = b.querySelector('.btn-text');
      if (text) text.innerText = cooling ? `Back in ${Math.ceil(left / 1000)}s` : label;
      const fill = b.querySelector('.cd-bar i');
      if (fill) this.runCooldownBar(fill, cooling ? readyAt : 0, total);

      // A short buzz the moment one comes back, so the player need not watch.
      if (!cooling && b.dataset.cooling === '1') {
        b.dataset.cooling = '';
        if (this.powerupsLive && 'vibrate' in navigator) { try { navigator.vibrate(35); } catch (e) {} }
      }
      if (cooling) b.dataset.cooling = '1';
    });

    if (pending && !this.powerupTimer) {
      this.powerupTimer = setInterval(() => this.updatePowerupButtons(), 1000);
    } else if (!pending && this.powerupTimer) {
      clearInterval(this.powerupTimer);
      this.powerupTimer = null;
    }
  }

  // The cooldown bar fills in one smooth glide, timed from readyAt, so a
  // redraw part-way through (coming back to the app) picks it up at the right
  // spot. It used to step its width once a second in uneven whole-percent
  // jumps, pausing between them, and ran backwards as it faded out.
  runCooldownBar(fill, readyAt, totalMs) {
    const now = Date.now();
    if (!readyAt || readyAt <= now) {
      // Finished on its own: stay full while the bar fades away. Cut short (a
      // new round): empty. Either way the next cooldown starts from its spot.
      const ranOut = fill.dataset.until && Number(fill.dataset.until) <= now + 50;
      delete fill.dataset.until;
      fill.style.transition = 'none';
      fill.style.transform = ranOut ? 'scaleX(1)' : 'scaleX(0)';
      return;
    }
    const done = Math.max(0, Math.min(1, 1 - (readyAt - now) / totalMs));
    let still = false;
    try { still = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    if (still) {
      // No glide: one honest step a second.
      fill.dataset.until = String(readyAt);
      fill.style.transition = 'none';
      fill.style.transform = `scaleX(${done.toFixed(3)})`;
      return;
    }
    if (fill.dataset.until === String(readyAt)) return;   // already gliding there
    fill.dataset.until = String(readyAt);
    fill.style.transition = 'none';
    fill.style.transform = `scaleX(${done.toFixed(3)})`;
    void fill.offsetWidth;   // start the glide from here, not from the old value
    fill.style.transition = `transform ${Math.round(readyAt - now)}ms linear`;
    fill.style.transform = 'scaleX(1)';
  }

  startMatchTimer() {
    if (this.matchTimer) clearInterval(this.matchTimer);
    if (!this.matchDurationSeconds || this.matchDurationSeconds <= 0) {
      this.setMatchClock('NO LIMIT');
      return;
    }

    const matchStartTime = this.activeSinceServer || this.serverNow();

    this.matchTimer = setInterval(() => {
      if (this.gameState !== 'active') {
        clearInterval(this.matchTimer);
        this.matchTimer = null;
        return;
      }

      // Live anchor, for the same reason as the hiding countdown's.
      const elapsedSec = Math.floor((this.serverNow() - (this.activeSinceServer || matchStartTime)) / 1000);
      const remainingSec = Math.max(0, this.matchDurationSeconds - elapsedSec);

      this.setMatchClock(this.matchClockText(remainingSec));

      if (remainingSec === 60) {
        window.hotspotAudio.speak("1 minute remaining in the hunt!");
      } else if (remainingSec === 30 || remainingSec === 15) {
        window.hotspotAudio.speak(`${remainingSec} seconds left in the hunt!`);
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
      window.hotspotAudio.speak('Time is up. The hider survived.');
    }

    // Surviving the whole clock is exactly the Longest Hide record, and it was
    // the one outcome that never got saved. It is the hider's record only.
    this.saveSeasonStats(survivedMs, 'escape', { wasHider: this.role === 'hider' });
    this.handleGameStateChange('gameover');
  }

  startGpsTracking() {
    this.gpsStarted = true;
    window.hotspotGeo.startTracking(
      (pos) => this.onGpsUpdate(pos),
      (err) => this.onGpsError(err)
    );
  }

  // Start once, the first time the player does something that needs a fix.
  ensureGps() {
    if (this.gpsStarted) return;
    this.startGpsTracking();
  }

  // A returning player who already said yes should not have to tap first.
  // Safari's permissions API is patchy, so any failure just waits for the tap.
  startGpsIfAllowed() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return;
      navigator.permissions.query({ name: 'geolocation' })
        .then((s) => { if (s && s.state === 'granted') this.ensureGps(); })
        .catch(() => {});
    } catch (e) {}
  }

  // Only ever called with a real fix from the phone.
  onGpsUpdate(pos) {
    const firstFix = !this.hasGpsFix;
    this.myPosition = pos;
    this.hasGpsFix = true;
    this.lastFixAt = Date.now();
    this.fixStale = false;

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

    // "GPS WEAK" wraps onto its own line before the number on a narrow phone.
    const weak = pos.accuracy > 50;
    this.setGpsTag(weak ? `GPS WEAK ±${this.fmtDist(pos.accuracy, false).replace(' ', '\u00A0')}` : `GPS ±${this.fmtDist(pos.accuracy, false)}`, weak ? 'weak' : 'ok');

    const warnBox = document.getElementById('gps-warning-banner');
    if (warnBox && this.role === 'spectator') {
      // Watching from a laptop with no GPS is a supported setup, not a fault.
      warnBox.style.display = 'none';
    } else if (warnBox) {
      if (pos.isProtocolWarning) {
        warnBox.innerText = 'Opened as a local file. GPS only works from the https web address.';
        warnBox.style.display = 'block';
      } else if (pos.accuracy > 50) {
        warnBox.innerText = `Weak GPS (±${this.fmtDist(pos.accuracy, false)}). Move out from under the trees.`;
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

    warnBox.innerText = errMessage;
    warnBox.style.display = 'block';

    // Don't keep claiming a fix the phone does not have. The top bar used to
    // read "GPS: ±25ft" with location switched off entirely.
    if (!this.hasGpsFix) {
      this.setGpsTag('GPS OFF\u00A0· TAP\u00A0HERE', 'off');
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

  // ---- the radar (radar.js) ---------------------------------------------
  // The hider ring sits at the distance and takes the band's colour. null
  // clears it: no reading, no hint.
  setGauge(distFeet) {
    const radar = window.hotspotRadar;
    if (!radar) return;
    radar.setTagRadius(this.tagRadiusFeet);
    radar.setDistance(typeof distFeet === 'number' && isFinite(distFeet) ? distFeet : null, this.currentBand);
  }

  // ---- the seeker readout ------------------------------------------------
  // One place writes it. kicker: the small line above; label: the band word
  // or notice; band: colours the strip; num/unit: the distance; warn: a
  // short warning under it. The number glides to each new value rather than
  // jumping, so a seeker walking in can feel it fall.
  setSeekerReadout({ kicker = 'Hider is', label = '', band = null, num = null, unit = '', warn = '' } = {}) {
    const box = document.getElementById('seeker-readout');
    const k = box && box.querySelector('.readout-kicker');
    const bandLabel = document.getElementById('seeker-band-label');
    const dist = document.getElementById('seeker-dist-readout');
    if (!dist) return;
    let main = dist.querySelector('.dist-main'), sub = dist.querySelector('.dist-sub'), w = dist.querySelector('.dist-warn');
    if (!main || !sub || !w) {
      dist.innerHTML = '<span class="dist-main" aria-hidden="true"></span><span class="dist-sub"></span><span class="dist-warn"></span>';
      main = dist.querySelector('.dist-main'); sub = dist.querySelector('.dist-sub'); w = dist.querySelector('.dist-warn');
    }
    if (k) k.innerText = kicker;
    // Screen readers: the band word is a live line of its own, and the number
    // goes to a hidden live line only when it moves a real step (or the band
    // or notice changes), never on every frame of the glide.
    const sr = document.getElementById('seeker-dist-sr');
    if (sr) {
      const unitWord = num === null ? '' : unit.split(' · ')[0];
      const last = this.srReadout || {};
      const moved = num !== null && (typeof last.num !== 'number' || last.unitWord !== unitWord || Math.abs(num - last.num) >= Math.max(10, last.num * 0.15));
      if (label !== last.label || moved) {
        sr.textContent = num === null ? unit : `${num} ${unitWord}`;
        this.srReadout = { label, num, unitWord };
      }
    }
    // The word and the strip colour used to flip the instant a reading changed
    // while the number was still gliding, so for a moment the panel said COLD
    // over a hot number. A band change on a live reading waits a beat; a
    // notice, a unit change or reduced motion writes at once.
    const writeBand = () => {
      // Written only on a change: it is a live region, and the readout is set
      // four times a second.
      if (bandLabel && bandLabel.textContent !== label) bandLabel.innerText = label;
      if (box) { if (band) box.dataset.band = band; else delete box.dataset.band; }
    };
    clearTimeout(this.bandLabelTimer); this.bandLabelTimer = null;
    const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const liveChange = num !== null && !!band && !!box && !!box.dataset.band && box.dataset.band !== band && main.dataset.unit === unit && !calm;
    if (liveChange) this.bandLabelTimer = setTimeout(writeBand, 150); else writeBand();
    if (box) box.classList.toggle('notice', num === null);
    sub.innerText = unit;
    w.innerText = warn;
    this.glideNumber(main, num, unit);
  }

  // The frame handle lives on the element, so the seeker's number and the
  // hider's number each glide on their own.
  glideNumber(el, value, unit) {
    if (el._hsRaf) { cancelAnimationFrame(el._hsRaf); el._hsRaf = null; }
    if (value === null || value === undefined) { el.innerText = ''; el.dataset.v = ''; el.dataset.unit = ''; return; }
    const from = parseFloat(el.dataset.v);
    const sameUnit = el.dataset.unit === unit;
    const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.dataset.v = String(value);
    el.dataset.unit = unit;
    if (!sameUnit || !isFinite(from) || from === value || calm) { el.innerText = String(value); return; }
    const t0 = performance.now(), dur = 300;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.innerText = String(Math.round(from + (value - from) * e));
      el._hsRaf = p < 1 ? requestAnimationFrame(step) : null;
    };
    el._hsRaf = requestAnimationFrame(step);
  }

  // --- living background (ambient.js) ---
  ambient() { return window.hotspotAmbient || null; }

  // Heat for the background from a distance in feet, following the proximity
  // bands: cold beyond 250ft, climbing through warm and hot to white-hot at
  // the catch. Anything that is not a real distance (no fix, no signal) is cold.
  ambientHeat(distFeet) {
    const a = this.ambient();
    if (!a) return;
    if (typeof distFeet !== 'number' || !isFinite(distFeet)) { a.setHeat(0); return; }
    const stops = [[300, 0], [250, 0.15], [100, 0.45], [45, 0.7], [20, 0.88], [0, 1]];
    let heat = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const [d0, h0] = stops[i], [d1, h1] = stops[i + 1];
      if (distFeet <= d0 && distFeet >= d1) { heat = h0 + (h1 - h0) * ((d0 - distFeet) / (d0 - d1)); break; }
    }
    a.setHeat(heat);
  }

  // 'hunt' runs the background lighter, to leave the battery for the GPS.
  ambientMode(mode) {
    const a = this.ambient();
    if (a) a.setMode(mode);
  }

  // Season dials: r=26, circumference 163. Every number gets a visual cue.
  setDial(id, pct, ) {
    const el = document.getElementById(id);
    if (!el) return;
    const v = Math.max(0, Math.min(1, pct || 0));
    // A transform, not a width: the fill glides without re-laying out the card.
    el.style.transform = `scaleX(${v.toFixed(3)})`;
  }

  blankSeekerRadar() {
    this.currentBand = null;
    this.currentDistance = null;

    this.setSeekerReadout({ kicker: 'Hiding time', label: 'STAND BY', unit: 'The hunt starts when hiding time ends' });

    this.setGauge(null);
    if (window.hotspotRadar) { window.hotspotRadar.setBearing(null); window.hotspotRadar.setSmoke(false); }
    this.ambientHeat(null);

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
    this.currentBand = null;
    if (!this.powerups.smokeActive) {
      this.setSeekerReadout({ kicker: 'Signal', label, unit: detail });
    }
    this.setGauge(null);
    this.ambientHeat(null);
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
      if (this.role === 'seeker') this.showRadarNotice('NO GPS', 'no location on this phone');
      if (this.role === 'hider') {
        const d = document.getElementById('hider-nearest-dist');
        if (d) d.innerText = 'NO GPS';
      }
      return;
    }
    if (this.fixStale) {
      const secs = Math.round((Date.now() - (this.lastFixAt || 0)) / 1000);
      if (this.role === 'seeker') this.showRadarNotice('GPS LOST', `no new fix on this phone for ${secs}s`);
      if (this.role === 'hider') {
        const d = document.getElementById('hider-nearest-dist');
        if (d) d.innerText = 'GPS LOST';
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
          this.showRadarNotice('HIDER OFFLINE', 'hunt cancels in ' + Math.max(0, Math.ceil((35000 - this.hiderSilentMs) / 1000)) + 's');
        } else if (hiderPlayerForAcc && hiderPlayerForAcc.fixAgeMs > 15000) {
          // The hider's phone is talking but its GPS has gone quiet.
          this.showRadarNotice('NO SIGNAL', "the hider's GPS stopped");
        } else if (hiderPlayerForAcc) {
          // The hider is here and talking, but their phone has no location.
          this.showRadarNotice('NO GPS', 'hider has no location');
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

      // Show the actual number and its uncertainty so "close" is interpretable.
      if (!this.powerups.smokeActive) {
        // Rounded first, so exactly 300ft reads "300 feet" rather than tipping
        // into "100 yards" on a hair of floating-point.
        const far = Math.round(distFeet) > 300;
        const value = far ? Math.round(distFeet / 3) : Math.round(distFeet);
        const unit = far ? 'yards' : 'feet';
        this.setSeekerReadout({
          kicker: 'Hider is',
          label: bandInfo.label,
          band: bandInfo.band,
          num: value,
          // "give or take", not a plus-minus sign: a child read it as two distances.
          unit: this.isSoloDrill ? `${unit} away \u00b7 practice` : `${unit} away \u00b7 give or take ${marginFeet} ft`,
          warn: this.decoyPos ? 'May be a decoy'
            : (bandInfo.tagBlocked && (bandInfo.capped || bandInfo.band === 'HOTTER')) ? 'GPS too loose to tag'
            : (bandInfo.capped ? 'Weak GPS fix' : '')
        });
      }

      this.setGauge(distFeet);
      if (this.powerups.smokeActive) {
        // Smoke blinds every channel: no heat, no buzz, no beep, no call-out.
        // The radar hides its own ring. Only the number used to go dark, and
        // the voice kept saying exactly how close the seeker was.
        this.ambientHeat(null);
      } else {
        this.ambientHeat(distFeet);

        const now = Date.now();
        if (!this.lastPulseTime || now - this.lastPulseTime >= bandInfo.pulseMs) {
          this.lastPulseTime = now;
          window.hotspotGeo.vibratePulse(bandInfo.pulseMs);
          window.hotspotAudio.playPulseBeep(bandInfo.band);
        }

        window.hotspotAudio.announceBandChange(bandInfo.band);
      }

      if (this.powerups.bearingActive) {
        const bearing = window.hotspotGeo.calculateBearing(
          this.myPosition.lat, this.myPosition.lng,
          bufferedHiderPos.lat, bufferedHiderPos.lng
        );
        const arrow = document.getElementById('bearing-arrow');
        const note = document.getElementById('bearing-note');
        // Subtract the phone's compass heading so the point sits where the
        // player is actually facing. Only a true-north heading that is still
        // arriving is trusted — otherwise say plainly that it is measured from
        // north rather than pointing confidently in the wrong direction.
        const geo = window.hotspotGeo;
        const usable = geo.hasUsableHeading();
        const shown = usable ? (bearing - geo.deviceHeading + 360) % 360 : bearing;
        if (window.hotspotRadar) {
          // The radar shows it: the ring collapses to a point in that direction.
          window.hotspotRadar.setBearing(shown);
          if (arrow) arrow.style.display = 'none';
        } else if (arrow) {
          arrow.style.display = 'block';
          arrow.style.transform = `rotate(${shown}deg)`;
        }
        if (note) {
          note.style.display = 'block';
          note.innerText = usable
            ? 'Their direction is the point on the radar. Hold the phone flat.'
            : 'No compass. Top of the radar is north.';
          note.style.color = usable ? 'var(--accent)' : 'var(--warn)';
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
          // Dwell: one GPS jump must not end the round. The reading has to stay
          // inside the catch radius for about a second, across at least two
          // separate fixes (or three seconds if the phone's fixes are slow).
          const d = this.tagDwell || (this.tagDwell = { targetId: null, ticks: 0, fixes: {} });
          if (d.targetId !== targetId) { d.targetId = targetId; d.ticks = 0; d.fixes = {}; }
          d.ticks += 1;
          d.fixes[String(this.myPosition.timestamp || 0)] = true;
          const fixCount = Object.keys(d.fixes).length;
          const settled = this.isSoloDrill ? d.ticks >= 2 : (d.ticks >= 4 && (fixCount >= 2 || d.ticks >= 12));
          if (settled) {
            this.tagDwell = null;
            this.taggedHiderIds[targetId] = Date.now();
            this.triggerTag(this.playerId, this.playerName, targetId);
          }
        }
      } else {
        this.tagDwell = null;
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
          const far = Math.round(closestDistFeet) > 300;
          const value = far ? Math.round(closestDistFeet / 3) : Math.round(closestDistFeet);
          const unit = far ? 'yd' : 'ft';
          // Built once, then the number glides like the seeker's does and the
          // margin line is rewritten only when it changes. This used to rebuild
          // the whole thing every quarter second. A plain-text write elsewhere
          // (NO GPS, hiding time) wipes the spans, so put them back when missing.
          let val = distEl.querySelector('.dist-val'), u = distEl.querySelector('.dist-unit'), m = distEl.querySelector('.dist-margin');
          if (!val || !u || !m) {
            distEl.innerHTML = '<span class="dist-val"></span><span class="dist-unit"></span><span class="dist-margin"></span>';
            val = distEl.querySelector('.dist-val'); u = distEl.querySelector('.dist-unit'); m = distEl.querySelector('.dist-margin');
          }
          if (u.innerText !== unit) u.innerText = unit;
          this.glideNumber(val, value, unit);
          const marginText = `give or take ${margin} ft`;
          if (m.innerText !== marginText) m.innerText = marginText;
        }
        // The hider's own screen warms as the pack closes in.
        this.ambientHeat(closestDistFeet);
      } else {
        if (distEl) distEl.innerText = '-- ft';
        this.ambientHeat(null);
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

    // The state picks a background and text colour pair from the stylesheet,
    // so each one reads in both bright and night mode.
    // Each line has 10 ft of slack in the direction you came from, so a GPS
    // wobble on the line does not flip the banner and the voice every tick.
    const prev = this.boundState || 'ok';
    const H = 10;
    const outLine = this.boundaryRadius + (prev === 'out' ? -H : H);
    const edgeLine = 0.8 * this.boundaryRadius + ((prev === 'edge' || prev === 'out') ? -H : H);
    const state = distFromCenter > outLine ? 'out' : (distFromCenter > edgeLine ? 'edge' : 'ok');
    this.boundState = state;

    let text;
    if (state === 'out') {
      text = `OUT OF BOUNDS — ${Math.max(1, Math.round(distFromCenter - this.boundaryRadius))} ft over the line. Head back!`;
      if (!this.outOfBoundsSpoken) {
        this.outOfBoundsSpoken = true;
        if ('vibrate' in navigator) { try { navigator.vibrate([200, 100, 200]); } catch(e) {} }
        else if (this.role === 'hider') {
          // No buzz on this phone, and the hider's voice is off on purpose, so
          // flash the screen once the way a tag does.
          const hs = document.getElementById('hider-screen');
          if (hs) { hs.classList.add('flash-screen'); setTimeout(() => hs.classList.remove('flash-screen'), 1500); }
        }
        window.hotspotAudio.speak('Out of bounds! Head back inside the yard!');
      }
    } else if (state === 'edge') {
      this.outOfBoundsSpoken = false;
      text = `NEAR THE EDGE — ${roomLeft} ft of room left`;
    } else {
      this.outOfBoundsSpoken = false;
      text = `In bounds — ${roomLeft} ft of room left`;
    }

    banners.forEach(b => {
      b.style.display = 'block';
      b.style.background = '';
      b.style.color = '';
      b.dataset.bound = state;
      b.innerText = text;
    });
  }

  usePowerup(type) {
    // Only while the hunt is live (tapped during hiding time they used to be
    // spent for nothing), and only once the last use has cooled down.
    if (this.gameState !== 'active') return;
    if (!this.powerupReady(type)) return;
    if (type === 'decoy' && !this.myPosition) return;
    this.startCooldown(type);

    if (type === 'decoy') {
      window.hotspotAudio.playPowerupSound('decoy');
      window.hotspotAudio.speak('Decoy deployed! Fake hot signal active for 30 seconds!');
      // The hider's phone is silent during a hunt, so say it on screen too.
      this.setHiderNote('Decoy live for 30 seconds. Seekers see a fake spot.', 30000);

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

    } else if (type === 'smoke') {
      window.hotspotAudio.playPowerupSound('smoke');
      window.hotspotAudio.speak('Smoke screen thrown! Seekers blinded for 15 seconds!');
      this.setHiderNote('Smoke thrown. Seekers are blind for 15 seconds.', 15000);

      // Blur the SEEKERS' radar, not the hider's own screen.
      this.broadcastCloud({ type: 'SMOKE', durationMs: 15000 });

    } else if (type === 'bearing') {
      this.powerups.bearingActive = true;
      // Each ping gets its own number, so the end-timer of an earlier ping
      // cannot switch off a later one.
      const ping = (this.bearingPingSeq = (this.bearingPingSeq || 0) + 1);

      // iOS requires a user gesture to grant compass access; this tap is it.
      window.hotspotGeo.requestCompassPermission();

      window.hotspotAudio.playPowerupSound('bearing');
      window.hotspotAudio.speak('Pinging their direction.');

      const endPing = () => {
        if (ping !== this.bearingPingSeq) return;
        this.powerups.bearingActive = false;
        if (window.hotspotRadar) window.hotspotRadar.setBearing(null);
        const arrow = document.getElementById('bearing-arrow');
        if (arrow) arrow.style.display = 'none';
        const note = document.getElementById('bearing-note');
        if (note) note.style.display = 'none';
      };

      // The compass takes a moment to wake up, especially the first time on
      // iOS. Don't burn the 3-second ping staring at a north-referenced
      // arrow — start the clock once a real heading arrives, or after a 2s
      // grace if the device has no usable compass at all.
      const startCountdown = (waitedMs) => {
        if (ping !== this.bearingPingSeq || !this.powerups.bearingActive) return;
        if (window.hotspotGeo.hasUsableHeading() || waitedMs >= 2000) {
          setTimeout(endPing, 3000);
        } else {
          setTimeout(() => startCountdown(waitedMs + 200), 200);
        }
      };
      startCountdown(0);
    }
  }

  // The hider panel's three lines. During hiding time the big number is the
  // countdown, so the biggest thing on screen is no longer a placeholder.
  setHiderPanel(kicker, big, note) {
    const k = document.querySelector('#hider-screen .readout-kicker');
    const b = document.getElementById('hider-nearest-dist');
    const n = document.querySelector('#hider-screen .hider-note');
    if (k) k.innerText = kicker;
    if (b) b.innerText = big;
    if (n && !this.hiderNoteTimer) n.innerText = note;
    this.hiderNoteDefault = note;
  }

  // A line under the hider's number that reverts by itself, with a short buzz
  // so the hider need not look. Silent, so it gives nothing away.
  setHiderNote(text, ms) {
    const el = document.querySelector('#hider-screen .hider-note');
    if (!el) return;
    if (!this.hiderNoteDefault) this.hiderNoteDefault = el.innerText;
    el.innerText = text;
    if ('vibrate' in navigator) { try { navigator.vibrate([60, 40, 60]); } catch (e) {} }
    clearTimeout(this.hiderNoteTimer);
    this.hiderNoteTimer = setTimeout(() => { el.innerText = this.hiderNoteDefault; }, ms);
  }

  triggerSmokeVisual(active, ms = 15000) {
    this.powerups.smokeActive = active;
    const pulseRing = document.getElementById('seeker-pulse-ring');
    if (window.hotspotRadar) window.hotspotRadar.setSmoke(!!active);
    clearInterval(this.smokeTick); this.smokeTick = null;

    if (active) {
      if (pulseRing) pulseRing.classList.add('smoke-blind');
      // The seconds count down, so the number on screen is never wrong.
      const endsAt = Date.now() + ms;
      const show = () => {
        if (!this.powerups.smokeActive) { clearInterval(this.smokeTick); this.smokeTick = null; return; }
        const left = Math.max(1, Math.ceil((endsAt - Date.now()) / 1000));
        this.setSeekerReadout({ kicker: 'Signal', label: 'SMOKE SCREEN', unit: `The hider threw smoke. It clears in ${left} ${left === 1 ? 'second' : 'seconds'}.` });
      };
      show();
      this.smokeTick = setInterval(show, 1000);
    } else {
      if (pulseRing) pulseRing.classList.remove('smoke-blind');
      // Let the first band after the smoke clears announce itself.
      if (window.hotspotAudio) { window.hotspotAudio.lastSpokenBand = null; window.hotspotAudio.lastAnnouncedBand = null; }
      this.lastPulseTime = 0;
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
      timestamp: this.serverNow()
    };

    // A tag has to reach the hider and every other seeker. Previously it only
    // ever ran on the one device that made the catch.
    this.broadcastCloud({ ...tag });
    this.applyTag(tag);
  }

  applyTag(tag) {
    if (!tag) return;
    const roundKey = tag.roundId || 'noround';
    this.appliedTagByRound = this.appliedTagByRound || {};
    const prior = this.appliedTagByRound[roundKey];
    // Only a phone that is in a round can be tagged out of it. A late copy of
    // a tag (each travels twice) reaching a phone already back in the lobby
    // used to throw it onto the result screen again. The one exception is a
    // second seeker's tag for the SAME round landing just after our own: it
    // still has to be compared, or two kids who reach the hider together each
    // crown themselves and the next round starts with two hiders.
    const inRound = (this.gameState === 'active' || this.gameState === 'headstart');
    const correction = !inRound && this.gameState === 'gameover' && !!prior;
    if (!inRound && !correction) return;
    if (tag.roundId && this.currentRoundId && tag.roundId !== this.currentRoundId) return;

    // FIRST TAG WINS, once per round. Two seekers can both be inside 40ft when
    // the hider is caught, and each device applied its own local tag before the
    // other's arrived — so both players were told they made the catch. The
    // earliest timestamp wins, with a deterministic tiebreak on seekerId so
    // every device independently agrees on the same winner.
    if (prior) {
      if (prior.seekerId === tag.seekerId) return;                 // our own tag echoed back
      if (prior.timestamp < (tag.timestamp || 0)) return;          // ours was first
      if (prior.timestamp === (tag.timestamp || 0) &&
          String(prior.seekerId) < String(tag.seekerId)) return;   // tiebreak
      // The incoming tag genuinely beat ours. Undo the role swap the first one
      // made, then let the earlier tag take over.
      if (prior.roleBefore) {
        this.role = prior.roleBefore;
        if (this.players[this.playerId]) this.players[this.playerId].role = this.role;
      }
    }
    this.appliedTagByRound[roundKey] = {
      seekerId: tag.seekerId,
      timestamp: tag.timestamp || 0,
      roleBefore: this.role
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
    // Taken before the roles rotate below, for the season records.
    const wasHider = iWasTagged || this.role === 'hider';

    if (iWasTagged && 'vibrate' in navigator) {
      try { navigator.vibrate([400, 150, 400, 150, 400]); } catch(e) {}
    }

    // The hunt is over from this moment. Set first, so nobody is still muted as
    // "a hider in a live round" when the result is called out — the player who
    // made the catch used to become the next hider a line early and never
    // heard their own win.
    const durationMs = this.roundDurationMs();
    this.gameState = 'gameover';

    if (!correction) {
      window.hotspotAudio.playTagScream();
      // The catch sends a burst through the background.
      const amb = this.ambient();
      if (amb) { amb.setHeat(1); amb.pulse(1); }
    }

    if (this.isSoloDrill) {
      // A drill has no next round and nobody to swap roles with.
      window.hotspotAudio.speak('Tagged! Practice complete.');
    } else {
      // Winner hides next: the seeker who made the tag becomes the hider, and
      // the hider who was caught joins the seekers.
      if (iWasTagged) this.role = 'seeker';
      if (iTagged) this.role = 'hider';
      if (this.players[this.playerId]) this.players[this.playerId].role = this.role;

      window.hotspotAudio.speak(correction
        ? `Correction! ${tag.seekerName} got there first.${iTagged ? ' You hide next round.' : ''}`
        : iTagged
          ? `Tagged! You caught ${tag.hiderName}. You hide next round.`
          : `Tagged! ${tag.seekerName} caught ${iWasTagged ? 'you' : tag.hiderName}!`);
    }

    if (!correction) this.saveSeasonStats(durationMs, 'tag', { iTagged, wasHider });
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
  // who: { iTagged, wasHider } — what this phone did in the hunt.
  // Best tag is this player's own catch; Best hide is how long this player
  // stayed free as the hider, caught or not. Both used to take every round
  // whatever the phone's role, so a seeker who never caught anyone still
  // showed a "Best tag".
  saveSeasonStats(huntDurationMs, outcome = 'tag', who = {}) {
    // Season records are for real hunts the player took part in. A two-second
    // "Tag Hider" tap in the solo drill used to become the season's Fastest
    // Tag, and watching a hunt counted as playing one.
    if (this.isSoloDrill || this.role === 'spectator') return;
    try {
      const stats = JSON.parse(localStorage.getItem('hotspot_stats') || '{"totalHunts":0,"fastestTagSec":9999,"longestHideSec":0}');
      stats.totalHunts += 1;
      const durationSec = Math.max(0, Math.floor(huntDurationMs / 1000));

      if (outcome === 'tag' && who.iTagged && durationSec < stats.fastestTagSec) {
        stats.fastestTagSec = durationSec;
      }
      if (who.wasHider && durationSec > stats.longestHideSec) stats.longestHideSec = durationSec;

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
      // "--" until this phone has hidden once, the same as Best tag.
      if (elLongest) elLongest.innerText = stats.longestHideSec ? `${stats.longestHideSec}s` : '--';

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
  try { if (localStorage.getItem('hotspot_muted') === '1') app.toggleSound(true); } catch (e) {}
  try {
    window.addEventListener('online', () => app.refreshTransportStatus());
    window.addEventListener('offline', () => app.refreshTransportStatus());
    window.addEventListener('popstate', () => app.onBackButton());
  } catch (e) {}
  // The browser bar colour follows bright/night, including when the phone
  // itself switches.
  try {
    app.syncThemeChrome();
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) mq.addEventListener('change', () => app.syncThemeChrome());
  } catch (e) {}
  // A scanned QR code or a sent link goes straight into its room. Otherwise,
  // after a reload, put the player back in the room they were in.
  let deepLinked = false;
  try { deepLinked = app.consumeDeepLink(); } catch (e) {}
  if (!deepLinked) { try { app.tryResume(); } catch (e) {} }
}, 0);
