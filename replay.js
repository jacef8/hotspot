/**
 * HOTSPOT - Leaflet Map Engine
 * Powers Spectator (God View) & Post-game Track Replay
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

    // Load dark tile layer (CartoDB Dark Matter)
    this.map = L.map(elementId, { zoomControl: true }).setView(center, zoom);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 20
    }).addTo(this.map);

    setTimeout(() => {
      if (this.map) this.map.invalidateSize();
    }, 200);
  }

  updateSpectatorView(playersData) {
    if (!this.map) return;

    const bounds = [];

    Object.values(playersData).forEach(player => {
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

    if (bounds.length > 0 && !this.userHasPanned) {
      this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 19 });
    }
  }

  loadReplayData(tracks, tagEvent = null) {
    this.replayTracks = tracks; // Array of { playerId, name, role, points: [{lat, lng, timestamp}] }
    this.tagEvent = tagEvent;
    this.replayStep = 0;
    this.isPlaying = false;

    // Find all points for center bounds
    const allPoints = [];
    tracks.forEach(t => {
      t.points.forEach(p => allPoints.push([p.lat, p.lng]));
    });

    if (allPoints.length > 0) {
      this.initMap('replay-map', allPoints[0], 17);
      this.map.fitBounds(allPoints, { padding: [40, 40] });
    }

    if (this.tagEvent && this.tagEvent.lat) {
      const tagMarkerHtml = `
        <div style="
          background: #EF4444;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          border: 3px solid #FFF;
          box-shadow: 0 0 16px #EF4444;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
        ">
          🎯
        </div>
      `;
      L.marker([this.tagEvent.lat, this.tagEvent.lng], {
        icon: L.divIcon({ html: tagMarkerHtml, className: 'tag-marker', iconSize: [32, 32] })
      }).addTo(this.map).bindTooltip(`TAGGED! ${this.tagEvent.seekerName} caught ${this.tagEvent.hiderName}`, { permanent: true });
    }

    setTimeout(() => {
      if (this.map) this.map.invalidateSize();
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
