// Fully analog 360-degree joystick. Returns a live dx/dy in [-1, 1] via getters,
// so callers always read the current value rather than subscribing to events.
function createJoystick(baseEl, knobEl) {
  let active = false;
  let pointerId = null;
  let dx = 0;
  let dy = 0;

  function geometry() {
    const rect = baseEl.getBoundingClientRect();
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, r: rect.width / 2 };
  }

  function move(clientX, clientY) {
    const { cx, cy, r } = geometry();
    let x = clientX - cx;
    let y = clientY - cy;
    const dist = Math.hypot(x, y);
    const maxDist = r * 0.9;
    if (dist > maxDist) {
      x = (x / dist) * maxDist;
      y = (y / dist) * maxDist;
    }
    knobEl.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    dx = x / maxDist;
    dy = y / maxDist;
  }

  function reset() {
    knobEl.style.transform = 'translate(-50%, -50%)';
    dx = 0;
    dy = 0;
  }

  baseEl.addEventListener('pointerdown', (e) => {
    active = true;
    pointerId = e.pointerId;
    baseEl.setPointerCapture(e.pointerId);
    move(e.clientX, e.clientY);
  });
  baseEl.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== pointerId) return;
    move(e.clientX, e.clientY);
  });
  function end(e) {
    if (e.pointerId !== pointerId) return;
    active = false;
    pointerId = null;
    reset();
  }
  baseEl.addEventListener('pointerup', end);
  baseEl.addEventListener('pointercancel', end);

  return {
    get dx() {
      return dx;
    },
    get dy() {
      return dy;
    },
  };
}
