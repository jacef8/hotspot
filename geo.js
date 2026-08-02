/**
 * HOTSPOT - Geolocation Engine & Math Utilities
 * Handles GPS tracking, Haversine distances, 5s lag buffering >50m,
 * Solo drill simulation, GPS accuracy diagnostics, and Haptic feedback.
 */

class HotspotGeo {
  constructor() {
    this.watchId = null;
    this.currentPosition = null;
    this.accuracy = null;
    this.positionHistory = [];
    this.lagBuffer = []; // Buffer for >50m 5-second lag
    this.lastEmittedPosition = null;
    this.soloHiderPosition = null;
    this.soloInterval = null;
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

  /**
   * Start tracking user GPS coordinates
   */
  startTracking(onUpdate, onError) {
    this.onPositionUpdate = onUpdate;
    this.onError = onError;

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

  /**
   * Haversine formula to compute distance in meters between two lat/lng pairs
   */
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

    return R * c; // Distance in meters
  }

  /**
   * Calculate initial bearing from point A to point B in degrees (0..360)
   */
  calculateBearing(lat1, lon1, lat2, lon2) {
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);

    return ((θ * 180) / Math.PI + 360) % 360;
  }

  /**
   * Map distance to band name
   * Cold (>60m), Struck (35-60m), Trailing (20-35m), Baying (8-20m), Treed (<8m)
   */
  getDistanceBand(meters) {
    if (meters > 60) return { band: 'COLD', label: 'COLD', color: '#64748B', pulseMs: 1600 };
    if (meters > 35) return { band: 'STRUCK', label: 'STRUCK', color: '#06B6D4', pulseMs: 1100 };
    if (meters > 20) return { band: 'TRAILING', label: 'TRAILING', color: '#F59E0B', pulseMs: 700 };
    if (meters > 8)  return { band: 'BAYING', label: 'BAYING', color: '#FF5500', pulseMs: 400 };
    return { band: 'TREED', label: 'TREED / TAGGED', color: '#EF4444', pulseMs: 180 };
  }

  /**
   * Buffer position updates when beyond 50m (5-second lag rule)
   * Live updates inside 50m
   */
  getBufferedPosition(rawPos, realTimeHiderPos) {
    if (!rawPos || !realTimeHiderPos) return rawPos;

    const rawDist = this.calculateDistance(
      rawPos.lat, rawPos.lng,
      realTimeHiderPos.lat, realTimeHiderPos.lng
    );

    const now = Date.now();

    // Store in lag buffer
    this.lagBuffer.push({ ...realTimeHiderPos, timestamp: now });

    // Keep buffer trimmed
    this.lagBuffer = this.lagBuffer.filter(p => now - p.timestamp <= 10000);

    if (rawDist > 50) {
      // Return position from 5 seconds ago if available
      const targetTime = now - 5000;
      const delayedPoint = this.lagBuffer.find(p => p.timestamp >= targetTime) || this.lagBuffer[0] || realTimeHiderPos;
      return delayedPoint;
    } else {
      // Inside 50m: LIVE updates!
      return realTimeHiderPos;
    }
  }

  /**
   * Trigger device vibration matching pulse rate
   */
  vibratePulse(pulseMs) {
    if ('vibrate' in navigator) {
      try {
        const duration = Math.min(100, Math.max(30, Math.floor(pulseMs * 0.25)));
        navigator.vibrate(duration);
      } catch (e) {
        // Haptics ignore if restricted
      }
    }
  }

  /**
   * Solo Drill: Plant a virtual hider ~100m out in a random direction
   */
  startSoloDrill(distanceMeters = 100) {
    if (!this.currentPosition) {
      // Default to central park coordinates if no GPS fix yet
      this.currentPosition = { lat: 37.774929, lng: -122.419416, timestamp: Date.now() };
    }

    const bearingDeg = Math.floor(Math.random() * 360);
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
      isVirtual: true
    };

    return this.soloHiderPosition;
  }

  stopSoloDrill() {
    this.soloHiderPosition = null;
    if (this.soloInterval) {
      clearInterval(this.soloInterval);
      this.soloInterval = null;
    }
  }
}

window.hotspotGeo = new HotspotGeo();
