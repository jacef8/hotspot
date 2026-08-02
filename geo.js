/**
 * HOTSPOT - Geolocation Engine & Math Utilities
 * Handles GPS tracking, Haversine distances, 5s lag buffering >50m,
 * Solo drill simulation, GPS accuracy diagnostics, and Haptic feedback.
 */

class HotspotGeo {
  constructor() {
    this.watchId = null;
    this.currentPosition = { lat: 37.774929, lng: -122.419416, timestamp: Date.now() }; // Default fallback
    this.accuracy = 8;
    this.positionHistory = [];
    this.lagBuffer = [];
    this.soloHiderPosition = null;
    this.onPositionUpdate = null;
    this.onError = null;
    this.isProtocolWarning = false;

    this.checkProtocol();
  }

  checkProtocol() {
    const protocol = window.location.protocol;
    if (protocol === 'file:' || protocol === 'content:') {
      this.isProtocolWarning = true;
    }
  }

  startTracking(onUpdate, onError) {
    this.onPositionUpdate = onUpdate;
    this.onError = onError;

    // Immediately trigger an initial position update with fallback position
    if (this.onPositionUpdate && this.currentPosition) {
      this.onPositionUpdate({
        ...this.currentPosition,
        accuracy: this.accuracy,
        isProtocolWarning: this.isProtocolWarning
      });
    }

    if (!('geolocation' in navigator)) {
      if (this.onError) this.onError('Geolocation is not supported by this browser.');
      return;
    }

    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
    }

    const options = {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0
    };

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handlePosSuccess(pos),
      (err) => this.handlePosError(err),
      options
    );
  }

  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  handlePosSuccess(pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const accuracy = pos.coords.accuracy;
    const timestamp = pos.timestamp || Date.now();

    this.currentPosition = { lat, lng, timestamp };
    this.accuracy = accuracy;

    this.positionHistory.push({ lat, lng, accuracy, timestamp });

    if (this.onPositionUpdate) {
      this.onPositionUpdate({
        lat,
        lng,
        accuracy,
        timestamp,
        isProtocolWarning: this.isProtocolWarning
      });
    }
  }

  handlePosError(err) {
    let msg = 'Unable to get location.';
    if (err.code === err.PERMISSION_DENIED) {
      msg = 'GPS Permission Denied. Please enable Location access in browser settings.';
    } else if (err.code === err.POSITION_UNAVAILABLE) {
      msg = 'Location unavailable. Ensure GPS / Location is turned ON.';
    } else if (err.code === err.TIMEOUT) {
      msg = 'Location request timed out. Searching for GPS satellites...';
    }

    if (this.isProtocolWarning) {
      msg = 'Opened as local file — GPS requires HTTPS web server (e.g. Railway, Vercel, HTTPS).';
    }

    if (this.onError) this.onError(msg);
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  calculateBearing(lat1, lon1, lat2, lon2) {
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);

    return ((θ * 180) / Math.PI + 360) % 360;
  }

  getDistanceBand(meters) {
    if (meters > 60) return { band: 'COLD', label: 'COLD', color: '#64748B', pulseMs: 1600 };
    if (meters > 35) return { band: 'STRUCK', label: 'STRUCK', color: '#06B6D4', pulseMs: 1100 };
    if (meters > 20) return { band: 'TRAILING', label: 'TRAILING', color: '#F59E0B', pulseMs: 700 };
    if (meters > 8)  return { band: 'BAYING', label: 'BAYING', color: '#FF5500', pulseMs: 400 };
    return { band: 'TREED', label: 'TREED / TAGGED', color: '#EF4444', pulseMs: 180 };
  }

  getBufferedPosition(rawPos, realTimeHiderPos) {
    if (!rawPos || !realTimeHiderPos) return rawPos;

    const rawDist = this.calculateDistance(
      rawPos.lat, rawPos.lng,
      realTimeHiderPos.lat, realTimeHiderPos.lng
    );

    const now = Date.now();
    this.lagBuffer.push({ ...realTimeHiderPos, timestamp: now });
    this.lagBuffer = this.lagBuffer.filter(p => now - p.timestamp <= 10000);

    if (rawDist > 50) {
      const targetTime = now - 5000;
      const delayedPoint = this.lagBuffer.find(p => p.timestamp >= targetTime) || this.lagBuffer[0] || realTimeHiderPos;
      return delayedPoint;
    } else {
      return realTimeHiderPos;
    }
  }

  vibratePulse(pulseMs) {
    if ('vibrate' in navigator) {
      try {
        const duration = Math.min(100, Math.max(30, Math.floor(pulseMs * 0.25)));
        navigator.vibrate(duration);
      } catch (e) {}
    }
  }

  /**
   * Solo Drill: Plant a virtual hider ~distanceMeters out
   */
  startSoloDrill(distanceMeters = 100) {
    if (!this.currentPosition) {
      this.currentPosition = { lat: 37.774929, lng: -122.419416, timestamp: Date.now() };
    }

    return this.setSoloHiderDistance(distanceMeters);
  }

  setSoloHiderDistance(distanceMeters) {
    const bearingDeg = 45; // Fixed 45 degree bearing for deterministic test movement
    const bearingRad = (bearingDeg * Math.PI) / 180;

    const R = 6371e3;
    const lat1 = (this.currentPosition.lat * Math.PI) / 180;
    const lon1 = (this.currentPosition.lng * Math.PI) / 180;

    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(distanceMeters / R) +
      Math.cos(lat1) * Math.sin(distanceMeters / R) * Math.cos(bearingRad)
    );

    const lon2 = lon1 + Math.atan2(
      Math.sin(bearingRad) * Math.sin(distanceMeters / R) * Math.cos(lat1),
      Math.cos(distanceMeters / R) - Math.sin(lat1) * Math.sin(lat2)
    );

    this.soloHiderPosition = {
      lat: (lat2 * 180) / Math.PI,
      lng: (lon2 * 180) / Math.PI,
      timestamp: Date.now(),
      isVirtual: true,
      currentDistMeters: distanceMeters
    };

    return this.soloHiderPosition;
  }

  moveSoloHiderCloser(deltaMeters = 25) {
    if (!this.soloHiderPosition) this.startSoloDrill(100);
    const currentDist = this.soloHiderPosition.currentDistMeters || 100;
    const newDist = Math.max(2, currentDist - deltaMeters);
    return this.setSoloHiderDistance(newDist);
  }

  moveSoloHiderAway(deltaMeters = 25) {
    if (!this.soloHiderPosition) this.startSoloDrill(100);
    const currentDist = this.soloHiderPosition.currentDistMeters || 100;
    const newDist = Math.min(200, currentDist + deltaMeters);
    return this.setSoloHiderDistance(newDist);
  }
}

window.hotspotGeo = new HotspotGeo();
