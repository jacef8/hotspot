/**
 * HOTSPOT - Smooth scrolling (Lenis)
 *
 * Every screen in this app is built to fit the phone, so the page itself never
 * scrolls. Three panels can: the seeker roster in the lobby, the field card on
 * the spectator map, and the diagnostics overlay. Lenis takes over those three
 * so they glide instead of jump. Each needs a stable inner element to measure,
 * because the roster's own contents are rebuilt on every heartbeat.
 *
 * syncTouch is on: without it Lenis leaves touch scrolling to the browser,
 * which on a phone would mean it did nothing at all.
 */
(function () {
  const PANELS = [
    ['lobby-seeker-scroll', 'lobby-seeker-list'],
    ['spectator-board-scroll', 'spectator-leaderboard'],
    ['diag-panel', 'diag-scroll']
  ];

  const instances = [];
  window.hotspotScroll = { instances, ok: false, error: null };

  if (typeof Lenis === 'undefined') {
    window.hotspotScroll.error = 'Lenis not loaded';
    return;
  }

  try {
    PANELS.forEach(([wrapperId, contentId]) => {
      const wrapper = document.getElementById(wrapperId);
      const content = document.getElementById(contentId);
      if (!wrapper || !content) return;
      const lenis = new Lenis({
        wrapper,
        content,
        lerp: 0.14,
        smoothWheel: true,
        syncTouch: true,
        syncTouchLerp: 0.1,
        autoRaf: true
      });
      instances.push({ id: wrapperId, lenis });
    });
    window.hotspotScroll.ok = instances.length > 0;
  } catch (e) {
    window.hotspotScroll.error = (e && e.message) || String(e);
  }
})();
