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
    // The extent the live map last fitted itself to, so GPS jitter that moves
    // nobody more than a few feet does not start another fit.
    this.fittedBounds = null;
    this.programmatic = false;
  }

  // Move the map ourselves without it counting as the user's doing. Our own
  // fitBounds/setView fire the same movestart/zoomstart a finger does, so the
  // flag goes up for the move and the map's own moveend takes it down. It used
  // to be an 800 ms window, refreshed four times a second while following, so
  // it never closed: a pinch read as the app's move and snapped straight back.
  moveMap(fn) {
    if (!this.map) return;
    // Settling a pan still in flight fires its own moveend; get that out of
    // the way before the flag goes up, or it would take it down at once.
    try { this.map.stop(); } catch (e) {}
    this.programmatic = true;
    try { fn(this.map); } catch (e) { this.programmatic = false; }
  }

  isProgrammatic() {
    return this.programmatic;
  }

  // A token's current value, for the colour strings Leaflet wants when a layer
  // is first drawn. Each layer also carries a class, so a theme switch
  // restyles it from the stylesheet without redrawing.
  token(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
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
      this.fittedBounds = L.latLngBounds(this.lastBounds);
      this.moveMap((m) => m.fitBounds(this.lastBounds, { padding: [50, 50], maxZoom: 19 }));
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

    const yard = this.token('--warn-fill', '#F5A524');
    this.boundaryCircle = L.circle(latLng, {
      className: 'hs-yard',
      radius: radiusMeters,
      color: yard,
      weight: 2,
      dashArray: '6, 6',
      fill: true,
      fillColor: yard,
      fillOpacity: 0.07
    }).addTo(this.map);
    this.boundaryCircle.bindTooltip(`Yard limit — ${radiusFeet}ft`, { permanent: false });
  }

  initMap(elementId, center = [37.774929, -122.419416], zoom = 17) {
    // A replay still running would keep drawing last round's tracks onto
    // whatever map comes next.
    this.pauseReplay();
    if (elementId === 'spectator-map') {
      // A new round: last round's recording is done with. Left in place, Play
      // on the next result screen could run the old tracks over the new ones.
      this.replayTracks = [];
      this.tagEvent = null;
      this.replayPct = 0;
    }

    if (this.map) {
      const old = this.map;
      this.map = null;
      // Finish a zoom still animating: Leaflet's own end-of-zoom timer fired
      // after the panes were gone and threw from inside the dead map.
      try { if (old._animatingZoom && typeof old._onZoomTransitionEnd === 'function') old._onZoomTransitionEnd(); } catch (e) {}
      try { old.stop(); } catch (e) {}
      // remove() leaves Leaflet's scroll handler on the container, which kept
      // every old map reachable; take it off before letting the map go.
      try { if (old._container && old._onScroll) L.DomEvent.off(old._container, 'scroll', old._onScroll, old); } catch (e) {}
      try { old.remove(); } catch (e) {}
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
      container.innerHTML = '<div class="map-empty">Map unavailable. No connection to the map server.</div>';
      return;
    }

    const map = this.map = L.map(elementId, { zoomControl: true }).setView(center, zoom);
    // Esri's credit stays; the "Leaflet" prefix made the strip span the map.
    try { map.attributionControl.setPrefix(false); } catch (e) {}

    // A freshly built map starts following again.
    this.setUserPanned(false);
    this.lastBounds = [];
    this.fittedBounds = null;
    this.programmatic = false;

    // Events from a map we have since replaced are not this map's business.
    const live = () => this.map === map;
    // Any drag is unambiguously the user. Zoom/move can be either, so only
    // count it when the move is not one we started ourselves.
    map.on('dragstart', () => { if (live()) this.setUserPanned(true); });
    map.on('zoomstart movestart', () => {
      if (live() && !this.isProgrammatic()) this.setUserPanned(true);
    });
    map.on('moveend', () => { if (live()) this.programmatic = false; });

    // A pinch, a double tap, a mouse wheel or the +/- buttons while our own
    // fit is still animating never reach Leaflet as a zoom, so read them off
    // the container. The container outlives the maps built in it, so it gets
    // these once.
    const el = map.getContainer();
    if (el && !el.dataset.hsZoomWatch) {
      el.dataset.hsZoomWatch = '1';
      const userZoom = () => { if (this.map && this.map.getContainer() === el) this.setUserPanned(true); };
      el.addEventListener('touchstart', (e) => { if (e.touches && e.touches.length >= 2) userZoom(); }, { passive: true });
      el.addEventListener('wheel', userZoom, { passive: true });
      el.addEventListener('dblclick', userZoom);
      // Capture phase: the +/- buttons stop their click from bubbling.
      el.addEventListener('click', (e) => { if (e.target && e.target.closest && e.target.closest('.leaflet-control-zoom')) userZoom(); }, true);
    }

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
      if (this.map !== map) return;
      map.invalidateSize();
      // The first fit may have run before the box had its final size.
      this.fittedBounds = null;
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
      // The same tokens as the lobby and the readouts: the hider wears the
      // hider colour, seekers the accent. The marker and the SVG layers each
      // carry a class, so a theme switch recolours them from the stylesheet.
      const kind = isHider ? 'hider' : 'seeker';
      const color = this.token(isHider ? '--hider-fill' : '--accent', isHider ? '#B03A06' : '#0A5BC4');
      // Accuracy arrives in feet; Leaflet draws radii in metres. Passing feet
      // straight through drew every uncertainty ring 3.3 times too large.
      const accuracyMeters = (player.accuracy || 33) / 3.28084;

      // Update or create marker
      if (!this.markers[player.id]) {
        // The icon box is the dot's own size, so the dot sits centred on the
        // GPS point instead of a few pixels off it.
        const customIcon = L.divIcon({
          html: `<div class="hs-marker hs-marker-${kind}">${isHider ? 'H' : 'S'}</div>`,
          className: 'custom-player-marker',
          iconSize: [22, 22]
        });

        this.markers[player.id] = L.marker(latlng, { icon: customIcon })
          .addTo(this.map)
          .bindTooltip(`${window.hsEscape(player.name)} (${window.hsEscape(String(player.role).toUpperCase())})`, { permanent: true, direction: 'top', offset: [0, -12] });

        this.polylines[player.id] = L.polyline(player.trail || [latlng], {
          className: `hs-track ${kind}`,
          color: color,
          weight: 4,
          opacity: 0.7,
          dashArray: isHider ? null : '6, 6'
        }).addTo(this.map);

        this.accuracyCircles[player.id] = L.circle(latlng, {
          className: `hs-track ${kind}`,
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
        // Fit again only when the field has changed shape by more than GPS
        // jitter (about 10 feet at either corner). Four fits a second kept
        // the map permanently mid-animation.
        const next = L.latLngBounds(bounds);
        const prev = this.fittedBounds;
        const same = prev && this.map.distance(prev.getSouthWest(), next.getSouthWest()) < 3
          && this.map.distance(prev.getNorthEast(), next.getNorthEast()) < 3;
        if (!same) {
          this.fittedBounds = next;
          this.moveMap((m) => m.fitBounds(next, { padding: [50, 50], maxZoom: 19 }));
        }
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
    // Play and the slider need a recorded moment to go to, not just a point.
    this.setReplayControls(!!this.replayRange());

    if (this.tagEvent && this.tagEvent.lat && this.tagEvent.lng) {
      // Zoom WAY in directly to the location the person was caught (Zoom Level 19)
      const tagCenter = [this.tagEvent.lat, this.tagEvent.lng];
      this.initMap('replay-map', tagCenter, 19);
      this.lastBounds = trackBounds.length > 0 ? trackBounds : [tagCenter];
    } else {
      const allPoints = trackBounds;

      if (allPoints.length > 0) {
        this.initMap('replay-map', allPoints[0], 18);
        this.lastBounds = allPoints;
        this.moveMap((m) => m.fitBounds(allPoints, { padding: [30, 30], maxZoom: 19 }));
      } else if (fallbackCenter && fallbackCenter.lat && fallbackCenter.lng) {
        // Nothing was recorded; at least open on the yard instead of leaving
        // whatever map was on screen before.
        this.initMap('replay-map', [fallbackCenter.lat, fallbackCenter.lng], 18);
      } else {
        this.initMap('replay-map');
      }
    }

    if (this.map && this.tagEvent && this.tagEvent.lat) {
      // The same x as the rest of the app's icons, in the tag colour.
      const tagMarkerHtml = '<div class="hs-marker hs-marker-tag"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></div>';
      L.marker([this.tagEvent.lat, this.tagEvent.lng], {
        icon: L.divIcon({ html: tagMarkerHtml, className: 'tag-marker', iconSize: [30, 30] }),
        // On top of the two dots that end up on the same spot.
        zIndexOffset: 1000
      }).addTo(this.map).bindTooltip(
        `${window.hsEscape(this.tagEvent.seekerName)} caught ${window.hsEscape(this.tagEvent.hiderName)} here`,
        // Below the x, clear of the players' name labels, which sit above
        // their dots. Three labels on one point read as none.
        { permanent: true, direction: 'bottom', offset: [0, 14], className: 'hs-tip-tag' }
      );
    }

    setTimeout(() => {
      if (this.map) {
        this.map.invalidateSize();
        // Only re-snap to the tag if the user has not started exploring the map.
        if (this.tagEvent && this.tagEvent.lat && this.tagEvent.lng && !this.userHasPanned) {
          this.moveMap((m) => m.setView([this.tagEvent.lat, this.tagEvent.lng], 19));
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
    this.syncReplayLabels(pct);
  }

  // At the end of the hunt the hider and the seeker who caught them stand on
  // the tag spot, and their name labels printed over the tag label there.
  // Only the tag's own label stays on that spot; the names come back as soon
  // as the replay moves off the end.
  syncReplayLabels(pct) {
    if (!this.map) return;
    const tag = this.tagEvent;
    const atEnd = pct >= 100 && !!(tag && tag.lat && tag.lng);
    Object.values(this.markers).forEach((marker) => {
      if (!marker.getTooltip || !marker.getTooltip()) return;
      // About 30 feet: GPS error on both sides of a tag.
      const hide = atEnd && this.map.distance(marker.getLatLng(), [tag.lat, tag.lng]) < 9.2;
      try {
        const open = marker.isTooltipOpen();
        if (hide && open) marker.closeTooltip();
        else if (!hide && !open) marker.openTooltip();
      } catch (e) {}
    });
  }

  // Without a recorded track there is nothing to play. A phone that reloaded
  // or joined late has none, and its slider and Play used to look live while
  // ignoring every tap.
  setReplayControls(hasTrack) {
    const slider = document.getElementById('replay-slider');
    const btn = document.getElementById('btn-replay-toggle');
    const note = document.getElementById('replay-empty-note');
    if (slider) slider.disabled = !hasTrack;
    if (btn) btn.disabled = !hasTrack;
    if (note) note.style.display = hasTrack ? 'none' : 'block';
  }

  playReplay(onProgressUpdate) {
    if (this.isPlaying) return;
    const range = this.replayRange();
    if (!range) return;

    // Play on a finished replay starts over; it used to do nothing at all.
    if ((this.replayPct || 0) >= 100) this.replayPct = 0;
    this.isPlaying = true;
    this.syncReplayButton();

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
    this.syncReplayButton();
  }

  // One button for play and pause. Two always-live buttons used to sit side by
  // side, and nothing on them said whether the replay was running.
  toggleReplay(onProgressUpdate) {
    if (this.isPlaying) this.pauseReplay();
    else this.playReplay(onProgressUpdate);
  }

  // The label follows the state wherever it changes: a tap, the run reaching
  // the end, a new result loading.
  syncReplayButton() {
    const btn = document.getElementById('btn-replay-toggle');
    if (btn) btn.innerText = this.isPlaying ? 'Pause' : 'Play replay';
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
