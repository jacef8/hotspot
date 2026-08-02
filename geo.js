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
    this.deviceHeading = null;
    this.compassStarted = false;

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

  // Returns a { lat, lng } point offset from an arbitrary origin.
  // distanceFeet in FEET, bearingDeg in degrees clockwise from true north.
  offsetPosition(lat, lng, distanceFeet, bearingDeg) {
    const R = 6371e3;
    const d = distanceFeet / 3.28084;
    const brng = (bearingDeg * Math.PI) / 180;
    const lat1 = (lat * Math.PI) / 180;
    const lon1 = (lng * Math.PI) / 180;

    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d / R) +
      Math.cos(lat1) * Math.sin(d / R) * Math.cos(brng)
    );

    const lon2 = lon1 + Math.atan2(
      Math.sin(brng) * Math.sin(d / R) * Math.cos(lat1),
      Math.cos(d / R) - Math.sin(lat1) * Math.sin(lat2)
    );

    return {
      lat: (lat2 * 180) / Math.PI,
      lng: (lon2 * 180) / Math.PI
    };
  }

  // iOS 13+ requires a user gesture before granting orientation access.
  requestCompassPermission() {
    if (this.compassStarted) return;

    const attach = () => {
      this.compassStarted = true;
      window.addEventListener('deviceorientationabsolute', (e) => this.handleOrientation(e), true);
      window.addEventListener('deviceorientation', (e) => this.handleOrientation(e), true);
    };

    try {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
          .then((state) => { if (state === 'granted') attach(); })
          .catch(() => {});
      } else {
        attach();
      }
    } catch(e) {}
  }

  handleOrientation(e) {
    if (!e) return;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      this.deviceHeading = e.webkitCompassHeading; // iOS: already true-north clockwise
      return;
    }
    if (typeof e.alpha === 'number' && !isNaN(e.alpha)) {
      this.deviceHeading = (360 - e.alpha) % 360; // Android: alpha is counter-clockwise
    }
  }

  // Distance rings, in FEET. Widened from the old ladder because the previous
  // close-in rings (BAYING 25-65ft, TREED <25ft) were narrower than ordinary
  // phone GPS error, so two players 90ft apart could read as "on top of you".
  //
  //   COLD     > 250 ft
  //   WARM     150 - 250 ft
  //   HOT       80 - 150 ft
  //   HOTTER    40 -  80 ft
  //   RED HOT  <  40 ft   (auto-tag range)
  //
  // marginFeet is the combined GPS uncertainty of both phones. A hot reading is
  // only meaningful if the error is smaller than the ring itself, so the band is
  // capped when the fix is poor rather than claiming false confidence.
  getDistanceBand(feet, marginFeet = 0) {
    const BANDS = [
      { band: 'COLD',   label: 'COLD',    color: '#64748B', pulseMs: 1600, min: 250 },
      { band: 'WARM',   label: 'WARM',    color: '#06B6D4', pulseMs: 1100, min: 150 },
      { band: 'HOT',    label: 'HOT',     color: '#F59E0B', pulseMs: 700,  min: 80  },
      { band: 'HOTTER', label: 'HOTTER',  color: '#FF5500', pulseMs: 400,  min: 40  },
      { band: 'REDHOT', label: 'RED HOT', color: '#EF4444', pulseMs: 180,  min: -1  }
    ];

    let idx = BANDS.findIndex(b => feet > b.min);
    if (idx < 0) idx = BANDS.length - 1;

    // Cap how hot we are willing to claim, based on how good the fix is.
    let maxIdx = BANDS.length - 1;
    if (marginFeet > 100) maxIdx = 1;      // no hotter than WARM
    else if (marginFeet > 60) maxIdx = 2;  // no hotter than HOT

    const capped = idx > maxIdx;
    if (capped) idx = maxIdx;

    return { ...BANDS[idx], capped };
  }

  // Combined uncertainty of two independent GPS fixes.
  combinedAccuracy(accA, accB) {
    const a = (typeof accA === 'number' && accA > 0) ? accA : 25;
    const b = (typeof accB === 'number' && accB > 0) ? accB : 25;
    return Math.round(Math.sqrt(a * a + b * b));
  }

  // Below this combined uncertainty an auto-tag is credible.
  isTagCredible(marginFeet) {
    return marginFeet <= 60;
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
