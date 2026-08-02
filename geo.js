/**
 * HOTSPOT - Geolocation Engine & Math Utilities
 * Optimized for Android & iOS mobile browsers.
 * Standard US Customary Units (Feet & Yards).
 */

class HotspotGeo {
  constructor() {
    this.watchId = null;
    this.currentPosition = { lat: 37.774929, lng: -122.419416, timestamp: Date.now() }; // Default fallback
    this.accuracyFeet = 25;
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

    if (this.onPositionUpdate && this.currentPosition) {
      this.onPositionUpdate({
        ...this.currentPosition,
        accuracy: this.accuracyFeet,
        isProtocolWarning: this.isProtocolWarning
      });
    }

    if (!('geolocation' in navigator)) {
      if (this.onError) this.onError('Geolocation is not supported by this browser.');
      return;
    }

    const options = {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 3000
    };

    // Explicitly call getCurrentPosition FIRST to force Android permission prompt & instant fix!
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => this.handlePosSuccess(pos),
        (err) => this.handlePosError(err),
        options
      );
    } catch(e) {}

    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
    }

    try {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this.handlePosSuccess(pos),
        (err) => this.handlePosError(err),
        options
      );
    } catch(e) {}
  }

  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  handlePosSuccess(pos) {
    if (!pos || !pos.coords) return;

    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const accuracyMeters = pos.coords.accuracy || 8;
    const accuracyFeet = Math.round(accuracyMeters * 3.28084);
    const timestamp = pos.timestamp || Date.now();

    this.currentPosition = { lat, lng, timestamp };
    this.accuracyFeet = accuracyFeet;

    this.positionHistory.push({ lat, lng, accuracy: accuracyFeet, timestamp });

    if (this.onPositionUpdate) {
      this.onPositionUpdate({
        lat,
        lng,
        accuracy: accuracyFeet,
        timestamp,
        isProtocolWarning: this.isProtocolWarning
      });
    }
  }

  handlePosError(err) {
    let msg = 'Unable to get location.';
    if (err && err.code === 1) { // PERMISSION_DENIED
      msg = 'GPS Permission Denied. Please enable Location access in browser settings.';
    } else if (err && err.code === 2) { // POSITION_UNAVAILABLE
      msg = 'Location unavailable. Ensure GPS / Location is turned ON.';
    } else if (err && err.code === 3) { // TIMEOUT
      msg = 'Location request timed out. Searching for GPS satellites...';
    }

    if (this.isProtocolWarning) {
      msg = 'Opened as local file — GPS requires HTTPS web server (e.g. Railway, Vercel, HTTPS).';
    }

    if (this.onError) this.onError(msg);
  }

  // Returns distance in Feet
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    const meters = R * c;
    return meters * 3.28084; // Convert meters to Feet
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

  // Expects distance in FEET
  getDistanceBand(feet) {
    if (feet > 200) return { band: 'COLD', label: 'COLD', color: '#64748B', pulseMs: 1600 };
    if (feet > 115) return { band: 'STRUCK', label: 'STRUCK', color: '#06B6D4', pulseMs: 1100 };
    if (feet > 65)  return { band: 'TRAILING', label: 'TRAILING', color: '#F59E0B', pulseMs: 700 };
    if (feet > 25)  return { band: 'BAYING', label: 'BAYING', color: '#FF5500', pulseMs: 400 };
    return { band: 'TREED', label: 'TREED / TAGGED', color: '#EF4444', pulseMs: 180 };
  }

  getBufferedPosition(rawPos, realTimeHiderPos) {
    if (!rawPos || !realTimeHiderPos) return rawPos;

    const rawDistFeet = this.calculateDistance(
      rawPos.lat, rawPos.lng,
      realTimeHiderPos.lat, realTimeHiderPos.lng
    );

    const now = Date.now();
    this.lagBuffer.push({ ...realTimeHiderPos, timestamp: now });
    this.lagBuffer = this.lagBuffer.filter(p => now - p.timestamp <= 10000);

    // 5-second lag buffer if outside 165 feet (50 meters)
    if (rawDistFeet > 165) {
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

  startSoloDrill(distanceFeet = 300) {
    if (!this.currentPosition) {
      this.currentPosition = { lat: 37.774929, lng: -122.419416, timestamp: Date.now() };
    }
    return this.setSoloHiderDistance(distanceFeet);
  }

  setSoloHiderDistance(distanceFeet) {
    const bearingDeg = 45;
    const bearingRad = (bearingDeg * Math.PI) / 180;
    const distanceMeters = distanceFeet / 3.28084;

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
      currentDistFeet: distanceFeet
    };

    return this.soloHiderPosition;
  }

  moveSoloHiderCloser(deltaFeet = 75) {
    if (!this.soloHiderPosition) this.startSoloDrill(300);
    const currentDist = this.soloHiderPosition.currentDistFeet || 300;
    const newDist = Math.max(10, currentDist - deltaFeet);
    return this.setSoloHiderDistance(newDist);
  }

  moveSoloHiderAway(deltaFeet = 75) {
    if (!this.soloHiderPosition) this.startSoloDrill(300);
    const currentDist = this.soloHiderPosition.currentDistFeet || 300;
    const newDist = Math.min(600, currentDist + deltaFeet);
    return this.setSoloHiderDistance(newDist);
  }
}

window.hotspotGeo = new HotspotGeo();
