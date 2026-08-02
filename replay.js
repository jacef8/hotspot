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
      color: '#F59E0B',
      weight: 2,
      dashArray: '6, 6',
      fill: true,
      fillColor: '#F59E0B',
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
    }

    const container = document.getElementById(elementId);
    if (!container) return;

    // Leaflet is loaded from a CDN. If it did not arrive, skip the map rather
    // than throwing — this runs inside the post-tag gameover handler.
    if (typeof L === 'undefined') {
      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;color:#94A3B8;text-align:center;padding:12px;">Map unavailable — no connection to map server.</div>';
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

  updateSpectatorView(playersData) {
    if (!this.map) return;

    const bounds = [];

    Object.values(playersData).forEach(player => {
      // Spectators watch; they are not pieces on the board.
      if (player.role === 'spectator') return;
      if (!player.lat || !player.lng) return;

      const latlng = [player.lat, player.lng];
      bounds.push(latlng);

      const isHider = player.role === 'hider';
      const color = isHider ? '#FF5500' : '#00F0FF';

      // Update or create marker
      if (!this.markers[player.id]) {
        const iconHtml = `
          <div style="
            background: ${color};
            width: 18px;
            height: 18px;
            border-radius: 50%;
            border: 3px solid #FFF;
            box-shadow: 0 0 12px ${color};
            display: flex;
            align-items: center;
            justify-content: center;
            color: #000;
            font-weight: bold;
            font-size: 10px;
          ">
            ${isHider ? 'H' : 'S'}
          </div>
        `;
        const customIcon = L.divIcon({
          html: iconHtml,
          className: 'custom-player-marker',
          iconSize: [24, 24]
        });

        this.markers[player.id] = L.marker(latlng, { icon: customIcon })
          .addTo(this.map)
          .bindTooltip(`${player.name} (${player.role.toUpperCase()})`, { permanent: true, direction: 'top' });

        this.polylines[player.id] = L.polyline([latlng], {
          color: color,
          weight: 4,
          opacity: 0.7,
          dashArray: isHider ? null : '6, 6'
        }).addTo(this.map);

        this.accuracyCircles[player.id] = L.circle(latlng, {
          radius: player.accuracy || 10,
          color: color,
          fillColor: color,
          fillOpacity: 0.15,
          weight: 1
        }).addTo(this.map);

      } else {
        this.markers[player.id].setLatLng(latlng);
        this.accuracyCircles[player.id].setLatLng(latlng);
        if (player.accuracy) {
          this.accuracyCircles[player.id].setRadius(player.accuracy);
        }

        // Add to breadcrumb trail
        const points = this.polylines[player.id].getLatLngs();
        points.push(latlng);
        this.polylines[player.id].setLatLngs(points);
      }
    });

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

  loadReplayData(tracks, tagEvent = null) {
    this.replayTracks = tracks; // Array of { playerId, name, role, points: [{lat, lng, timestamp}] }
    this.tagEvent = tagEvent;
    this.replayStep = 0;
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
        this.map.fitBounds(allPoints, { padding: [30, 30], maxZoom: 19 });
      }
    }

    if (this.tagEvent && this.tagEvent.lat) {
      const tagMarkerHtml = `
        <div style="
          background: #EF4444;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          border: 3px solid #FFF;
          box-shadow: 0 0 20px #EF4444;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
        ">
          🎯
        </div>
      `;
      L.marker([this.tagEvent.lat, this.tagEvent.lng], {
        icon: L.divIcon({ html: tagMarkerHtml, className: 'tag-marker', iconSize: [36, 36] })
      }).addTo(this.map).bindTooltip(`TAGGED! ${this.tagEvent.seekerName} caught ${this.tagEvent.hiderName}`, { permanent: true, direction: 'top' });
    }

    setTimeout(() => {
      if (this.map) {
        this.map.invalidateSize();
        // Only re-snap to the tag if the user has not started exploring the map.
        if (this.tagEvent && this.tagEvent.lat && this.tagEvent.lng && !this.userHasPanned) {
          this.markProgrammatic();
          this.map.setView([this.tagEvent.lat, this.tagEvent.lng], 19);
        }
      }
    }, 250);
  }

  stepReplay(progressPercent) {
    if (!this.replayTracks || this.replayTracks.length === 0) return;

    // Find max points count
    const maxPoints = Math.max(...this.replayTracks.map(t => t.points.length));
    const targetStep = Math.floor((progressPercent / 100) * (maxPoints - 1));

    this.replayStep = targetStep;

    const currentPlayers = {};
    this.replayTracks.forEach(track => {
      const point = track.points[Math.min(targetStep, track.points.length - 1)];
      if (point) {
        currentPlayers[track.playerId] = {
          id: track.playerId,
          name: track.name,
          role: track.role,
          lat: point.lat,
          lng: point.lng,
          accuracy: point.accuracy || 8
        };
      }
    });

    this.updateSpectatorView(currentPlayers);
  }

  playReplay(onProgressUpdate) {
    if (this.isPlaying) return;
    this.isPlaying = true;

    const maxPoints = Math.max(...this.replayTracks.map(t => t.points.length));

    this.replayInterval = setInterval(() => {
      this.replayStep += 1;
      if (this.replayStep >= maxPoints) {
        this.pauseReplay();
        this.replayStep = maxPoints - 1;
      }

      const percent = (this.replayStep / (maxPoints - 1)) * 100;
      this.stepReplay(percent);
      if (onProgressUpdate) onProgressUpdate(percent);
    }, 1000 / this.playbackSpeed);
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
