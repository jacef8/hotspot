/**
 * HOTSPOT - Leaflet Map Engine
 * Powers Spectator View & Post-game Track Replay
 */

class HotspotReplay {
  constructor() {
    this.map = null;
    this.markers = {};
    this.polylines = {};
    this.accuracyCircles = {};
    this.replayTracks = [];
    this.replayInterval = null;
    this.replayStep = 0;
    this.isPlaying = false;
    this.playbackSpeed = 1;
    this.boundaryCircle = null;

    // Auto-follow state. `userHasPanned` was read by updateSpectatorView but
    // never assigned anywhere, so it was permanently false and the map re-fit
    // its bounds on every position update — a spectator could not zoom into one
    // corner of the yard without being snapped back a second later.
    this.userHasPanned = false;
    this.lastBounds = [];
    this.programmaticUntil = 0;
  }

  // Our own fitBounds/setView calls also fire movestart/zoomstart, so mark a
  // short window around them to tell "the app moved the map" apart from
  // "the user moved the map".
  markProgrammatic() {
    this.programmaticUntil = Date.now() + 800;
  }

  isProgrammatic() {
    return Date.now() < this.programmaticUntil;
  }

  setUserPanned(panned) {
    this.userHasPanned = panned;
    // Both the spectator and replay screens carry a recenter button.
    document.querySelectorAll('.map-recenter-btn').forEach(btn => {
      btn.style.display = panned ? 'block' : 'none';
    });
  }

  // Resume auto-follow and snap back to the whole field.
  recenterMap() {
    this.setUserPanned(false);
    if (this.map && this.lastBounds && this.lastBounds.length > 0) {
      this.markProgrammatic();
      this.map.fitBounds(this.lastBounds, { padding: [50, 50], maxZoom: 19 });
    }
  }

  // Draw the yard limit on the map. Players in the field only get a numeric
  // "room left" readout, so this is the one place the limit is actually visible
  // as a shape — useful for a parent running the game from the spectator map.
  setBoundary(centerPos, radiusFeet) {
    if (!this.map || typeof L === 'undefined') return;

    if (!centerPos || !radiusFeet || radiusFeet <= 0) {
      if (this.boundaryCircle) {
        try { this.map.removeLayer(this.boundaryCircle); } catch(e) {}
        this.boundaryCircle = null;
      }
      return;
    }

    const radiusMeters = radiusFeet / 3.28084;
    const latLng = [centerPos.lat, centerPos.lng];

    if (this.boundaryCircle) {
      this.boundaryCircle.setLatLng(latLng);
      this.boundaryCircle.setRadius(radiusMeters);
      return;
    }

    this.boundaryCircle = L.circle(latLng, {
      radius: radiusMeters,
      color: '#FFB020',
      weight: 2,
      dashArray: '6, 6',
      fill: true,
      fillColor: '#FFB020',
      fillOpacity: 0.07
    }).addTo(this.map);
    this.boundaryCircle.bindTooltip(`Yard limit — ${radiusFeet}ft`, { permanent: false });
  }

  initMap(elementId, center = [37.774929, -122.419416], zoom = 17) {
    if (this.map) {
      this.map.remove();
      this.map = null;
      this.markers = {};
      this.polylines = {};
      this.accuracyCircles = {};
      // The yard circle belonged to the map just removed. Left set, the next
      // setBoundary call updated that dead layer and drew nothing on this one.
      this.boundaryCircle = null;
    }

    const container = document.getElementById(elementId);
    if (!container) return;

    // Leaflet is loaded from a CDN. If it did not arrive, skip the map rather
    // than throwing — this runs inside the post-tag gameover handler.
    if (typeof L === 'undefined') {
      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:15px;font-weight:600;color:rgba(255,255,255,.9);text-align:center;padding:12px;">Map unavailable — no connection to map server.</div>';
      return;
    }

    this.map = L.map(elementId, { zoomControl: true }).setView(center, zoom);

    // A freshly built map starts following again.
    this.setUserPanned(false);
    this.lastBounds = [];

    // Any drag is unambiguously the user. Zoom/move can be either, so only
    // count it when we did not just move the map ourselves.
    this.map.on('dragstart', () => this.setUserPanned(true));
    this.map.on('zoomstart movestart', () => {
      if (!this.isProgrammatic()) this.setUserPanned(true);
    });

    // Satellite imagery (Esri World Imagery — no API key required). An aerial
    // view makes the tag spot readable against real yard features: driveways,
    // fences, tree lines. Note the {z}/{y}/{x} order — Esri differs from OSM.
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
      maxZoom: 21,
      maxNativeZoom: 19
    }).addTo(this.map);

    // Road and place-name overlay so streets stay readable on top of imagery.
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 21,
      maxNativeZoom: 19,
      opacity: 0.85
    }).addTo(this.map);

    setTimeout(() => {
      if (this.map) this.map.invalidateSize();
    }, 200);
  }

  // replayMode: positions come from the recorded tracks (each with its full
  // trail so far) rather than live, and the view is left where the user put it.
  updateSpectatorView(playersData, replayMode = false) {
    if (!this.map) return;

    const bounds = [];
    const present = {};

    Object.values(playersData).forEach(player => {
      // Spectators watch; they are not pieces on the board.
      if (player.role === 'spectator') return;
      if (!player.lat || !player.lng) return;

      const latlng = [player.lat, player.lng];
      bounds.push(latlng);
      present[player.id] = true;

      const isHider = player.role === 'hider';
      // The app's own palette: the target is hot, everyone else is cold.
      const color = isHider ? '#FF6B3D' : '#7DD3FC';
      // Accuracy arrives in feet; Leaflet draws radii in metres. Passing feet
      // straight through drew every uncertainty ring 3.3 times too large.
      const accuracyMeters = (player.accuracy || 33) / 3.28084;

      // Update or create marker
      if (!this.markers[player.id]) {
        const iconHtml = `
          <div style="
            background: ${color};
            width: 22px;
            height: 22px;
            border-radius: 50%;
            border: 3px solid #FFF;
            box-shadow: 0 0 6px ${color};
            display: flex;
            align-items: center;
            justify-content: center;
            color: #000;
            font-weight: 800;
            font-size: 13px;
          ">
            ${isHider ? 'H' : 'S'}
          </div>
        `;
        const customIcon = L.divIcon({
          html: iconHtml,
          className: 'custom-player-marker',
          iconSize: [28, 28]
        });

        this.markers[player.id] = L.marker(latlng, { icon: customIcon })
          .addTo(this.map)
          .bindTooltip(`${window.hsEscape(player.name)} (${window.hsEscape(String(player.role).toUpperCase())})`, { permanent: true, direction: 'top' });

        this.polylines[player.id] = L.polyline(player.trail || [latlng], {
          color: color,
          weight: 4,
          opacity: 0.7,
          dashArray: isHider ? null : '6, 6'
        }).addTo(this.map);

        this.accuracyCircles[player.id] = L.circle(latlng, {
          radius: accuracyMeters,
          color: color,
          fillColor: color,
          fillOpacity: 0.15,
          weight: 1
        }).addTo(this.map);

      } else {
        this.markers[player.id].setLatLng(latlng);
        this.accuracyCircles[player.id].setLatLng(latlng);
        this.accuracyCircles[player.id].setRadius(accuracyMeters);

        if (player.trail) {
          // Replay: the trail is exactly the track up to this moment, so
          // scrubbing backwards shortens it again.
          this.polylines[player.id].setLatLngs(player.trail);
        } else {
          // Live: add a breadcrumb only when the player has actually moved.
          // This runs four times a second and used to append every time.
          const points = this.polylines[player.id].getLatLngs();
          const last = points[points.length - 1];
          if (!last || last.lat !== latlng[0] || last.lng !== latlng[1]) {
            points.push(latlng);
            this.polylines[player.id].setLatLngs(points);
          }
        }
      }
    });

    // Anyone no longer on the field comes off the map. A player who left used
    // to stay pinned at their last position for the rest of the hunt.
    Object.keys(this.markers).forEach((id) => {
      if (present[id]) return;
      [this.markers, this.polylines, this.accuracyCircles].forEach((group) => {
        if (group[id]) { try { this.map.removeLayer(group[id]); } catch (e) {} delete group[id]; }
      });
    });

    // The replay keeps the whole field in view (set once when it loads), so
    // the map does not lurch about while the tracks play.
    if (replayMode) return;

    // Remember the field extent even while the user is panning, so Recenter
    // has somewhere to snap back to.
    if (bounds.length > 0) {
      this.lastBounds = bounds;
      if (!this.userHasPanned) {
        this.markProgrammatic();
        this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 19 });
      }
    }
  }

  loadReplayData(tracks, tagEvent = null, fallbackCenter = null) {
    this.pauseReplay();
    this.replayTracks = tracks || []; // Array of { playerId, name, role, points: [{lat, lng, timestamp}] }
    this.tagEvent = tagEvent;
    this.replayPct = 100;
    this.isPlaying = false;

    // Full extent of every track, so Recenter works on the replay map too.
    const trackBounds = [];
    (tracks || []).forEach(t => {
      (t.points || []).forEach(p => trackBounds.push([p.lat, p.lng]));
    });

    if (this.tagEvent && this.tagEvent.lat && this.tagEvent.lng) {
      // Zoom WAY in directly to the location the person was caught (Zoom Level 19)
      const tagCenter = [this.tagEvent.lat, this.tagEvent.lng];
      this.initMap('replay-map', tagCenter, 19);
      this.lastBounds = trackBounds.length > 0 ? trackBounds : [tagCenter];
    } else {
      // Find all points for center bounds
      const allPoints = [];
      tracks.forEach(t => {
        t.points.forEach(p => allPoints.push([p.lat, p.lng]));
      });

      if (allPoints.length > 0) {
        this.initMap('replay-map', allPoints[0], 18);
        this.lastBounds = allPoints;
        this.markProgrammatic();
        if (this.map) this.map.fitBounds(allPoints, { padding: [30, 30], maxZoom: 19 });
      } else if (fallbackCenter && fallbackCenter.lat && fallbackCenter.lng) {
        // Nothing was recorded; at least open on the yard instead of leaving
        // whatever map was on screen before.
        this.initMap('replay-map', [fallbackCenter.lat, fallbackCenter.lng], 18);
      } else {
        this.initMap('replay-map');
      }
    }

    if (this.map && this.tagEvent && this.tagEvent.lat) {
      const tagMarkerHtml = `
        <div style="
          background: #FF4257;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          border: 3px solid #FFF;
          box-shadow: 0 0 20px #FF4257;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #FFF;
          font-weight: 800;
          font-size: 15px;
        ">
          &#10005;
        </div>
      `;
      L.marker([this.tagEvent.lat, this.tagEvent.lng], {
        icon: L.divIcon({ html: tagMarkerHtml, className: 'tag-marker', iconSize: [36, 36] })
      }).addTo(this.map).bindTooltip(`TAGGED! ${window.hsEscape(this.tagEvent.seekerName)} caught ${window.hsEscape(this.tagEvent.hiderName)}`, { permanent: true, direction: 'top' });
    }

    setTimeout(() => {
      if (this.map) {
        this.map.invalidateSize();
        // Only re-snap to the tag if the user has not started exploring the map.
        if (this.tagEvent && this.tagEvent.lat && this.tagEvent.lng && !this.userHasPanned) {
          this.markProgrammatic();
          this.map.setView([this.tagEvent.lat, this.tagEvent.lng], 19);
        }
        // Open on the finished picture: everyone where they ended up, with the
        // whole of their trail behind them. Play runs it again from the start.
        this.stepReplay(100);
      }
    }, 250);
  }

  // First and last moment anything was recorded, across every track.
  replayRange() {
    let t0 = Infinity, t1 = -Infinity;
    (this.replayTracks || []).forEach((t) => (t.points || []).forEach((p) => {
      if (p.timestamp < t0) t0 = p.timestamp;
      if (p.timestamp > t1) t1 = p.timestamp;
    }));
    return isFinite(t0) ? { t0, t1 } : null;
  }

  // Move the replay to a moment in TIME. It used to step every track by point
  // count, and tracks do not have the same number of points — your own is
  // logged every second, everyone else's only when a heartbeat arrives — so
  // the players were not shown where they were at the same instant.
  stepReplay(progressPercent) {
    const range = this.replayRange();
    if (!range) return;

    const pct = Math.max(0, Math.min(100, Number(progressPercent) || 0));
    this.replayPct = pct;
    const t = range.t0 + (range.t1 - range.t0) * (pct / 100);

    const currentPlayers = {};
    this.replayTracks.forEach((track) => {
      const pts = track.points || [];
      if (!pts.length) return;
      // Everything this player had done by time t. Before their first recorded
      // point, stand them on it — that is where they were, near enough.
      let upto = pts.filter((p) => p.timestamp <= t);
      if (!upto.length) upto = [pts[0]];
      const point = upto[upto.length - 1];
      currentPlayers[track.playerId] = {
        id: track.playerId,
        name: track.name,
        role: track.role,
        lat: point.lat,
        lng: point.lng,
        accuracy: point.accuracy || 25,
        trail: upto.map((p) => [p.lat, p.lng])
      };
    });

    this.updateSpectatorView(currentPlayers, true);
  }

  playReplay(onProgressUpdate) {
    if (this.isPlaying) return;
    const range = this.replayRange();
    if (!range) return;

    // Play on a finished replay starts over; it used to do nothing at all.
    if ((this.replayPct || 0) >= 100) this.replayPct = 0;
    this.isPlaying = true;

    // The whole round in about twenty seconds, never slower than it happened.
    const roundSec = Math.max(1, (range.t1 - range.t0) / 1000);
    const stepPct = 100 / (Math.min(roundSec, 20) * 10);

    this.replayInterval = setInterval(() => {
      const pct = Math.min(100, (this.replayPct || 0) + stepPct * this.playbackSpeed);
      this.stepReplay(pct);
      if (onProgressUpdate) onProgressUpdate(pct);
      if (pct >= 100) this.pauseReplay();
    }, 100);
  }

  pauseReplay() {
    this.isPlaying = false;
    if (this.replayInterval) {
      clearInterval(this.replayInterval);
      this.replayInterval = null;
    }
  }

  setSpeed(speed) {
    this.playbackSpeed = speed;
    if (this.isPlaying) {
      this.pauseReplay();
      this.playReplay();
    }
  }
}

window.hotspotReplay = new HotspotReplay();
