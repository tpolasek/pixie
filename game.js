(function () {
  'use strict';

  // ===== Constants — mirrored from the original C source (Pixie, T. Polasek, 2011) =====
  const SCREEN_W = 640;
  const SCREEN_H = 480;
  const CELL_W = 16;
  const CELL_H = 12;
  const PIXIE_SIZE = 5;
  const PIXIE_COUNT = 100;
  const CELL_PX_W = SCREEN_W / CELL_W; // 40
  const CELL_PX_H = SCREEN_H / CELL_H; // 40
  const WIN_FLASH_MS = 2000;     // 50 C iters * (20ms black + 20ms render)
  const WIN_FLASH_STEP_MS = 20;

  const COLORS = {
    white: '#ffffff',
    black: '#000000',
    red: '#ff0000',
    red2: '#ee0000',
    blue: '#33ccff',
    green: '#00ff00',
  };

  // ===== DOM =====
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const elCaptured = document.getElementById('score');
  const elWalls = document.getElementById('walls');
  const elTime = document.getElementById('time');
  const elOverlay = document.getElementById('overlay');
  const elOverlayTitle = elOverlay.querySelector('h1');
  const elOverlayMsg = document.getElementById('overlay-msg');

  // ===== State (mirrors the C Cells + Pixies structs) =====
  const state = {
    status: 'playing', // playing | winning | won
    cells: [],         // length CELL_W*CELL_H: { is_frozen, pixel_count, is_herd }
    pixies: [],        // length PIXIE_COUNT: { x, y, dx, dy, is_frozen_px }
    winStart: 0,
    gameStart: 0,
  };

  // ===== Audio — Engine.Synth provides the tone generator =====
  const Sfx = {
    toggle() {
      if (!Engine.Synth.ctx) return;
      Engine.Synth.tone(440, 0, 0.04, 0.06);
    },
    win() {
      if (!Engine.Synth.ctx) return;
      [523, 659, 784, 1047, 1319].forEach((f, i) =>
        Engine.Synth.tone(f, i * 0.12, 0.20, 0.12)
      );
    },
  };

  // ===== Util =====
  const { randInt } = Engine.Util;

  // ===== Cell helpers — port of calculate_Cell_X/Y =====
  function cellX(x) { return Math.floor(x / CELL_PX_W); }
  function cellY(y) { return Math.floor(y / CELL_PX_H); }

  // Bounds-checked accessor. The C source derences (cells + ty*width + tx)
  // before checking tx/ty bounds and relies on short-circuit eval to land in
  // the right branch; here we return null OOB and treat null as "not frozen"
  // so the same control flow produces the same outcome.
  function getCell(cx, cy) {
    if (cx < 0 || cx >= CELL_W || cy < 0 || cy >= CELL_H) return null;
    return state.cells[cy * CELL_W + cx];
  }

  // Leading-edge offset (C: ((dx+1)*PIXIE_SIZE)/2, integer division).
  // dx ∈ {-1,0,1} → offset ∈ {0,2,5}.
  function leadX(p) { return p.x + Math.floor((p.dx + 1) * PIXIE_SIZE / 2); }
  function leadY(p) { return p.y + Math.floor((p.dy + 1) * PIXIE_SIZE / 2); }

  // ===== Init — fresh cells, random 2x2 herd, 100 pixies =====
  function newGame() {
    state.status = 'playing';
    state.cells = [];
    for (let i = 0; i < CELL_W * CELL_H; i++) {
      state.cells.push({ is_frozen: false, pixel_count: 0, is_herd: false });
    }
    const hi = randInt(0, CELL_W - 2);
    const hj = randInt(0, CELL_H - 2);
    getCell(hi, hj).is_herd = true;
    getCell(hi + 1, hj).is_herd = true;
    getCell(hi, hj + 1).is_herd = true;
    getCell(hi + 1, hj + 1).is_herd = true;

    state.pixies = [];
    for (let i = 0; i < PIXIE_COUNT; i++) {
      // C: dx=-1, dy=1, each flipped with 50% chance.
      const dx = Math.random() < 0.5 ? -1 : 1;
      const dy = Math.random() < 0.5 ? -1 : 1;
      state.pixies.push({
        x: randInt(1, SCREEN_W - 2),
        y: randInt(1, SCREEN_H - 2),
        dx, dy,
        is_frozen_px: false,
      });
    }
    state.gameStart = performance.now();
    hideOverlay();
    updateHUD();
  }

  // ===== iterate_Pixies — faithful port of the C collision cascade =====
  function iteratePixies() {
    for (const p of state.pixies) {
      const cx = cellX(leadX(p));
      const cy = cellY(leadY(p));
      const tx = cellX(leadX(p) + p.dx);
      const ty = cellY(leadY(p) + p.dy);
      const tcell = getCell(tx, ty);
      const tFrozen = tcell ? tcell.is_frozen : false;

      p.is_frozen_px = true;
      if (!tFrozen &&
          tx < CELL_W && (p.y + p.dy) > 0 &&
          ty < CELL_H && (p.x + p.dx) > 0) {
        p.x += p.dx;
        p.y += p.dy;
        p.is_frozen_px = false;
        continue;
      }
      if (ty >= CELL_H || (p.y + p.dy) <= 0) {
        p.dy = -p.dy;
        continue;
      }
      if (tx >= CELL_W || (p.x + p.dx) <= 0) {
        p.dx = -p.dx;
        continue;
      }
      if (tFrozen) {
        if (cy !== ty) { p.dy = -p.dy; continue; }
        if (cx !== tx) { p.dx = -p.dx; continue; }
      }
    }
  }

  // ===== update_Cells — recount pixies per cell each frame =====
  function updateCells() {
    for (const c of state.cells) c.pixel_count = 0;
    for (const p of state.pixies) {
      const c = getCell(cellX(leadX(p)), cellY(leadY(p)));
      if (c) c.pixel_count++;
    }
  }

  // ===== herded_all =====
  function herdedAll() {
    for (const c of state.cells) {
      if (c.pixel_count && !c.is_herd) return false;
    }
    return true;
  }

  // ===== toggle_Cell =====
  function toggleCell(mouseX, mouseY) {
    const c = getCell(cellX(mouseX), cellY(mouseY));
    if (!c) return;
    c.is_frozen = !c.is_frozen;
    Sfx.toggle();
  }

  // ===== render_Screen =====
  function draw() {
    ctx.fillStyle = COLORS.white;
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

    for (let j = 0; j < CELL_H; j++) {
      for (let i = 0; i < CELL_W; i++) {
        const c = getCell(i, j);
        let color = null;
        if (c.is_herd && c.is_frozen) color = COLORS.blue;
        else if (c.is_frozen) color = c.pixel_count ? COLORS.red2 : COLORS.red;
        else if (c.is_herd) color = COLORS.green;
        if (color) {
          ctx.fillStyle = color;
          ctx.fillRect(i * CELL_PX_W, j * CELL_PX_H, CELL_PX_W, CELL_PX_H);
        }
      }
    }

    ctx.fillStyle = COLORS.black;
    for (const p of state.pixies) {
      const jx = p.is_frozen_px ? randInt(-1, 1) : 0;
      const jy = p.is_frozen_px ? randInt(-1, 1) : 0;
      ctx.fillRect((p.x | 0) + jx, (p.y | 0) + jy, PIXIE_SIZE, PIXIE_SIZE);
    }
  }

  // Win strobe: 2s alternating black/render every 20ms (50 iters × 40ms in C).
  function drawWinFlash() {
    const elapsed = performance.now() - state.winStart;
    if (elapsed >= WIN_FLASH_MS) {
      state.status = 'won';
      showOverlay('YOU WON!', 'Nice! Press R to play again.');
      return;
    }
    const stepIdx = Math.floor(elapsed / WIN_FLASH_STEP_MS);
    if (stepIdx % 2 === 0) {
      ctx.fillStyle = COLORS.black;
      ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    } else {
      draw();
    }
  }

  // ===== HUD =====
  function updateHUD() {
    let captured = 0;
    let walls = 0;
    for (const c of state.cells) {
      if (c.is_frozen) walls++;
      if (c.is_herd) captured += c.pixel_count;
    }
    elCaptured.textContent = captured;
    elWalls.textContent = walls;
    const elapsed = state.status === 'playing'
      ? performance.now() - state.gameStart
      : 0;
    const secs = Math.floor(elapsed / 1000);
    elTime.textContent = `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`;
  }

  function showOverlay(title, msg) {
    elOverlayTitle.textContent = title;
    elOverlayMsg.textContent = msg;
    elOverlay.classList.add('visible');
  }

  function hideOverlay() {
    elOverlay.classList.remove('visible');
  }

  // ===== Input =====
  // Mouse click toggles a cell's frozen state. Canvas is CSS-scaled, so map
  // client coords back to the 640x480 backing store via getBoundingClientRect.
  canvas.addEventListener('mousedown', (e) => {
    Engine.Synth.init();
    if (state.status !== 'playing') return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    toggleCell(x, y);
  });

  Engine.Keyboard
    .on(['r', 'R'], () => {
      newGame();
      return true;
    })
    .install();

  // ===== Loop =====
  function loop() {
    if (state.status === 'playing') {
      iteratePixies();
      updateCells();
      updateHUD();
      if (herdedAll()) {
        state.status = 'winning';
        state.winStart = performance.now();
        Sfx.win();
      } else {
        draw();
      }
    } else if (state.status === 'winning') {
      drawWinFlash();
    }
    // 'won': overlay visible, canvas left as-is.
    requestAnimationFrame(loop);
  }

  // ===== Go =====
  newGame();
  requestAnimationFrame(loop);
})();
