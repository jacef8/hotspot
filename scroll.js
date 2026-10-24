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
  window.hotspotScroll = { instances, ok: false, error: null, wake() {} };

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
        autoRaf: false
      });
      instances.push({ id: wrapperId, lenis, wrapper });
    });
    window.hotspotScroll.ok = instances.length > 0;
  } catch (e) {
    window.hotspotScroll.error = (e && e.message) || String(e);
  }
  if (!instances.length) return;

  // One frame loop for all three, and only while one of them is on screen.
  // autoRaf would tick each instance forever, hidden or not: 180 wake-ups a
  // second during a hunt for panels nobody can see.
  const onScreen = (el) => el.getClientRects().length > 0;
  let rafId = null;
  const tick = (t) => {
    rafId = null;
    let shown = false;
    instances.forEach(({ wrapper, lenis }) => {
      if (onScreen(wrapper)) { shown = true; lenis.raf(t); }
    });
    if (shown) rafId = requestAnimationFrame(tick);
  };
  const wake = () => { if (rafId === null) rafId = requestAnimationFrame(tick); };
  window.hotspotScroll.wake = wake;

  // A panel appears when its screen gains 'active' or the diagnostics overlay
  // is shown; both are attribute changes, so watch for those rather than ask
  // app.js to call in.
  if (typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(wake);
    const watched = new Set();
    instances.forEach(({ wrapper }) => {
      watched.add(wrapper);
      const screen = wrapper.closest('.screen');
      if (screen) watched.add(screen);
    });
    watched.forEach((el) => mo.observe(el, { attributes: true, attributeFilter: ['class', 'style'] }));
  }
  document.addEventListener('visibilitychange', wake);
  wake();
})();
