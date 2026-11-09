/* ==========================================================================
   力学实验室 · Mechanics Lab
   A browser-based high-school mechanics sandbox built on Matter.js.
   ========================================================================== */
(() => {
  'use strict';

  const MATTER_FALLBACKS = [
    'https://unpkg.com/matter-js@0.20.0/build/matter.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.20.0/matter.min.js'
  ];

  const PPU = 100;                       // 100 CSS px = 1 m at zoom 1
  const FIXED_DT_MS = 1000 / 360;        // fixed physics substep
  const FIXED_DT = 1 / 360;              // seconds
  const FORCE_UNIT = 1e-6;               // N -> Matter force units
  const BODY_SLOP = 0.003;               // metres
  const VECTOR = {
    force: '#ff8a24',
    velocity: '#56e07b',
    acceleration: '#ff4e4e'
  };
  // Unified, linear px-per-unit scaling for the three vector kinds.
  // One scale is shared by every body for a given quantity, so arrow length
  // is exactly proportional to magnitude inside one frame.
  const VECTOR_SCALE = {
    force: { base: 3.2, target: 140, band: [90, 200], min: 0.02, max: 40, unit: 'N' },
    velocity: { base: 28, target: 100, band: [50, 150], min: 0.4, max: 300, unit: 'm/s' },
    acceleration: { base: 12, target: 100, band: [50, 155], min: 0.2, max: 160, unit: 'm/s²' }
  };
  const EPS = { force: 0.02, velocity: 0.02, acceleration: 0.06 };
  const HISTORY_HZ = 60;
  const HISTORY_STRIDE = Math.max(1, Math.round((1 / FIXED_DT) / HISTORY_HZ));
  const HISTORY_MAX = 4200;

  /* ------------------------------------------------------------------------
     Small utilities
     ------------------------------------------------------------------------ */

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const lengthOf = (v) => Math.hypot(v.x, v.y);
  const normalize = (v, fallback = { x: 0, y: 1 }) => {
    const len = Math.hypot(v.x, v.y);
    if (len < 1e-9) return { x: fallback.x, y: fallback.y };
    return { x: v.x / len, y: v.y / len };
  };
  const roundTo = (v, digits = 2) => {
    const p = 10 ** digits;
    return Math.round(v * p) / p;
  };

  function formatNumber(value, digits = 2) {
    if (!Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    if (abs < 1e-6) return '0';
    if (abs >= 1000) return value.toFixed(0);
    if (abs >= 100) return value.toFixed(1);
    if (abs >= 1) return value.toFixed(digits);
    if (abs >= 0.01) return value.toFixed(Math.max(digits, 3));
    if (abs >= 0.0001) return value.toFixed(4);
    return value.toExponential(1);
  }

  function formatForce(value) {
    if (!Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    if (abs < 1e-6) return '0';
    if (abs >= 100) return value.toFixed(0);
    if (abs >= 10) return value.toFixed(1);
    if (abs >= 1) return value.toFixed(2);
    if (abs >= 0.01) return value.toFixed(3);
    return value.toExponential(1);
  }

  function formatSigned(value, digits = 2) {
    if (!Number.isFinite(value)) return '—';
    if (Math.abs(value) < 1e-6) return '0';
    const text = formatNumber(Math.abs(value), digits);
    return value > 0 ? `+${text}` : `−${text}`;
  }

  function formatMass(value) {
    if (value < 1) return `${Math.round(value * 1000)} g`;
    if (value < 10) return `${value.toFixed(2)} kg`;
    return `${value.toFixed(1)} kg`;
  }

  function formatMassInput(value) {
    if (value < 0.01) return `${roundTo(value, 4)}`;
    if (value < 1) return `${roundTo(value, 3)}`;
    return `${roundTo(value, 2)}`;
  }

  function formatCoord(value) {
    if (Math.abs(value) < 0.0005) return '0';
    return roundTo(value, Math.abs(value) >= 10 ? 1 : 2).toString();
  }

  function niceStep(target) {
    const powers = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    for (const step of powers) {
      if (step >= target) return step;
    }
    return 1000;
  }

  function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;
      const intersect = ((yi > point.y) !== (yj > point.y)) &&
        (point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointSegmentDistance(p, a, b) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-9) return distance(p, a);
    const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / len2, 0, 1);
    return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  /* ------------------------------------------------------------------------
     Inline icons
     ------------------------------------------------------------------------ */

  function svg(paths, extra = '') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
      stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" ${extra}>${paths}</svg>`;
  }

  const ICONS = {
    objects: svg('<path d="M12 2.8 21 7.4v9.1L12 21.2 3 16.5V7.4L12 2.8Z"/><path d="M3 7.4 12 12l9-4.6M12 12v9.2"/>'),
    connectors: svg('<path d="M3 14.8c1.8-6.4 3.6-6.4 5.4 0s3.6 6.4 5.4 0 3.6-6.4 5.4 0"/><path d="M2 18.6h20"/>'),
    scene: svg('<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h9M17 18h3"/><path d="M13 4v4M7 10v4M13 16v4"/>'),
    display: svg('<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z"/><path d="M12 9.3A2.7 2.7 0 1 0 12 14.7 2.7 2.7 0 0 0 12 9.3Z"/>'),
    chart: svg('<path d="M3 3v18h18"/><path d="M5.5 15.5 9.5 10l3.5 3.5L20 6"/><path d="M16.6 6H20v3.4"/>'),
    forces: svg('<path d="M12 12V3.6M12 12l7.3 4.2M12 12 4.7 16.2"/><path d="M9.9 5.5 12 3.4l2.1 2.1M18.2 14.4l2.1 1.3-2.2 1.5M5.8 15.7l-2.2-1.5 2.2-1.3"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/>'),
    help: svg('<path d="M9.2 9a2.9 2.9 0 1 1 4.3 2.6c-1 .6-1.5 1.1-1.5 2.2"/><path d="M12 17.7h.01"/><path d="M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 0 0-17 0Z"/>'),
    block: svg('<path d="M4 6h16v12H4z"/><path d="M4 6l4-3h12l-4 3M20 6v12l-4 3"/>'),
    incline: svg('<path d="M3 19h18L3 5v14Z"/><path d="M3 19 16 7"/>'),
    anchor: svg('<path d="M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 0 0-17 0Z"/><path d="M6 12a6 6 0 1 0 12 0 6 6 0 0 0-12 0Z" stroke-dasharray="1.5 2.5"/><path d="M9.8 12a2.2 2.2 0 1 0 4.4 0 2.2 2.2 0 0 0-4.4 0Z" fill="currentColor" stroke="none"/>'),
    spring: svg('<path d="M2.5 12h3l1.7-6 2.5 12 2.6-12 2.5 12 2.5-12 1.8 6h3"/>'),
    elastic: svg('<path d="M2.5 12h2.2c1.7-5.5 3.3-5.5 5 0s3.3 5.5 5 0 3.3-5.5 5 0h2.3"/>'),
    rod: svg('<path d="M3 17 21 7"/><path d="M3 13.8 6.2 20.2M17.8 3.8 21 10.2"/>'),
    rope: svg('<path d="M2.5 9c3.8 0 3.8 6 7.5 6s3.7-6 7.5-6h4"/>'),
    trash: svg('<path d="M4 7h16M9 7V4h6v3M6.5 7l1 14h9l1-14M10 11v6M14 11v6"/>'),
    close: svg('<path d="M5 5l14 14M19 5 5 19"/>'),
    play: svg('<path d="M7 4.5v15L19 12 7 4.5Z"/>'),
    step: svg('<path d="M5 5v14l9-7-9-7ZM18 5v14"/>'),
    reset: svg('<path d="M4 5v6h6"/><path d="M5.2 10A8 8 0 1 1 4 14"/>'),
    plus: svg('<path d="M12 4v16M4 12h16"/>'),
    lock: svg('<path d="M6 10h12v10H6z"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"/>'),
    unlocked: svg('<path d="M6 10h12v10H6z"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 6.4-1.9"/>')
  };

  const TOOL_DEFS = [
    { id: 'objects', label: '物体', icon: 'objects' },
    { id: 'connectors', label: '连接', icon: 'connectors' },
    { id: 'forces', label: '受力', icon: 'forces' },
    { id: 'scene', label: '场景', icon: 'scene' },
    { id: 'display', label: '显示', icon: 'display' },
    { id: 'analysis', label: '曲线', icon: 'chart' }
  ];

  const CONNECTOR_INFO = {
    spring: { label: '轻弹簧', icon: 'spring', desc: '可拉可压' },
    elastic: { label: '轻弹性绳', icon: 'elastic', desc: '只拉不压' },
    rod: { label: '轻硬杆', icon: 'rod', desc: '固定长度' },
    rope: { label: '轻绳', icon: 'rope', desc: '不可伸长' }
  };

  const PRESET_INFO = {
    demo: { label: '综合演示', note: '斜面 + 弹簧振子' },
    ramp: { label: '斜面滑块', note: '摩擦与斜面' },
    spring: { label: '弹簧振子', note: '简谐振动' },
    pendulum: { label: '硬杆摆', note: '定长约束' }
  };

  /* ------------------------------------------------------------------------
     Main application
     ------------------------------------------------------------------------ */

  class MechanicsLab {
    constructor() {
      this.M = window.Matter;
      const { Engine, Bodies, Body, Composite, Constraint, Vector, Vertices } = this.M;
      this.Engine = Engine;
      this.Bodies = Bodies;
      this.Body = Body;
      this.Composite = Composite;
      this.Constraint = Constraint;
      this.Vector = Vector;
      this.Vertices = Vertices;

      this.canvas = document.getElementById('scene');
      this.ctx = this.canvas.getContext('2d');
      this.stage = document.getElementById('stage');
      this.panelShell = document.getElementById('panelShell');
      this.panelBody = document.getElementById('panelBody');
      this.toolbar = document.getElementById('toolbar');
      this.toastEl = document.getElementById('toast');
      this.hintEl = document.getElementById('interactionHint');
      this.runStateEl = document.getElementById('runState');
      this.runStateText = document.getElementById('runStateText');
      this.playBtn = document.getElementById('btnPlay');
      this.playText = document.getElementById('playText');
      this.timeReadout = document.getElementById('timeReadout');
      this.zoomReadout = document.getElementById('zoomReadout');
      this.scaleBar = document.getElementById('scaleBar');
      this.vectorLegend = document.getElementById('vectorLegend');
      this.scaleReadoutEl = document.getElementById('legendScale');

      this.state = {
        mode: 'physics',
        running: false,
        speed: 1,
        simTime: 0,
        gravity: 9.8,
        groundFriction: 0.5,
        showForces: true,
        showVelocity: false,
        showAcceleration: false,
        showGrid: true,
        selectedId: null,
        openPanel: 'objects',
        pendingConnector: null,
        hoverId: null,
        pointerInside: false,
        dragBodyId: null
      };

      this.camera = { x: -0.1, y: -2.35, zoom: 1 };
      this.width = 1;
      this.height = 1;
      this.dpr = 1;

      this.entities = new Map();       // blocks, inclines, anchors
      this.connectors = new Map();     // springs, elastic ropes, rods, ropes
      this.counters = { block: 0, incline: 0, anchor: 0, spring: 0, elastic: 0, rod: 0, rope: 0 };
      this.activeField = null;
      this.lastTime = 0;
      this.accumulator = 0;
      this.raf = 0;
      this.toastTimer = 0;
      this.liveTimer = 0;
      this.drag = null;
      this.forceDrag = null;
      this.pointer = { x: 0, y: 0, inside: false, down: false };
      this.hit = null;
      this.suppressClick = false;
      this.history = new Map();
      this.historyTick = 0;
      this.chartTimer = 0;
      this.scales = {};
      this.scaleHold = {};
      this.scaleRef = {};
      this.scaleTime = {};
      this.labelObstacles = [];

      this._frame = this.frame.bind(this);
      this._resize = this.resizeCanvas.bind(this);
      this._keydown = this.onKeyDown.bind(this);

      this.init();
    }

    init() {
      this.setupCanvas();
      this.setupEngine();
      this.setupToolbar();
      this.bindStaticUI();
      this.bindCanvasEvents();
      this.bindPanelEvents();
      this.bindKeyboard();

      this.loadPreset('demo', { silent: true });
      this.openPanel('objects', { silent: true });
      this.updateTransportUI();
      this.updateModeUI();
      this.updateLegend();
      this.updateZoomUI();
      this.updateLiveReadouts(true);
      this.setHint('按空格开始模拟 · 拖动空白平移 · 拖动物体施加外力 · 滚轮缩放');

      this.lastTime = performance.now();
      this.raf = requestAnimationFrame(this._frame);
    }

    /* ----------------------------------------------------------------------
       Canvas and camera
       ---------------------------------------------------------------------- */

    setupCanvas() {
      const resize = () => this.resizeCanvas();
      if (window.ResizeObserver) {
        this.resizeObserver = new ResizeObserver(resize);
        this.resizeObserver.observe(this.stage);
      }
      window.addEventListener('resize', this._resize);
      this.resizeCanvas();
    }

    resizeCanvas() {
      const rect = this.stage.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      this.width = width;
      this.height = height;
      this.canvas.width = Math.round(width * this.dpr);
      this.canvas.height = Math.round(height * this.dpr);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.updateZoomUI();
    }

    screenToWorld(x, y) {
      const scale = PPU * this.camera.zoom;
      return {
        x: this.camera.x + (x - this.width / 2) / scale,
        y: this.camera.y + (y - this.height / 2) / scale
      };
    }

    worldToScreen(x, y) {
      const scale = PPU * this.camera.zoom;
      return {
        x: (x - this.camera.x) * scale + this.width / 2,
        y: (y - this.camera.y) * scale + this.height / 2
      };
    }

    getPointer(event) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    zoomAt(screenX, screenY, factor) {
      const before = this.screenToWorld(screenX, screenY);
      this.camera.zoom = clamp(this.camera.zoom * factor, 0.18, 5);
      const scale = PPU * this.camera.zoom;
      this.camera.x = before.x - (screenX - this.width / 2) / scale;
      this.camera.y = before.y - (screenY - this.height / 2) / scale;
      this.updateZoomUI();
    }

    fitView() {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let any = false;

      for (const entity of this.entities.values()) {
        if (entity.kind === 'anchor') {
          minX = Math.min(minX, entity.x);
          maxX = Math.max(maxX, entity.x);
          minY = Math.min(minY, entity.y);
          maxY = Math.max(maxY, entity.y);
          any = true;
        } else if (entity.body) {
          minX = Math.min(minX, entity.body.bounds.min.x);
          maxX = Math.max(maxX, entity.body.bounds.max.x);
          minY = Math.min(minY, entity.body.bounds.min.y);
          maxY = Math.max(maxY, entity.body.bounds.max.y);
          any = true;
        }
      }
      if (!any) {
        minX = -4; maxX = 4; minY = -4; maxY = 0.5;
      }
      minY = Math.min(minY, -0.5);
      maxY = Math.max(maxY, 0.5);

      const margin = 68;
      const usableW = Math.max(120, this.width - margin * 2);
      const usableH = Math.max(120, this.height - margin * 2);
      const worldW = Math.max(0.8, maxX - minX);
      const worldH = Math.max(0.8, maxY - minY);
      const zoom = clamp(Math.min(usableW / (worldW * PPU), usableH / (worldH * PPU)), 0.2, 3.2);
      this.camera.zoom = zoom;
      this.camera.x = (minX + maxX) / 2;
      this.camera.y = (minY + maxY) / 2;
      this.updateZoomUI();
    }

    updateZoomUI() {
      if (this.zoomReadout) this.zoomReadout.textContent = `${Math.round(this.camera.zoom * 100)}%`;
      if (this.scaleBar) {
        const targetPx = 104;
        const metres = niceStep(targetPx / (PPU * this.camera.zoom));
        const px = metres * PPU * this.camera.zoom;
        const bar = this.scaleBar.querySelector('span');
        const label = this.scaleBar.querySelector('b');
        if (bar) bar.style.width = `${px.toFixed(1)}px`;
        if (label) label.textContent = `${formatCoord(metres)} m`;
      }
    }

    /* ----------------------------------------------------------------------
       Matter setup
       ---------------------------------------------------------------------- */

    setupEngine() {
      const { Engine, Bodies, Composite } = this;
      this.engine = Engine.create({ enableSleeping: false });
      this.engine.gravity.x = 0;
      this.engine.gravity.y = this.state.gravity;
      this.engine.gravity.scale = 1e-6;
      this.engine.positionIterations = 10;
      this.engine.velocityIterations = 8;
      this.engine.constraintIterations = 6;
      this.world = this.engine.world;

      this.ground = Bodies.rectangle(0, 80, 4000, 160, {
        isStatic: true,
        label: '地面',
        friction: 0,
        frictionStatic: 0,
        frictionAir: 0,
        restitution: 0,
        slop: BODY_SLOP,
        render: { visible: false }
      });
      this.ground._ground = true;
      Composite.add(this.world, this.ground);
    }

    resetEngine() {
      this.clearAllConstraints();
      this.entities.clear();
      this.connectors.clear();
      this.state.selectedId = null;
      this.state.pendingConnector = null;
      this.state.simTime = 0;
      this.state.running = false;
      this.accumulator = 0;
      this.setupEngine();
    }

    /* ----------------------------------------------------------------------
       Toolbar / basic UI
       ---------------------------------------------------------------------- */

    setupToolbar() {
      const items = TOOL_DEFS.map((tool) => `
        <button type="button" class="tool-btn" data-tool="${tool.id}"
          aria-label="${tool.label}" aria-pressed="false">
          ${ICONS[tool.icon]}
          <span>${tool.label}</span>
        </button>
      `).join('');

      this.toolbar.innerHTML = `
        ${items}
        <div class="toolbar-spacer"></div>
        <button type="button" class="tool-btn" data-tool="help" aria-label="帮助" aria-pressed="false">
          ${ICONS.help}
          <span>帮助</span>
        </button>
        <div class="toolbar-mark"><span>MECH</span><span>LAB</span></div>
      `;

      this.toolbar.addEventListener('click', (event) => {
        const button = event.target.closest('[data-tool]');
        if (!button) return;
        const id = button.dataset.tool;
        if (this.state.openPanel === id) {
          this.closePanel();
        } else {
          this.openPanel(id);
        }
      });
    }

    updateToolbar() {
      this.toolbar.querySelectorAll('[data-tool]').forEach((button) => {
        const active = this.state.openPanel === button.dataset.tool;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    openPanel(id, options = {}) {
      this.state.openPanel = id;
      this.panelShell.classList.add('is-open');
      this.panelShell.classList.remove('is-closed');
      this.updateToolbar();
      this.renderPanel(Boolean(options.preserveScroll || options.silent));
    }

    closePanel() {
      this.state.openPanel = null;
      this.panelShell.classList.remove('is-open');
      this.panelShell.classList.add('is-closed');
      this.updateToolbar();
    }

    bindStaticUI() {
      document.querySelectorAll('[data-mode]').forEach((button) => {
        button.addEventListener('click', () => this.setMode(button.dataset.mode));
      });

      this.playBtn.addEventListener('click', () => this.togglePlay());
      document.getElementById('btnStep').addEventListener('click', () => this.stepOnce());
      document.getElementById('btnReset').addEventListener('click', () => this.resetSimulation());
      document.getElementById('btnZoomIn').addEventListener('click', () => {
        this.zoomAt(this.width / 2, this.height / 2, 1.22);
      });
      document.getElementById('btnZoomOut').addEventListener('click', () => {
        this.zoomAt(this.width / 2, this.height / 2, 1 / 1.22);
      });
      document.getElementById('btnFit').addEventListener('click', () => this.fitView());

      document.getElementById('speedGroup').addEventListener('click', (event) => {
        const button = event.target.closest('[data-speed]');
        if (!button) return;
        this.setSpeed(Number(button.dataset.speed));
      });
    }

    bindPanelEvents() {
      this.panelBody.addEventListener('click', (event) => {
        const actionEl = event.target.closest('[data-action]');
        if (actionEl) {
          this.handlePanelAction(actionEl.dataset.action, actionEl);
          return;
        }
        const row = event.target.closest('[data-select-id]');
        if (row) {
          this.select(row.dataset.selectId, { openPanel: false });
        }
      });

      this.panelBody.addEventListener('input', (event) => {
        const input = event.target;
        if (!input.matches('[data-field]')) return;
        if (input.type === 'range') this.onFieldInput(input, false);
      });

      this.panelBody.addEventListener('change', (event) => {
        const input = event.target;
        if (!input.matches('[data-field]')) return;
        this.onFieldInput(input, true);
      });
    }

    bindKeyboard() {
      document.addEventListener('keydown', this._keydown);
    }

    onKeyDown(event) {
      if (isTypingTarget(event.target)) return;

      if (event.code === 'Space') {
        event.preventDefault();
        this.togglePlay();
        return;
      }
      if (event.key === 'Escape') {
        if (this.state.pendingConnector) {
          this.cancelConnectorPick();
        } else {
          this.select(null, { openPanel: false });
        }
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (this.state.selectedId) {
          event.preventDefault();
          this.deleteSelected();
        }
        return;
      }
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        this.resetSimulation();
      }
    }

    /* ----------------------------------------------------------------------
       Mode / transport
       ---------------------------------------------------------------------- */

    setMode(mode, options = {}) {
      if (mode !== 'physics' && mode !== 'edit') return;
      if (mode === 'edit') {
        this.pauseSimulation();
        this.endForceDrag();
      } else if (this.state.pendingConnector) {
        this.state.pendingConnector = null;
        this.setHint('');
      }
      this.state.mode = mode;
      this.updateModeUI();
      if (!options.silent && mode === 'edit' && !this.state.running) {
        this.toast('编辑模式：拖动物体或锚点调整位置');
      }
    }

    updateModeUI() {
      document.querySelectorAll('[data-mode]').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.mode === this.state.mode);
      });
      this.canvas.classList.toggle('is-edit', this.state.mode === 'edit');
      this.canvas.classList.toggle('is-picking', Boolean(this.state.pendingConnector));
      this.updateTransportUI();
    }

    togglePlay() {
      if (this.state.running) {
        this.pauseSimulation();
      } else {
        this.startSimulation();
      }
    }

    startSimulation() {
      if (this.state.pendingConnector) {
        this.state.pendingConnector = null;
        this.setHint('');
      } else if (this.hintEl && this.hintEl.textContent.startsWith('按空格')) {
        this.setHint('');
      }
      if (this.state.mode === 'edit') {
        this.state.mode = 'physics';
        this.updateModeUI();
      }
      this.state.running = true;
      this.accumulator = 0;
      this.lastTime = performance.now();
      this.updateTransportUI();
    }

    pauseSimulation() {
      if (!this.state.running) return;
      this.state.running = false;
      this.updateTransportUI();
    }

    setSpeed(speed) {
      this.state.speed = speed;
      document.querySelectorAll('[data-speed]').forEach((button) => {
        button.classList.toggle('is-active', Number(button.dataset.speed) === speed);
      });
    }

    stepOnce() {
      this.pauseSimulation();
      if (this.state.mode === 'edit') {
        this.setMode('physics', { silent: true });
      }
      const steps = Math.round((1 / 60) / FIXED_DT);
      for (let i = 0; i < steps; i += 1) this.physicsStep();
      this.updateAcceleration();
      this.accumulator = 0;
      this.updateTransportUI();
      this.updateLiveReadouts(true);
    }

    resetSimulation() {
      this.pauseSimulation();
      this.endForceDrag();
      this.state.simTime = 0;
      this.accumulator = 0;
      this.clearHistory();

      for (const entity of this.entities.values()) {
        if (entity.kind === 'anchor') {
          entity.x = entity.home.x;
          entity.y = entity.home.y;
          if (entity.proxy) this.Body.setPosition(entity.proxy, { x: entity.x, y: entity.y });
        } else if (entity.body && entity.home) {
          this.Body.setPosition(entity.body, { x: entity.home.x, y: entity.home.y });
          this.Body.setAngle(entity.body, entity.home.angle || 0);
          this.Body.setVelocity(entity.body, { x: 0, y: 0 });
          this.Body.setAngularVelocity(entity.body, 0);
          entity.body._contactForce = { x: 0, y: 0 };
          entity.body._contactSmooth = null;
          entity.body._accel = { x: 0, y: 0 };
          entity.body._lastV = { x: 0, y: 0 };
          entity.body._accelTime = 0;
        }
      }
      for (const anchor of this.entities.values()) {
        if (anchor.kind === 'anchor') this.refreshLocksAround(anchor.id);
      }
      this.updateTransportUI();
      this.updateLiveReadouts(true);
      this.toast('已回到初始位置');
    }

    updateTransportUI() {
      const running = this.state.running;
      this.playBtn.classList.toggle('is-running', running);
      this.playText.textContent = running ? '暂停' : (this.state.simTime > 0 ? '继续' : '开始');
      this.runStateEl.classList.toggle('is-running', running);
      this.runStateText.textContent = running ? '运行中' : '已暂停';
      this.canvas.classList.toggle('is-picking', Boolean(this.state.pendingConnector));
      if (this.timeReadout) {
        this.timeReadout.innerHTML = `${this.state.simTime.toFixed(2)} <small>s</small>`;
      }
    }

    updateLegend() {
      if (!this.vectorLegend) return;
      const map = {
        force: this.state.showForces,
        velocity: this.state.showVelocity,
        acceleration: this.state.showAcceleration
      };
      this.vectorLegend.querySelectorAll('.legend-item').forEach((item) => {
        const key = item.classList.contains('force') ? 'force'
          : item.classList.contains('velocity') ? 'velocity' : 'acceleration';
        item.classList.toggle('is-visible', Boolean(map[key]));
      });
    }

    toast(message, duration = 2400) {
      if (!this.toastEl) return;
      this.toastEl.textContent = message;
      this.toastEl.classList.add('is-visible');
      window.clearTimeout(this.toastTimer);
      this.toastTimer = window.setTimeout(() => {
        this.toastEl.classList.remove('is-visible');
      }, duration);
    }

    setHint(message) {
      if (!this.hintEl) return;
      if (message) {
        this.hintEl.textContent = message;
        this.hintEl.classList.add('is-visible');
      } else {
        this.hintEl.classList.remove('is-visible');
      }
    }

    /* ======================================================================
       Scene objects
       ====================================================================== */

    nextName(type) {
      this.counters[type] = (this.counters[type] || 0) + 1;
      const labels = {
        block: '物块', incline: '斜面', anchor: '锚点',
        spring: '轻弹簧', elastic: '轻弹性绳', rod: '轻硬杆', rope: '轻绳'
      };
      return `${labels[type]} ${this.counters[type]}`;
    }

    nextId(prefix) {
      this._idCounter = (this._idCounter || 0) + 1;
      return `${prefix}${this._idCounter}`;
    }

    initializeBodyRuntime(body) {
      body._contactForce = { x: 0, y: 0 };
      body._contacts = [];
      body._rawContacts = [];
      body._contactSmooth = null;
      body._dragForce = { x: 0, y: 0 };
      body._dragPoint = null;
      body._accel = { x: 0, y: 0 };
      body._lastV = { x: 0, y: 0 };
      body._accelTime = this.state.simTime;
      body.friction = 0;
      body.frictionStatic = 0;
      body.frictionAir = 0;
      body.restitution = 0;
      body.slop = BODY_SLOP;
      body.sleepThreshold = Infinity;
    }

    createBlock(spec = {}, options = {}) {
      const id = this.nextId('b');
      const mass = clamp(Number(spec.mass) || 2, 0.001, 100);
      const width = clamp(Number(spec.width) || 0.8, 0.1, 5);
      const height = clamp(Number(spec.height) || 0.5, 0.1, 5);
      const friction = clamp(Number(spec.friction ?? 0.3), 0, 5);
      const entity = {
        id,
        kind: 'block',
        name: spec.name || this.nextName('block'),
        mass,
        width,
        height,
        friction,
        locked: Boolean(spec.locked),
        body: null,
        home: null
      };
      const pos = spec.position || {
        x: this.camera.x,
        y: Math.min(this.camera.y, -height / 2 - 0.8)
      };
      const angle = Number(spec.angle) || 0;
      this.entities.set(id, entity);
      this.buildBlockBody(entity, pos, angle);
      if (options.select) this.select(id, { openPanel: false });
      return entity;
    }

    buildBlockBody(entity, position, angle = 0) {
      if (entity.body) this.Composite.remove(this.world, entity.body);
      const body = this.Bodies.rectangle(0, 0, entity.width, entity.height, {
        label: entity.name,
        friction: 0,
        frictionStatic: 0,
        frictionAir: 0,
        restitution: 0,
        slop: BODY_SLOP,
        render: { visible: false }
      });
      this.Body.setMass(body, entity.mass);
      this.initializeBodyRuntime(body);
      body._entityId = entity.id;
      body._kind = entity.kind;
      this.Body.setPosition(body, position);
      this.Body.setAngle(body, angle);
      this.Composite.add(this.world, body);
      entity.body = body;
      this.applyEntityLock(entity);
      entity.home = { x: body.position.x, y: body.position.y, angle: body.angle };
      return body;
    }

    createIncline(spec = {}, options = {}) {
      const id = this.nextId('i');
      const mass = clamp(Number(spec.mass) || 10, 0.001, 100);
      const base = clamp(Number(spec.base) || 3, 0.1, 5);
      const height = clamp(Number(spec.height) || 1.5, 0.1, 5);
      const friction = clamp(Number(spec.friction ?? 0.4), 0, 5);
      const entity = {
        id,
        kind: 'incline',
        name: spec.name || this.nextName('incline'),
        mass,
        base,
        height,
        friction,
        orientation: spec.orientation === 'left' ? 'left' : 'right',
        locked: spec.locked === undefined ? true : Boolean(spec.locked),
        body: null,
        home: null
      };
      const baseCenterX = Number.isFinite(Number(spec.x)) ? Number(spec.x) : this.camera.x;
      const bottomY = Number.isFinite(Number(spec.bottomY)) ? Number(spec.bottomY) : 0;
      this.entities.set(id, entity);
      this.buildInclineBody(entity, baseCenterX, bottomY);
      if (options.select) this.select(id, { openPanel: false });
      return entity;
    }

    buildInclineBody(entity, baseCenterX, bottomY, angle = 0) {
      if (entity.body) this.Composite.remove(this.world, entity.body);
      const b = entity.base;
      const h = entity.height;
      const verts = entity.orientation === 'right'
        ? [{ x: 0, y: 0 }, { x: b, y: 0 }, { x: 0, y: -h }]
        : [{ x: 0, y: 0 }, { x: b, y: 0 }, { x: b, y: -h }];
      const body = this.Bodies.fromVertices(0, 0, [verts], {
        label: entity.name,
        friction: 0,
        frictionStatic: 0,
        frictionAir: 0,
        restitution: 0,
        slop: BODY_SLOP,
        render: { visible: false }
      }, true, 0.01, 0.01);
      this.Body.setMass(body, entity.mass);
      this.initializeBodyRuntime(body);
      body._entityId = entity.id;
      body._kind = entity.kind;
      body._orientation = entity.orientation;
      const bounds = body.bounds;
      const centerX = (bounds.min.x + bounds.max.x) / 2;
      this.Body.setPosition(body, {
        x: body.position.x + baseCenterX - centerX,
        y: body.position.y + bottomY - bounds.max.y
      });
      this.Body.setAngle(body, angle);
      this.Composite.add(this.world, body);
      entity.body = body;
      this.applyEntityLock(entity);
      entity.home = { x: body.position.x, y: body.position.y, angle: body.angle };
      return body;
    }

    createAnchor(spec = {}, options = {}) {
      const id = this.nextId('a');
      const entity = {
        id,
        kind: 'anchor',
        name: spec.name || this.nextName('anchor'),
        x: Number.isFinite(Number(spec.x)) ? Number(spec.x) : this.camera.x,
        y: Number.isFinite(Number(spec.y)) ? Number(spec.y) : this.camera.y,
        fixedDirection: Boolean(spec.fixedDirection),
        proxy: null,
        home: null
      };
      this.entities.set(id, entity);
      this.buildAnchorProxy(entity);
      entity.home = { x: entity.x, y: entity.y };
      if (options.select) this.select(id, { openPanel: false });
      return entity;
    }

    buildAnchorProxy(entity) {
      if (entity.proxy) this.Composite.remove(this.world, entity.proxy);
      const proxy = this.Bodies.circle(entity.x, entity.y, 0.001, {
        isStatic: true,
        isSensor: true,
        label: entity.name,
        collisionFilter: { category: 0, mask: 0, group: 0 },
        render: { visible: false }
      });
      proxy._anchorId = entity.id;
      this.Composite.add(this.world, proxy);
      entity.proxy = proxy;
    }

    setAnchorPosition(entity, x, y) {
      entity.x = x;
      entity.y = y;
      if (entity.proxy) this.Body.setPosition(entity.proxy, { x, y });
      for (const conn of this.getAttachedConnectors(entity.id)) {
        const fixed = this.getFixedAnchorInfo(conn);
        if (fixed) this.ensureLockDir(conn, true);
      }
    }

    blockOnIncline(incline, t, spec = {}) {
      const b = incline.base;
      const h = incline.height;
      const right = incline.orientation === 'right';
      const baseCenterX = (incline.body.bounds.min.x + incline.body.bounds.max.x) / 2;
      const surfaceY = 0;
      const bottom = incline.body.bounds.max.y;
      const yy = bottom - h * (1 - t);
      const xx = right
        ? baseCenterX - b / 2 + b * t
        : baseCenterX + b / 2 - b * t;
      const normal = right
        ? normalize({ x: h, y: -b })
        : normalize({ x: -h, y: -b });
      const width = clamp(Number(spec.width) || 0.55, 0.1, 5);
      const height = clamp(Number(spec.height) || 0.35, 0.1, 5);
      const position = {
        x: xx + normal.x * (height / 2 + 0.004),
        y: yy + normal.y * (height / 2 + 0.004)
      };
      const angle = right ? Math.atan2(h, b) : -Math.atan2(h, b);
      return this.createBlock({ ...spec, width, height, position, angle }, { select: false });
    }

    removeEntity(id) {
      const entity = this.entities.get(id);
      if (!entity) return;
      for (const conn of [...this.connectors.values()]) {
        if (conn.a.id === id || conn.b.id === id) this.removeConnector(conn.id, { silent: true });
      }
      if (entity.kind === 'anchor') {
        if (entity.proxy) this.Composite.remove(this.world, entity.proxy);
      } else if (entity.body) {
        this.Composite.remove(this.world, entity.body);
      }
      this.entities.delete(id);
      this.history.delete(id);
      if (this.state.dragBodyId === id) this.endForceDrag();
      if (this.state.selectedId === id) this.state.selectedId = null;
    }

    deleteSelected() {
      const id = this.state.selectedId;
      if (!id) return;
      if (this.connectors.has(id)) {
        this.removeConnector(id);
        this.toast('已删除连接件');
      } else if (this.entities.has(id)) {
        const entity = this.entities.get(id);
        this.removeEntity(id);
        this.toast(`已删除${entity.name}`);
      }
      if (this.state.openPanel) this.renderPanel(true);
      this.updateLiveReadouts(true);
    }

    refFor(entity) {
      return { kind: entity.kind === 'anchor' ? 'anchor' : 'body', id: entity.id };
    }

    getRefEntity(ref) {
      return ref ? this.entities.get(ref.id) : null;
    }

    getRefBody(ref) {
      const entity = this.getRefEntity(ref);
      if (!entity) return null;
      return entity.kind === 'anchor' ? entity.proxy : entity.body;
    }

    getRefPoint(ref) {
      const entity = this.getRefEntity(ref);
      if (!entity) return null;
      if (entity.kind === 'anchor') return { x: entity.x, y: entity.y };
      return entity.body ? { x: entity.body.position.x, y: entity.body.position.y } : null;
    }

    getRefName(ref) {
      const entity = this.getRefEntity(ref);
      return entity ? entity.name : '已删除';
    }

    updateHome(entity) {
      if (!entity) return;
      if (entity.kind === 'anchor') {
        entity.home = { x: entity.x, y: entity.y };
      } else if (entity.body) {
        entity.home = {
          x: entity.body.position.x,
          y: entity.body.position.y,
          angle: entity.body.angle
        };
      }
    }

    getBodyEntity(body) {
      if (!body || !body._entityId) return null;
      return this.entities.get(body._entityId) || null;
    }

    getSurfaceFriction(body) {
      if (!body) return 0;
      if (body._ground) return this.state.groundFriction;
      const entity = this.getBodyEntity(body);
      return entity ? entity.friction : 0;
    }

    /* ======================================================================
       Locking
       A locked body is static for Matter: it never moves, its velocity is
       always zero, but it still collides and still shows force analysis.
       ====================================================================== */

    applyEntityLock(entity) {
      if (!entity || !entity.body) return;
      const body = entity.body;
      if (entity.locked) {
        this.Body.setStatic(body, true);
        this.Body.setPosition(body, { x: body.position.x, y: body.position.y });
      } else if (body.isStatic) {
        this.Body.setStatic(body, false);
        this.Body.setMass(body, entity.mass);
      }
      this.Body.setVelocity(body, { x: 0, y: 0 });
      this.Body.setAngularVelocity(body, 0);
      body._accel = { x: 0, y: 0 };
      body._lastV = { x: 0, y: 0 };
    }

    setEntityLocked(entity, locked) {
      if (!entity || entity.kind === 'anchor') return;
      entity.locked = Boolean(locked);
      if (entity.locked && this.state.dragBodyId === entity.id) this.endForceDrag();
      this.applyEntityLock(entity);
      this.history.delete(entity.id);
      this.updateHome(entity);
      if (this.state.openPanel) this.renderPanel(true);
      this.updateLiveReadouts(true);
    }

    /* ======================================================================
       Connectors
       ====================================================================== */

    createConnector(type, refA, refB, spec = {}, options = {}) {
      const info = CONNECTOR_INFO[type];
      if (!info) return null;
      if (!this.getRefEntity(refA) || !this.getRefEntity(refB)) return null;
      if (refA.id === refB.id) return null;

      const pA = this.getRefPoint(refA);
      const pB = this.getRefPoint(refB);
      const span = clamp(distance(pA, pB), 0.05, 20);
      const id = this.nextId('c');
      const conn = {
        id,
        kind: 'connector',
        type,
        name: spec.name || this.nextName(type),
        a: { ...refA },
        b: { ...refB },
        k: clamp(Number(spec.k) || 30, 1, 100),
        restLength: clamp(Number(spec.restLength) || span * 0.85, 0.05, 20),
        length: clamp(Number(spec.length) || span, 0.05, 20),
        lockDir: null,
        constraint: null,
        _state: 'neutral'
      };
      if (type === 'rod' || type === 'rope') conn.length = clamp(Number(spec.length) || span, 0.05, 20);
      this.connectors.set(id, conn);
      if (this.getFixedAnchorInfo(conn)) this.ensureLockDir(conn, true);
      this.syncConnectorConstraint(conn);
      if (options.select) this.select(id, { openPanel: false });
      return conn;
    }

    getFixedAnchorInfo(conn) {
      for (const [ref, other] of [[conn.a, conn.b], [conn.b, conn.a]]) {
        if (ref.kind !== 'anchor') continue;
        const anchor = this.entities.get(ref.id);
        if (anchor && anchor.fixedDirection) {
          return { anchor, anchorRef: ref, otherRef: other };
        }
      }
      return null;
    }

    ensureLockDir(conn, force = false) {
      const info = this.getFixedAnchorInfo(conn);
      if (!info) {
        conn.lockDir = null;
        return null;
      }
      const pAnchor = { x: info.anchor.x, y: info.anchor.y };
      const pOther = this.getRefPoint(info.otherRef);
      if (!pOther) return conn.lockDir;
      const raw = { x: pOther.x - pAnchor.x, y: pOther.y - pAnchor.y };
      if (force || !conn.lockDir) {
        conn.lockDir = normalize(raw, conn.lockDir || { x: 0, y: 1 });
      }
      return conn.lockDir;
    }

    refreshLocksAround(entityId) {
      for (const conn of this.getAttachedConnectors(entityId)) {
        if (this.getFixedAnchorInfo(conn)) this.ensureLockDir(conn, true);
      }
    }

    getAttachedConnectors(entityId) {
      const result = [];
      for (const conn of this.connectors.values()) {
        if (conn.a.id === entityId || conn.b.id === entityId) result.push(conn);
      }
      return result;
    }

    setAnchorFixed(entity, fixed) {
      entity.fixedDirection = Boolean(fixed);
      for (const conn of this.getAttachedConnectors(entity.id)) {
        if (entity.fixedDirection) {
          this.ensureLockDir(conn, true);
        } else {
          conn.lockDir = null;
        }
      }
    }

    syncConnectorConstraint(conn) {
      if (conn.constraint) {
        this.Composite.remove(this.world, conn.constraint);
        conn.constraint = null;
      }
      // Only a rigid rod is a two-sided constraint. A rope is one-sided and is
      // solved by applyRopeConstraints() instead of a Matter constraint, which
      // would also push the bodies apart when compressed.
      if (conn.type !== 'rod') return;
      const bodyA = this.getRefBody(conn.a);
      const bodyB = this.getRefBody(conn.b);
      if (!bodyA || !bodyB) return;
      const constraint = this.Constraint.create({
        bodyA,
        bodyB,
        pointA: { x: 0, y: 0 },
        pointB: { x: 0, y: 0 },
        length: clamp(conn.length, 0.05, 20),
        stiffness: 1,
        damping: 0,
        render: { visible: false }
      });
      constraint._connectorId = conn.id;
      this.Composite.add(this.world, constraint);
      conn.constraint = constraint;
    }

    syncAllConnectors() {
      for (const conn of this.connectors.values()) this.syncConnectorConstraint(conn);
    }

    removeConnector(id, options = {}) {
      const conn = this.connectors.get(id);
      if (!conn) return;
      if (conn.constraint) this.Composite.remove(this.world, conn.constraint);
      this.connectors.delete(id);
      if (this.state.selectedId === id) this.state.selectedId = null;
      if (!options.silent) this.updateLiveReadouts(true);
    }

    clearAllConstraints() {
      for (const conn of this.connectors.values()) {
        if (conn.constraint) this.Composite.remove(this.world, conn.constraint);
      }
    }

    connectorSpan(conn) {
      const pA = this.getRefPoint(conn.a);
      const pB = this.getRefPoint(conn.b);
      if (!pA || !pB) return 0;
      return distance(pA, pB);
    }

    connectorForce(conn, pA, pB) {
      if (conn.type !== 'spring' && conn.type !== 'elastic') {
        return { magnitude: 0, a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
      }
      const fixed = this.getFixedAnchorInfo(conn);
      if (fixed) {
        const anchorPos = { x: fixed.anchor.x, y: fixed.anchor.y };
        const dir = this.ensureLockDir(conn) || normalize({
          x: pB.x - pA.x,
          y: pB.y - pA.y
        });
        const pOther = this.getRefPoint(fixed.otherRef) || anchorPos;
        const extension = dot({ x: pOther.x - anchorPos.x, y: pOther.y - anchorPos.y }, dir);
        const raw = conn.type === 'spring'
          ? conn.k * (extension - conn.restLength)
          : conn.k * Math.max(0, extension - conn.restLength);
        const onOther = { x: -dir.x * raw, y: -dir.y * raw };
        return {
          magnitude: raw,
          a: fixed.anchorRef.id === conn.a.id ? { x: 0, y: 0 } : onOther,
          b: fixed.anchorRef.id === conn.b.id ? { x: 0, y: 0 } : onOther
        };
      }
      const dx = pB.x - pA.x;
      const dy = pB.y - pA.y;
      const span = Math.hypot(dx, dy);
      const ux = span > 1e-9 ? dx / span : 0;
      const uy = span > 1e-9 ? dy / span : 1;
      const raw = conn.type === 'spring'
        ? conn.k * (span - conn.restLength)
        : conn.k * Math.max(0, span - conn.restLength);
      return {
        magnitude: raw,
        a: { x: ux * raw, y: uy * raw },
        b: { x: -ux * raw, y: -uy * raw }
      };
    }

    /* ======================================================================
       Scene presets and interactive additions
       ====================================================================== */

    clearScene(options = {}) {
      this.endForceDrag();
      this.clearHistory();
      this.resetEngine();
      this.counters = { block: 0, incline: 0, anchor: 0, spring: 0, elastic: 0, rod: 0, rope: 0 };
      this.state.selectedId = null;
      this.state.pendingConnector = null;
      this.state.simTime = 0;
      this.state.running = false;
      this.setHint('');
      this.updateTransportUI();
      this.updateLiveReadouts(true);
      if (this.state.openPanel) this.renderPanel();
      if (!options.silent) this.toast('场景已清空');
    }

    loadPreset(name, options = {}) {
      this.clearScene({ silent: true });
      this.state.gravity = 9.8;
      this.engine.gravity.y = this.state.gravity;
      this.state.groundFriction = 0.5;
      this.state.mode = 'physics';
      this.state.running = false;
      this.updateModeUI();

      if (name === 'ramp') {
        const ramp = this.createIncline({
          x: -0.8, base: 3.6, height: 2.0, mass: 14,
          friction: 0.55, orientation: 'right'
        });
        this.blockOnIncline(ramp, 0.27, {
          mass: 2, width: 0.65, height: 0.45, friction: 0.22
        });
      } else if (name === 'spring') {
        const anchor = this.createAnchor({ x: 0, y: -4.4, fixedDirection: true });
        const block = this.createBlock({
          position: { x: 0, y: -2.7 },
          mass: 1, width: 0.55, height: 0.55, friction: 0.4
        });
        this.createConnector('spring', this.refFor(anchor), this.refFor(block), {
          k: 28, restLength: 1.05
        });
      } else if (name === 'pendulum') {
        const anchor = this.createAnchor({ x: 0, y: -4.35, fixedDirection: false });
        const block = this.createBlock({
          position: { x: 1.7, y: -2.65 },
          mass: 2, width: 0.6, height: 0.6, friction: 0.4
        });
        this.createConnector('rod', this.refFor(anchor), this.refFor(block), {
          length: 2.55
        });
      } else {
        const ramp = this.createIncline({
          x: -2.2, base: 3.4, height: 1.8, mass: 12,
          friction: 0.45, orientation: 'right'
        });
        this.blockOnIncline(ramp, 0.22, {
          mass: 1.5, width: 0.55, height: 0.35, friction: 0.12
        });
        const anchor = this.createAnchor({ x: 2.55, y: -4.2, fixedDirection: true });
        const hanging = this.createBlock({
          position: { x: 2.55, y: -2.72 },
          mass: 1, width: 0.55, height: 0.55, friction: 0.4
        });
        this.createConnector('spring', this.refFor(anchor), this.refFor(hanging), {
          k: 30, restLength: 1.05
        });
      }

      this.state.selectedId = null;
      this.state.pendingConnector = null;
      this.accumulator = 0;
      this.lastTime = performance.now();
      this.fitView();
      this.updateTransportUI();
      this.updateLiveReadouts(true);
      if (this.state.openPanel) this.renderPanel();
      if (!options.silent) {
        this.toast(`已载入「${PRESET_INFO[name]?.label || '预设'}」`, 1800);
      }
    }

    ensureEditMode() {
      if (this.state.mode !== 'edit') this.setMode('edit', { silent: true });
      this.pauseSimulation();
    }

    findSpawnPoint(width, height) {
      const scale = PPU * this.camera.zoom;
      let x = this.camera.x;
      let y = this.camera.y;
      if (y > -height / 2 - 0.3) y = -height / 2 - 1.1;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = { x, y };
        let overlap = false;
        for (const entity of this.entities.values()) {
          if (!entity.body) continue;
          const b = entity.body.bounds;
          if (candidate.x > b.min.x - width / 2 - 0.15 &&
              candidate.x < b.max.x + width / 2 + 0.15 &&
              candidate.y > b.min.y - height / 2 - 0.15 &&
              candidate.y < b.max.y + height / 2 + 0.15) {
            overlap = true;
            break;
          }
        }
        if (!overlap) return candidate;
        x += (width + 0.45) * (attempt % 2 === 0 ? 1 : -1);
        if (Math.abs(x - this.camera.x) * scale > this.width * 0.32) {
          y -= 0.75;
          x = this.camera.x;
        }
      }
      return { x: this.camera.x, y };
    }

    addBlockInteractive() {
      this.ensureEditMode();
      const width = 0.8;
      const height = 0.5;
      const pos = this.findSpawnPoint(width, height);
      const block = this.createBlock({
        position: pos, mass: 2, width, height, friction: 0.3
      });
      this.select(block.id, { openPanel: true });
      this.toast('已添加物块；在编辑模式拖动可调整位置');
    }

    addInclineInteractive() {
      this.ensureEditMode();
      const base = 3;
      const height = 1.5;
      const ramp = this.createIncline({
        x: this.camera.x, base, height, mass: 10,
        friction: 0.4, orientation: 'right'
      });
      this.select(ramp.id, { openPanel: true });
      this.toast('已添加斜面；底边固定，角度由高度控制');
    }

    addAnchorInteractive() {
      this.ensureEditMode();
      let x = this.camera.x;
      let y = this.camera.y;
      if (y > -0.8) y = -1.8;
      const anchor = this.createAnchor({ x, y, fixedDirection: false });
      this.select(anchor.id, { openPanel: true });
      this.toast('已添加锚点；可在属性中锁定连接方向');
    }

    startConnectorPick(type) {
      this.ensureEditMode();
      this.state.pendingConnector = { type, first: null };
      this.state.selectedId = null;
      this.updateModeUI();
      this.setHint(`选择${CONNECTOR_INFO[type].label}的第一个端点 · Esc 取消`);
      this.renderPanel();
    }

    cancelConnectorPick() {
      this.state.pendingConnector = null;
      this.setHint('');
      this.updateModeUI();
      if (this.state.openPanel) this.renderPanel();
    }

    handleConnectorPick(hit) {
      const pending = this.state.pendingConnector;
      if (!pending) return;
      if (!hit || (hit.type !== 'anchor' && hit.type !== 'body')) {
        this.toast('请点击物块、斜面或锚点作为端点');
        return;
      }
      const entity = this.entities.get(hit.id);
      if (!entity) return;
      const ref = this.refFor(entity);
      if (!pending.first) {
        pending.first = ref;
        this.setHint(`第一个端点：${entity.name} · 请选择第二个端点`);
        this.renderPanel();
        return;
      }
      if (pending.first.id === ref.id) {
        this.toast('两个端点不能是同一个物体');
        return;
      }
      const conn = this.createConnector(pending.type, pending.first, ref, {}, { select: true });
      this.state.pendingConnector = null;
      this.setHint('');
      this.updateModeUI();
      if (conn) {
        this.openPanel('connectors');
        this.select(conn.id, { openPanel: false });
        this.toast(`已创建${conn.name}`);
      }
    }

    /* ======================================================================
       Simulation
       ====================================================================== */

    frame(now) {
      const elapsed = clamp((now - this.lastTime) / 1000, 0, 0.08);
      this.lastTime = now;

      if (this.state.running) {
        this.accumulator += elapsed * this.state.speed;
        let steps = 0;
        const maxSteps = 120;
        while (this.accumulator >= FIXED_DT && steps < maxSteps) {
          this.physicsStep();
          this.accumulator -= FIXED_DT;
          steps += 1;
        }
        if (steps >= maxSteps) this.accumulator = 0;
        this.updateAcceleration();
      }

      this.render(now);

      if (now - this.liveTimer > 90) {
        this.liveTimer = now;
        this.updateLiveReadouts();
        if (this.timeReadout) {
          this.timeReadout.innerHTML = `${this.state.simTime.toFixed(2)} <small>s</small>`;
        }
      }

      if (now - this.chartTimer > 90) {
        this.chartTimer = now;
        this.drawCharts();
        this.drawForceDiagram();
      }

      this.raf = requestAnimationFrame(this._frame);
    }

    physicsStep() {
      this.applyDragForce();
      this.prepareConnectorForces();
      this.Engine.update(this.engine, FIXED_DT_MS);
      this.applyDirectionLocks();
      this.applyRopeConstraints();
      this.applyCustomFriction();
      this.state.simTime += FIXED_DT;
      this.updateConnectorStates();
      this.historyTick += 1;
      if (this.historyTick % HISTORY_STRIDE === 0) this.recordHistory();
    }

    /* ----------------------------------------------------------------------
       Light rope: an inextensible, one-sided (tension only) constraint.
       Running it after the solver guarantees it can hold a stretched rope but
       never push two bodies apart when the rope would be slack.
       ---------------------------------------------------------------------- */

    applyRopeConstraints() {
      const ropes = [...this.connectors.values()].filter((conn) => conn.type === 'rope');
      if (!ropes.length) return;
      for (let pass = 0; pass < 2; pass += 1) {
        for (const conn of ropes) {
          // A fixed-direction anchor behaves like a guide rail (handled above).
          if (this.getFixedAnchorInfo(conn)) continue;
          const bodyA = this.getRefBody(conn.a);
          const bodyB = this.getRefBody(conn.b);
          const pA = this.getRefPoint(conn.a);
          const pB = this.getRefPoint(conn.b);
          if (!pA || !pB) continue;
          const dx = pB.x - pA.x;
          const dy = pB.y - pA.y;
          const span = Math.hypot(dx, dy);
          if (!(span > 1e-6)) continue;
          const over = span - conn.length;
          if (over <= 1e-4) continue;

          const ux = dx / span;
          const uy = dy / span;
          const invA = bodyA && !bodyA.isStatic ? bodyA.inverseMass : 0;
          const invB = bodyB && !bodyB.isStatic ? bodyB.inverseMass : 0;
          const total = invA + invB;
          if (total <= 0) continue;

          const moveA = over * (invA / total);
          const moveB = over * (invB / total);
          if (moveA > 0) {
            this.Body.setPosition(bodyA, {
              x: bodyA.position.x + ux * moveA,
              y: bodyA.position.y + uy * moveA
            });
          }
          if (moveB > 0) {
            this.Body.setPosition(bodyB, {
              x: bodyB.position.x - ux * moveB,
              y: bodyB.position.y - uy * moveB
            });
          }

          const vA = invA > 0 ? this.bodyVelocity(bodyA) : { x: 0, y: 0 };
          const vB = invB > 0 ? this.bodyVelocity(bodyB) : { x: 0, y: 0 };
          const rel = (vB.x - vA.x) * ux + (vB.y - vA.y) * uy;
          if (rel > 0) {
            // Cancel only the separating velocity; approaching motion is free.
            const impulse = rel / total;
            if (invA > 0) {
              this.Body.setVelocity(bodyA, {
                x: bodyA.velocity.x + (ux * impulse * invA) / 60,
                y: bodyA.velocity.y + (uy * impulse * invA) / 60
              });
            }
            if (invB > 0) {
              this.Body.setVelocity(bodyB, {
                x: bodyB.velocity.x - (ux * impulse * invB) / 60,
                y: bodyB.velocity.y - (uy * impulse * invB) / 60
              });
            }
          }
        }
      }
    }

    /* ----------------------------------------------------------------------
       Physics-mode dragging = an external force, not a teleport.
       ---------------------------------------------------------------------- */

    applyDragForce() {
      const drag = this.forceDrag;
      if (!drag || !drag.moved) return;
      const entity = this.entities.get(drag.id);
      if (!entity || !entity.body || entity.locked) {
        this.endForceDrag();
        return;
      }
      const body = entity.body;
      const pointer = this.screenToWorld(this.pointer.x, this.pointer.y);
      const target = { x: pointer.x - drag.offset.x, y: pointer.y - drag.offset.y };
      const dx = target.x - body.position.x;
      const dy = target.y - body.position.y;
      const velocity = this.bodyVelocity(body);
      const mass = Math.max(0.001, entity.mass);
      const gravity = Math.max(1, this.state.gravity);
      const stiffness = Math.max(45, mass * gravity * 14);
      const damping = 2 * Math.sqrt(stiffness * mass) * 0.5;
      let fx = stiffness * dx - damping * velocity.x;
      let fy = stiffness * dy - damping * velocity.y;
      const maxForce = Math.max(140, mass * gravity * 16);
      const magnitude = Math.hypot(fx, fy);
      if (magnitude > maxForce) {
        fx *= maxForce / magnitude;
        fy *= maxForce / magnitude;
      }
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
        this.endForceDrag();
        return;
      }
      // The pull acts at the centre of mass, so dragging never spins the body up.
      const center = { x: body.position.x, y: body.position.y };
      if (Math.hypot(fx, fy) > 0.02) {
        this.Body.applyForce(body, center, { x: fx * FORCE_UNIT, y: fy * FORCE_UNIT });
      }
      body._dragForce = { x: fx, y: fy };
      body._dragPoint = center;
    }

    localToWorld(body, local) {
      const cos = Math.cos(body.angle);
      const sin = Math.sin(body.angle);
      return {
        x: body.position.x + local.x * cos - local.y * sin,
        y: body.position.y + local.x * sin + local.y * cos
      };
    }

    worldToLocal(body, world) {
      const cos = Math.cos(-body.angle);
      const sin = Math.sin(-body.angle);
      const dx = world.x - body.position.x;
      const dy = world.y - body.position.y;
      return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
    }

    startForceDrag(entity, worldPoint) {
      if (!entity || !entity.body) return false;
      if (entity.locked) {
        this.toast('该物体已锁定，先在属性面板解锁后才能拖动施力');
        return false;
      }
      if (this.state.mode !== 'physics') return false;
      const body = entity.body;
      this.forceDrag = {
        id: entity.id,
        offset: { x: worldPoint.x - body.position.x, y: worldPoint.y - body.position.y },
        local: this.worldToLocal(body, worldPoint),
        moved: false
      };
      this.state.dragBodyId = entity.id;
      body._dragForce = { x: 0, y: 0 };
      return true;
    }

    endForceDrag() {
      const drag = this.forceDrag;
      if (drag) {
        const entity = this.entities.get(drag.id);
        if (entity && entity.body) {
          entity.body._dragForce = { x: 0, y: 0 };
          entity.body._dragPoint = null;
        }
      }
      this.forceDrag = null;
      this.state.dragBodyId = null;
      this.canvas.classList.remove('is-pulling');
      if (this.hintEl && this.hintEl.textContent.startsWith('拖动中')) this.setHint('');
    }

    /* ----------------------------------------------------------------------
       History sampling for the F-t / v-t / a-t charts.
       ---------------------------------------------------------------------- */

    recordHistory() {
      const t = this.state.simTime;
      for (const entity of this.entities.values()) {
        if (!entity.body) continue;
        const body = entity.body;
        const velocity = this.bodyVelocity(body);
        // Screen y grows downwards; the analysis convention is up = +y.
        const vx = velocity.x;
        const vy = -velocity.y;
        let entry = this.history.get(entity.id);
        if (!entry) {
          entry = {
            t: [], v: [], a: [],
            vx: [], vy: [], ax: [], ay: [], fx: [], fy: []
          };
          this.history.set(entity.id, entry);
        }
        let ax = 0;
        let ay = 0;
        if (Number.isFinite(body._histT) && t - body._histT > 1e-6) {
          const dt = t - body._histT;
          ax = (vx - body._histVx) / dt;
          ay = (vy - body._histVy) / dt;
          if (!Number.isFinite(ax)) ax = 0;
          if (!Number.isFinite(ay)) ay = 0;
        }
        body._histT = t;
        body._histVx = vx;
        body._histVy = vy;
        entry.t.push(t);
        entry.v.push(Math.hypot(vx, vy));
        entry.a.push(Math.hypot(ax, ay));
        entry.vx.push(vx);
        entry.vy.push(vy);
        entry.ax.push(ax);
        entry.ay.push(ay);
        entry.fx.push(ax * entity.mass);
        entry.fy.push(ay * entity.mass);
        if (entry.t.length > HISTORY_MAX) {
          for (const key of ['t', 'v', 'a', 'vx', 'vy', 'ax', 'ay', 'fx', 'fy']) {
            entry[key].splice(0, 600);
          }
        }
      }
    }

    clearHistory() {
      this.history.clear();
      for (const entity of this.entities.values()) {
        if (!entity.body) continue;
        entity.body._histT = undefined;
        entity.body._histVx = 0;
        entity.body._histVy = 0;
      }
    }

    prepareConnectorForces() {
      for (const conn of this.connectors.values()) {
        if (conn.type === 'rod') {
          if (!conn.constraint) this.syncConnectorConstraint(conn);
          if (conn.constraint) {
            conn.constraint.stiffness = 1;
            conn._state = 'rigid';
          }
          continue;
        }
        // A rope is handled as a one-sided distance constraint after the solver
        // (see applyRopeConstraints) so it can only pull, never push.
        if (conn.type === 'rope') continue;

        const pA = this.getRefPoint(conn.a);
        const pB = this.getRefPoint(conn.b);
        if (!pA || !pB) continue;
        const fixed = this.getFixedAnchorInfo(conn);
        if (fixed) {
          const dir = this.ensureLockDir(conn);
          if (!dir) continue;
          const anchorPos = { x: fixed.anchor.x, y: fixed.anchor.y };
          const other = this.getRefPoint(fixed.otherRef);
          if (!other) continue;
          const extension = dot({ x: other.x - anchorPos.x, y: other.y - anchorPos.y }, dir);
          const raw = conn.type === 'spring'
            ? conn.k * (extension - conn.restLength)
            : conn.k * Math.max(0, extension - conn.restLength);
          const otherBody = this.getRefBody(fixed.otherRef);
          if (otherBody && !otherBody.isStatic) {
            this.Body.applyForce(otherBody, otherBody.position, {
              x: -dir.x * raw * FORCE_UNIT,
              y: -dir.y * raw * FORCE_UNIT
            });
          }
          conn._lastForce = raw;
          conn._lastSpan = Math.abs(extension);
          conn._state = conn.type === 'spring'
            ? (extension > conn.restLength + 0.002 ? 'stretched'
              : extension < conn.restLength - 0.002 ? 'compressed' : 'neutral')
            : (extension > conn.restLength + 0.002 ? 'stretched' : 'neutral');
          continue;
        }

        const dx = pB.x - pA.x;
        const dy = pB.y - pA.y;
        const span = Math.hypot(dx, dy);
        const ux = span > 1e-9 ? dx / span : 0;
        const uy = span > 1e-9 ? dy / span : 1;
        const raw = conn.type === 'spring'
          ? conn.k * (span - conn.restLength)
          : conn.k * Math.max(0, span - conn.restLength);
        const bodyA = this.getRefBody(conn.a);
        const bodyB = this.getRefBody(conn.b);
        if (bodyA && !bodyA.isStatic) {
          this.Body.applyForce(bodyA, bodyA.position, {
            x: ux * raw * FORCE_UNIT,
            y: uy * raw * FORCE_UNIT
          });
        }
        if (bodyB && !bodyB.isStatic) {
          this.Body.applyForce(bodyB, bodyB.position, {
            x: -ux * raw * FORCE_UNIT,
            y: -uy * raw * FORCE_UNIT
          });
        }
        conn._lastForce = raw;
        conn._lastSpan = span;
        conn._state = conn.type === 'spring'
          ? (span > conn.restLength + 0.002 ? 'stretched'
            : span < conn.restLength - 0.002 ? 'compressed' : 'neutral')
          : (span > conn.restLength + 0.002 ? 'stretched' : 'neutral');
      }
    }

    applyDirectionLocks() {
      for (const conn of this.connectors.values()) {
        const fixed = this.getFixedAnchorInfo(conn);
        if (!fixed) continue;
        const otherEntity = this.getRefEntity(fixed.otherRef);
        if (!otherEntity || otherEntity.kind === 'anchor' || !otherEntity.body) continue;
        const body = otherEntity.body;
        if (body.isStatic) continue;
        const dir = this.ensureLockDir(conn);
        if (!dir) continue;
        const anchorPos = { x: fixed.anchor.x, y: fixed.anchor.y };
        const p = body.position;
        const rel = { x: p.x - anchorPos.x, y: p.y - anchorPos.y };
        const axial = dot(rel, dir);
        const perp = { x: -dir.y, y: dir.x };
        let target;
        let mode = 'project';

        if (conn.type === 'spring' || conn.type === 'elastic') {
          target = {
            x: anchorPos.x + dir.x * axial,
            y: anchorPos.y + dir.y * axial
          };
        } else if (conn.type === 'rod') {
          target = {
            x: anchorPos.x + dir.x * conn.length,
            y: anchorPos.y + dir.y * conn.length
          };
          mode = 'pin';
        } else {
          const limited = clamp(axial, 0, conn.length);
          target = {
            x: anchorPos.x + dir.x * limited,
            y: anchorPos.y + dir.y * limited
          };
          mode = 'rope';
        }

        if (Math.abs(target.x - p.x) > 1e-7 || Math.abs(target.y - p.y) > 1e-7) {
          this.Body.setPosition(body, target);
        }

        let vx = body.velocity.x;
        let vy = body.velocity.y;
        if (mode === 'pin') {
          vx = 0;
          vy = 0;
        } else {
          const vLat = vx * perp.x + vy * perp.y;
          vx -= perp.x * vLat;
          vy -= perp.y * vLat;
          if (mode === 'rope') {
            let vAx = vx * dir.x + vy * dir.y;
            if (axial >= conn.length - 1e-4 && vAx > 0) vAx = 0;
            if (axial <= 1e-4 && vAx < 0) vAx = 0;
            vx = dir.x * vAx;
            vy = dir.y * vAx;
          }
        }
        this.Body.setVelocity(body, { x: vx, y: vy });
      }
    }

    applyCustomFriction() {
      const dt = FIXED_DT;
      const dt2 = dt * dt;

      for (const entity of this.entities.values()) {
        if (!entity.body) continue;
        entity.body._contactForce = { x: 0, y: 0 };
        entity.body._rawContacts = [];
      }

      const pairs = this.engine.pairs.list;
      for (const pair of pairs) {
        if (!pair.isActive || !pair.collision) continue;
        const A = pair.bodyA;
        const B = pair.bodyB;
        if (!A || !B) continue;
        if (A.isSensor || B.isSensor) continue;
        if (A.isStatic && B.isStatic) continue;

        let normalImpulse = 0;
        let pointSumX = 0;
        let pointSumY = 0;
        let pointCount = 0;
        const contacts = pair.contacts && pair.contacts.length ? pair.contacts : (pair.activeContacts || []);
        for (const contact of contacts) {
          normalImpulse += Math.abs(contact.normalImpulse || 0);
          const vertex = contact.vertex || contact.vertexBody;
          if (vertex) {
            pointSumX += vertex.x;
            pointSumY += vertex.y;
            pointCount += 1;
          }
        }
        if (normalImpulse <= 0) continue;

        const Fn = normalImpulse / dt2;
        if (!Number.isFinite(Fn) || Fn <= 0) continue;

        const n = pair.collision.normal;
        const tx = -n.y;
        const ty = n.x;
        const mu = clamp(Math.min(this.getSurfaceFriction(A), this.getSurfaceFriction(B)), 0, 5);
        const invMass = (A.isStatic ? 0 : A.inverseMass) + (B.isStatic ? 0 : B.inverseMass);

        let J = 0;
        if (mu > 0 && invMass > 0) {
          const vAx = A.isStatic ? 0 : A.velocity.x * 60;
          const vAy = A.isStatic ? 0 : A.velocity.y * 60;
          const vBx = B.isStatic ? 0 : B.velocity.x * 60;
          const vBy = B.isStatic ? 0 : B.velocity.y * 60;
          const vt = (vBx - vAx) * tx + (vBy - vAy) * ty;
          const maxImpulse = mu * Fn * dt;
          J = clamp(-vt / invMass, -maxImpulse, maxImpulse);
          if (Math.abs(J) < 1e-12) J = 0;
          if (!A.isStatic && J !== 0) {
            this.Body.setVelocity(A, {
              x: A.velocity.x - (tx * J * A.inverseMass) / 60,
              y: A.velocity.y - (ty * J * A.inverseMass) / 60
            });
          }
          if (!B.isStatic && J !== 0) {
            this.Body.setVelocity(B, {
              x: B.velocity.x + (tx * J * B.inverseMass) / 60,
              y: B.velocity.y + (ty * J * B.inverseMass) / 60
            });
          }
        }

        const normalOnA = { x: n.x * Fn, y: n.y * Fn };
        const normalOnB = { x: -n.x * Fn, y: -n.y * Fn };
        const frictionOnA = { x: -tx * (J / dt), y: -ty * (J / dt) };
        const frictionOnB = { x: -frictionOnA.x, y: -frictionOnA.y };

        const supports = pair.collision.supports || [];
        const point = pointCount > 0
          ? { x: pointSumX / pointCount, y: pointSumY / pointCount }
          : (supports.length ? { x: supports[0].x, y: supports[0].y } : null);

        const entityA = this.getBodyEntity(A);
        const entityB = this.getBodyEntity(B);
        if (entityA && !A.isSensor) {
          A._contactForce.x += normalOnA.x + frictionOnA.x;
          A._contactForce.y += normalOnA.y + frictionOnA.y;
          if (A._rawContacts && point) {
            A._rawContacts.push({
              otherId: entityB ? entityB.id : (B._ground ? 'ground' : 'body'),
              otherName: entityB ? entityB.name : (B._ground ? '地面' : '物体'),
              point,
              normal: normalOnA,
              friction: frictionOnA
            });
          }
        }
        if (entityB && !B.isSensor) {
          B._contactForce.x += normalOnB.x + frictionOnB.x;
          B._contactForce.y += normalOnB.y + frictionOnB.y;
          if (B._rawContacts && point) {
            B._rawContacts.push({
              otherId: entityA ? entityA.id : (A._ground ? 'ground' : 'body'),
              otherName: entityA ? entityA.name : (A._ground ? '地面' : '物体'),
              point,
              normal: normalOnB,
              friction: frictionOnB
            });
          }
        }
      }

      for (const entity of this.entities.values()) {
        if (entity.body) this.smoothContacts(entity.body);
      }
    }

    /* Contact impulses are reported per solver substep and are noisy right
       after an impact, so smooth them for display. */
    smoothContacts(body) {
      const k = 1 - Math.exp(-FIXED_DT / 0.045);
      const prev = body._contactSmooth instanceof Map ? body._contactSmooth : new Map();
      const next = new Map();
      const now = this.state.simTime;
      for (const raw of body._rawContacts || []) {
        const old = prev.get(raw.otherId);
        if (old) {
          next.set(raw.otherId, {
            otherId: raw.otherId,
            otherName: raw.otherName,
            point: { x: lerp(old.point.x, raw.point.x, k), y: lerp(old.point.y, raw.point.y, k) },
            normal: { x: lerp(old.normal.x, raw.normal.x, k), y: lerp(old.normal.y, raw.normal.y, k) },
            friction: { x: lerp(old.friction.x, raw.friction.x, k), y: lerp(old.friction.y, raw.friction.y, k) },
            seen: now
          });
        } else {
          next.set(raw.otherId, { ...raw, seen: now });
        }
      }
      for (const [key, old] of prev) {
        if (!next.has(key) && now - old.seen < 0.1) next.set(key, old);
      }
      body._contactSmooth = next;
      body._contacts = [...next.values()];
    }

    updateConnectorStates() {
      for (const conn of this.connectors.values()) {
        if (conn.type === 'rod') {
          conn._state = 'rigid';
          continue;
        }
        const span = this.connectorSpan(conn);
        conn._lastSpan = span;
        if (conn.type === 'rope') {
          conn._state = span >= conn.length - 0.002 ? 'taut' : 'slack';
        } else if (conn.type === 'spring') {
          conn._state = span > conn.restLength + 0.002 ? 'stretched'
            : span < conn.restLength - 0.002 ? 'compressed' : 'neutral';
        } else {
          conn._state = span > conn.restLength + 0.002 ? 'stretched' : 'neutral';
        }
      }
    }

    updateAcceleration() {
      const nowSim = this.state.simTime;
      for (const entity of this.entities.values()) {
        if (!entity.body) continue;
        const body = entity.body;
        const dtSim = nowSim - (body._accelTime || 0);
        const vx = body.velocity.x * 60;
        const vy = body.velocity.y * 60;
        if (dtSim > 1e-5 && body._lastV) {
          const rawAx = (vx - body._lastV.x) / dtSim;
          const rawAy = (vy - body._lastV.y) / dtSim;
          const alpha = 1 - Math.exp(-dtSim / 0.055);
          body._accel.x += (rawAx - body._accel.x) * alpha;
          body._accel.y += (rawAy - body._accel.y) * alpha;
          if (!Number.isFinite(body._accel.x)) body._accel.x = 0;
          if (!Number.isFinite(body._accel.y)) body._accel.y = 0;
        }
        body._lastV = { x: vx, y: vy };
        body._accelTime = nowSim;
      }
    }

    bodyVelocity(body) {
      return { x: body.velocity.x * 60, y: body.velocity.y * 60 };
    }

    bodySpeed(body) {
      return Math.hypot(body.velocity.x, body.velocity.y) * 60;
    }

    /* ======================================================================
       Selection and editing helpers
       ====================================================================== */

    select(id, options = {}) {
      this.state.selectedId = id || null;
      if (options.openPanel && id) {
        if (this.connectors.has(id)) {
          this.openPanel('connectors', { preserveScroll: options.preserveScroll });
        } else {
          this.openPanel('objects', { preserveScroll: options.preserveScroll });
        }
      } else if (this.state.openPanel) {
        this.renderPanel(options.preserveScroll);
      }
      this.updateLiveReadouts(true);
    }

    selectedEntity() {
      if (!this.state.selectedId) return null;
      return this.entities.get(this.state.selectedId) || null;
    }

    selectedConnector() {
      if (!this.state.selectedId) return null;
      return this.connectors.get(this.state.selectedId) || null;
    }

    pauseForEditing() {
      if (this.state.running) this.pauseSimulation();
    }

    /* ======================================================================
       Panel rendering
       ====================================================================== */

    renderPanel(preserveScroll = false) {
      if (!this.state.openPanel) return;
      const scroll = preserveScroll ? this.panelBody.scrollTop : 0;
      let html = '';
      switch (this.state.openPanel) {
        case 'objects':
          html = this.renderObjectsPanel();
          break;
        case 'connectors':
          html = this.renderConnectorsPanel();
          break;
        case 'forces':
          html = this.renderForcesPanel();
          break;
        case 'scene':
          html = this.renderScenePanel();
          break;
        case 'display':
          html = this.renderDisplayPanel();
          break;
        case 'analysis':
          html = this.renderAnalysisPanel();
          break;
        case 'help':
          html = this.renderHelpPanel();
          break;
        default:
          html = this.renderObjectsPanel();
      }
      this.panelBody.innerHTML = html;
      this.bindRenderedControls();
      if (preserveScroll) {
        this.panelBody.scrollTop = scroll;
      }
      this.updateLiveReadouts(true);
      if (this.state.openPanel === 'analysis') {
        requestAnimationFrame(() => this.drawCharts());
      }
      if (this.state.openPanel === 'forces') {
        requestAnimationFrame(() => {
          this.drawForceDiagram();
          this.updateForceTable();
        });
      }
    }

    panelHeader(kicker, title) {
      return `
        <div class="panel-head">
          <div>
            <div class="panel-kicker">${kicker}</div>
            <h2>${title}</h2>
          </div>
          <button type="button" class="panel-close" data-action="close-panel" aria-label="收起面板">
            ${ICONS.close}
          </button>
        </div>
      `;
    }

    renderObjectsPanel() {
      const entities = [...this.entities.values()].filter((e) => e.kind !== 'connector');
      const selected = this.selectedEntity();
      const selectedConn = this.selectedConnector();
      const rows = entities.map((entity) => this.entityRowHTML(entity)).join('');
      const empty = `<div class="empty-state">场景中还没有物体。<br>从上方添加物块、斜面或锚点。</div>`;

      let inspector = '';
      if (selected) {
        inspector = this.entityInspectorHTML(selected);
      } else if (selectedConn) {
        inspector = `<div class="notice">已选中连接件「${selectedConn.name}」。<br>打开「连接」面板查看它的参数。</div>`;
      }

      return `
        ${this.panelHeader('OBJECTS / 01', '物体')}
        <section class="panel-section">
          <h3 class="section-title">添加物体 <span class="section-count">3 TYPES</span></h3>
          <div class="add-grid">
            <button type="button" class="add-card" data-action="add-block">
              <span class="add-icon">${ICONS.block}</span>
              <span><strong>物块</strong><small>矩形刚体</small></span>
            </button>
            <button type="button" class="add-card" data-action="add-incline">
              <span class="add-icon">${ICONS.incline}</span>
              <span><strong>斜面</strong><small>直角三角形</small></span>
            </button>
            <button type="button" class="add-card" data-action="add-anchor">
              <span class="add-icon">${ICONS.anchor}</span>
              <span><strong>锚点</strong><small>固定连接点</small></span>
            </button>
          </div>
        </section>

        <section class="panel-section">
          <h3 class="section-title">场景物体 <span class="section-count">${entities.length} ITEMS</span></h3>
          <div class="list">${rows || empty}</div>
        </section>

        ${inspector}
      `;
    }

    entityRowHTML(entity) {
      const selected = this.state.selectedId === entity.id;
      let icon = ICONS.block;
      let meta = '';
      if (entity.kind === 'block') {
        meta = `${formatMass(entity.mass)} · ${entity.width.toFixed(2)} × ${entity.height.toFixed(2)} m · μ ${entity.friction.toFixed(2)}`;
      } else if (entity.kind === 'incline') {
        const angle = Math.atan2(entity.height, entity.base) * 180 / Math.PI;
        meta = `${formatMass(entity.mass)} · 底 ${entity.base.toFixed(2)} m · ${angle.toFixed(1)}° · μ ${entity.friction.toFixed(2)}`;
        icon = ICONS.incline;
      } else {
        meta = `X ${formatCoord(entity.x)} m · H ${formatCoord(-entity.y)} m · ${entity.fixedDirection ? '方向锁定' : '光滑转轴'}`;
        icon = ICONS.anchor;
      }
      return `
        <div class="list-row ${selected ? 'is-selected' : ''} ${entity.locked ? 'is-locked' : ''}" data-select-id="${entity.id}">
          <div class="list-glyph">${icon}</div>
          <div class="list-main">
            <div class="list-title">${entity.name}${entity.locked ? '<span class="lock-tag">锁定</span>' : ''}</div>
            <div class="list-meta">${meta}</div>
          </div>
          ${entity.kind === 'anchor' ? '' : `
            <button type="button" class="row-lock ${entity.locked ? 'is-on' : ''}"
              data-action="toggle-lock-row" data-lock-id="${entity.id}"
              aria-label="${entity.locked ? '解锁' : '锁定'}${entity.name}"
              title="${entity.locked ? '解除锁定' : '锁定位置'}">${entity.locked ? ICONS.lock : ICONS.unlocked}</button>
          `}
          <button type="button" class="row-del" data-action="delete-row" data-delete-id="${entity.id}"
            aria-label="删除${entity.name}">${ICONS.trash}</button>
        </div>
      `;
    }

    lockToggleHTML(entity) {
      if (!entity || entity.kind === 'anchor') return '';
      return `
        <div class="toggle-row">
          <div class="toggle-copy">
            <strong>锁定位置</strong>
            <small>锁定后物体不会移动、速度恒为 0，但仍参与碰撞与受力分析；编辑模式下仍可用鼠标拖动。</small>
          </div>
          <button type="button" class="toggle ${entity.locked ? 'is-on' : ''}"
            data-action="toggle-lock" aria-pressed="${entity.locked ? 'true' : 'false'}"
            aria-label="锁定位置"></button>
        </div>
      `;
    }

    entityInspectorHTML(entity) {
      const typeLabel = entity.kind === 'block' ? 'BLOCK / 物块'
        : entity.kind === 'incline' ? 'INCLINE / 斜面' : 'ANCHOR / 锚点';
      const icon = entity.kind === 'block' ? ICONS.block
        : entity.kind === 'incline' ? ICONS.incline : ICONS.anchor;
      let body = '';

      if (entity.kind === 'block') {
        body = `
          <div class="info-grid">
            <div class="info-cell"><span>速度</span><strong data-live="speed">—</strong></div>
            <div class="info-cell"><span>加速度</span><strong data-live="accel">—</strong></div>
            <div class="info-cell"><span>位置</span><strong data-live="position">—</strong></div>
            <div class="info-cell"><span>转角</span><strong data-live="angle">—</strong></div>
          </div>
          <div class="field-gap"></div>
          ${this.fieldHTML({
            field: 'mass', label: '质量 m', value: entity.mass,
            min: 0.001, max: 100, step: 0.001, unit: 'kg',
            log: true, display: formatMass(entity.mass),
            hint: '范围 1 g – 100 kg，滑块为对数刻度。'
          })}
          ${this.fieldHTML({
            field: 'width', label: '长（水平）', value: entity.width,
            min: 0.1, max: 5, step: 0.01, unit: 'm'
          })}
          ${this.fieldHTML({
            field: 'height', label: '宽（竖直）', value: entity.height,
            min: 0.1, max: 5, step: 0.01, unit: 'm'
          })}
          ${this.fieldHTML({
            field: 'friction', label: '接触面摩擦系数 μ', value: entity.friction,
            min: 0, max: 5, step: 0.01, unit: '',
            display: entity.friction.toFixed(2),
            hint: '两个接触物体取较小的 μ 作为界面摩擦系数。'
          })}
          <div class="notice">编辑模式下可直接拖动物块；修改尺寸会清空该物体的速度。</div>
        `;
      } else if (entity.kind === 'incline') {
        const angle = Math.atan2(entity.height, entity.base) * 180 / Math.PI;
        const minAngle = Math.atan2(0.1, entity.base) * 180 / Math.PI;
        const maxAngle = Math.atan2(5, entity.base) * 180 / Math.PI;
        body = `
          <div class="info-grid">
            <div class="info-cell"><span>速度</span><strong data-live="speed">—</strong></div>
            <div class="info-cell"><span>加速度</span><strong data-live="accel">—</strong></div>
            <div class="info-cell"><span>位置</span><strong data-live="position">—</strong></div>
            <div class="info-cell"><span>倾角</span><strong data-live="angle">—</strong></div>
          </div>
          <div class="field-gap"></div>
          ${this.fieldHTML({
            field: 'mass', label: '质量 m', value: entity.mass,
            min: 0.001, max: 100, step: 0.001, unit: 'kg',
            log: true, display: formatMass(entity.mass),
            hint: '范围 1 g – 100 kg，滑块为对数刻度。'
          })}
          ${this.fieldHTML({
            field: 'base', label: '底边长 b', value: entity.base,
            min: 0.1, max: 5, step: 0.01, unit: 'm',
            hint: '改变角度时底边保持不变。'
          })}
          ${this.fieldHTML({
            field: 'height', label: '高度 h', value: entity.height,
            min: 0.1, max: 5, step: 0.01, unit: 'm'
          })}
          ${this.fieldHTML({
            field: 'angle', label: '倾角 θ', value: angle,
            min: minAngle, max: maxAngle, step: 0.1, unit: '°',
            display: `${angle.toFixed(1)}°`,
            hint: '角度由高度自动决定；底边长度不变。'
          })}
          <div class="field">
            <div class="field-head"><span class="field-label">朝向</span></div>
            <div class="segmented">
              <button type="button" data-action="set-orientation" data-value="right"
                class="${entity.orientation === 'right' ? 'is-active' : ''}">右下斜</button>
              <button type="button" data-action="set-orientation" data-value="left"
                class="${entity.orientation === 'left' ? 'is-active' : ''}">左下斜</button>
            </div>
            <div class="field-hint">「右下斜」表示斜面从左上向右下倾斜。</div>
          </div>
          ${this.fieldHTML({
            field: 'friction', label: '接触面摩擦系数 μ', value: entity.friction,
            min: 0, max: 5, step: 0.01, unit: '',
            display: entity.friction.toFixed(2),
            hint: '两个接触物体取较小的 μ 作为界面摩擦系数。'
          })}
          <div class="notice">改变角度时底边固定、只改变高度；修改形状会清空该斜面的速度。</div>
        `;
      } else {
        const attached = this.getAttachedConnectors(entity.id).length;
        body = `
          <div class="info-grid">
            <div class="info-cell"><span>位置 X</span><strong data-live="anchor-x">${formatCoord(entity.x)} <small>m</small></strong></div>
            <div class="info-cell"><span>离地高度</span><strong data-live="anchor-y">${formatCoord(-entity.y)} <small>m</small></strong></div>
            <div class="info-cell"><span>连接件</span><strong data-live="anchor-links">${attached} <small>个</small></strong></div>
            <div class="info-cell"><span>类型</span><strong>${entity.fixedDirection ? '方向锁定' : '光滑转轴'}</strong></div>
          </div>
          <div class="toggle-row">
            <div class="toggle-copy">
              <strong>固定连接方向</strong>
              <small>开启后，连接件只能沿当前方向伸缩；关闭时为光滑转轴。</small>
            </div>
            <button type="button" class="toggle ${entity.fixedDirection ? 'is-on' : ''}"
              data-action="toggle-anchor-fixed" aria-pressed="${entity.fixedDirection ? 'true' : 'false'}"
              aria-label="固定连接方向"></button>
          </div>
          <div class="notice">锚点不参与碰撞，也不是有质量的物体。编辑模式下可直接拖动锚点。</div>
        `;
      }

      return `
        <section class="panel-section inspector">
          <div class="inspector-head">
            <div class="inspector-title">
              ${icon}
              <div>
                <h3>${entity.name}</h3>
                <div class="inspector-sub">${typeLabel}</div>
              </div>
            </div>
            <div class="inspector-actions">
              <button type="button" class="mini-icon-btn" data-action="delete-selected" aria-label="删除">${ICONS.trash}</button>
            </div>
          </div>
          ${this.lockToggleHTML(entity)}
          ${body}
        </section>
      `;
    }

    connectorRowHTML(conn) {
      const selected = this.state.selectedId === conn.id;
      const info = CONNECTOR_INFO[conn.type];
      const meta = conn.type === 'spring' || conn.type === 'elastic'
        ? `${conn.k.toFixed(1)} N/m · 原长 ${conn.restLength.toFixed(2)} m · ${this.getRefName(conn.a)} ↔ ${this.getRefName(conn.b)}`
        : `长度 ${conn.length.toFixed(2)} m · ${this.getRefName(conn.a)} ↔ ${this.getRefName(conn.b)}`;
      const state = this.connectorStateLabel(conn);
      return `
        <div class="list-row ${selected ? 'is-selected' : ''}" data-select-id="${conn.id}">
          <div class="list-glyph">${ICONS[info.icon]}</div>
          <div class="list-main">
            <div class="list-title">${conn.name}</div>
            <div class="list-meta">${meta}</div>
            <div class="list-meta">${state}</div>
          </div>
          <button type="button" class="row-del" data-action="delete-row" data-delete-id="${conn.id}"
            aria-label="删除${conn.name}">${ICONS.trash}</button>
        </div>
      `;
    }

    connectorStateLabel(conn) {
      const map = {
        stretched: '拉伸', compressed: '压缩', neutral: '自然长度',
        taut: '绷紧', slack: '松弛', rigid: '刚性连接'
      };
      return map[conn._state] || '—';
    }

    renderConnectorsPanel() {
      const connectors = [...this.connectors.values()];
      const pending = this.state.pendingConnector;
      const selected = this.selectedConnector();
      const rows = connectors.map((conn) => this.connectorRowHTML(conn)).join('');
      const empty = `<div class="empty-state">还没有连接件。<br>选择一种连接方式，然后依次点击两个端点。</div>`;

      const addCards = Object.entries(CONNECTOR_INFO).map(([type, info]) => `
        <button type="button" class="add-card ${pending?.type === type ? 'is-picking' : ''}"
          data-action="pick-connector" data-type="${type}">
          <span class="add-icon">${ICONS[info.icon]}</span>
          <span><strong>${info.label}</strong><small>${info.desc}</small></span>
        </button>
      `).join('');

      let pendingNotice = '';
      if (pending) {
        const first = pending.first ? this.getRefName(pending.first) : '尚未选择';
        pendingNotice = `
          <div class="notice accent">
            正在创建${CONNECTOR_INFO[pending.type].label}。<br>
            第一个端点：${first}${pending.first ? '' : ' · 请点击物块或锚点'}<br>
            按 <kbd>Esc</kbd> 取消。
          </div>
        `;
      }

      let inspector = '';
      if (selected) inspector = this.connectorInspectorHTML(selected);

      return `
        ${this.panelHeader('CONNECTORS / 02', '连接')}
        <section class="panel-section">
          <h3 class="section-title">添加连接 <span class="section-count">4 TYPES</span></h3>
          <div class="add-grid connectors">${addCards}</div>
          ${pendingNotice}
        </section>
        <section class="panel-section">
          <h3 class="section-title">已创建 <span class="section-count">${connectors.length} LINKS</span></h3>
          <div class="list">${rows || empty}</div>
        </section>
        ${inspector}
      `;
    }

    connectorInspectorHTML(conn) {
      const info = CONNECTOR_INFO[conn.type];
      const pA = this.getRefPoint(conn.a);
      const pB = this.getRefPoint(conn.b);
      const span = pA && pB ? distance(pA, pB) : 0;
      const force = pA && pB ? this.connectorForce(conn, pA, pB).magnitude : 0;
      const fixed = this.getFixedAnchorInfo(conn);
      let fields = '';

      if (conn.type === 'spring' || conn.type === 'elastic') {
        fields = `
          ${this.fieldHTML({
            field: 'k', label: '劲度系数 k', value: conn.k,
            min: 1, max: 100, step: 0.1, unit: 'N/m',
            display: `${conn.k.toFixed(1)} N/m`, scope: 'connector'
          })}
          ${this.fieldHTML({
            field: 'restLength', label: '原长 L₀', value: conn.restLength,
            min: 0.05, max: 20, step: 0.01, unit: 'm', scope: 'connector'
          })}
        `;
      } else {
        fields = this.fieldHTML({
          field: 'length', label: conn.type === 'rod' ? '杆长 L' : '绳长 L', value: conn.length,
          min: 0.05, max: 20, step: 0.01, unit: 'm', scope: 'connector'
        });
      }

      const forceLabel = conn.type === 'spring' || conn.type === 'elastic'
        ? `${formatForce(Math.abs(force))} <small>N</small>`
        : '—';
      const state = this.connectorStateLabel(conn);

      return `
        <section class="panel-section inspector">
          <div class="inspector-head">
            <div class="inspector-title">
              ${ICONS[info.icon]}
              <div>
                <h3>${conn.name}</h3>
                <div class="inspector-sub">CONNECTOR / ${info.label}</div>
              </div>
            </div>
            <div class="inspector-actions">
              <button type="button" class="mini-icon-btn" data-action="delete-selected" aria-label="删除">${ICONS.trash}</button>
            </div>
          </div>
          <div class="endpoint-pair">
            <div class="endpoint-line"><span class="dot"></span>${this.getRefName(conn.a)}</div>
            <div class="endpoint-line"><span class="dot b"></span>${this.getRefName(conn.b)}</div>
          </div>
          <div class="status-line">
            <span>当前状态</span><strong class="${conn._state === 'slack' ? 'slack' : 'ok'}">${state}</strong>
          </div>
          <div class="info-grid">
            <div class="info-cell"><span>当前长度</span><strong data-live="conn-length">${formatNumber(span)} <small>m</small></strong></div>
            <div class="info-cell"><span>${conn.type === 'spring' || conn.type === 'elastic' ? '弹力' : '约束'}</span><strong data-live="conn-force">${forceLabel}</strong></div>
          </div>
          <div class="field-gap"></div>
          ${fields}
          ${fixed ? `<div class="notice accent">此连接件的一端锚点已固定方向。它只能沿当前方向伸缩或绕固定方向运动；拖动锚点可重新确定方向。</div>` : ''}
          ${conn.type === 'rope' ? '<div class="notice">轻绳只能承受拉力：松弛时没有约束力，拉直后才限制长度。</div>' : ''}
          ${conn.type === 'elastic' ? '<div class="notice">弹性绳只能承受拉力：长度小于原长时没有弹力。</div>' : ''}
          ${conn.type === 'rod' ? '<div class="notice">轻硬杆长度不可改变，既能受拉也能受压。</div>' : ''}
        </section>
      `;
    }

    renderScenePanel() {
      const counts = {
        bodies: [...this.entities.values()].filter((e) => e.kind !== 'anchor').length,
        anchors: [...this.entities.values()].filter((e) => e.kind === 'anchor').length,
        links: this.connectors.size
      };
      const presets = Object.entries(PRESET_INFO).map(([id, info]) => `
        <button type="button" class="preset-btn" data-action="load-preset" data-preset="${id}">
          <span><strong>${info.label}</strong><small>${info.note}</small></span>
          <span class="arrow">→</span>
        </button>
      `).join('');

      return `
        ${this.panelHeader('SCENE / 04', '场景')}
        <section class="panel-section">
          <div class="status-line">
            <span>当前时间</span><strong>${this.state.simTime.toFixed(2)} s</strong>
          </div>
          <div class="info-grid">
            <div class="info-cell"><span>物体</span><strong>${counts.bodies}</strong></div>
            <div class="info-cell"><span>锚点</span><strong>${counts.anchors}</strong></div>
            <div class="info-cell"><span>连接件</span><strong>${counts.links}</strong></div>
            <div class="info-cell"><span>重力 g</span><strong>${this.state.gravity.toFixed(1)} <small>m/s²</small></strong></div>
          </div>
        </section>
        <section class="panel-section">
          <h3 class="section-title">全局参数</h3>
          ${this.fieldHTML({
            field: 'gravity', label: '重力加速度 g', value: this.state.gravity,
            min: 0, max: 20, step: 0.1, unit: 'm/s²',
            display: `${this.state.gravity.toFixed(1)} m/s²`,
            scope: 'global'
          })}
          ${this.fieldHTML({
            field: 'groundFriction', label: '地面摩擦系数 μ', value: this.state.groundFriction,
            min: 0, max: 5, step: 0.01, unit: '',
            display: this.state.groundFriction.toFixed(2),
            scope: 'global',
            hint: '地面与物体接触时，界面 μ 取二者较小值。'
          })}
          <div class="notice">1 m = 100 px。质量、长度、力、速度等读数均使用国际单位。</div>
        </section>
        <section class="panel-section">
          <h3 class="section-title">演示预设 <span class="section-count">4 SCENES</span></h3>
          <div class="preset-list">${presets}</div>
        </section>
        <section class="panel-section">
          <h3 class="section-title">重置</h3>
          <button type="button" class="btn wide danger" data-action="clear-scene">清空整个场景</button>
          <div class="notice">清空后无法恢复。按 <kbd>R</kbd> 只会让物体回到初始位置。</div>
        </section>
      `;
    }

    renderDisplayPanel() {
      return `
        ${this.panelHeader('DISPLAY / 05', '显示')}
        <section class="panel-section">
          <h3 class="section-title">实时矢量</h3>
          <div class="toggle-row">
            <div class="toggle-copy">
              <strong><span class="color-key orange"></span>受力</strong>
              <small>重力、弹力、接触力与约束力，单位 N。</small>
            </div>
            <button type="button" class="toggle ${this.state.showForces ? 'is-on' : ''}"
              data-action="toggle-display" data-key="showForces" aria-pressed="${this.state.showForces}"></button>
          </div>
          <div class="toggle-row">
            <div class="toggle-copy">
              <strong><span class="color-key green"></span>速度</strong>
              <small>物体质心的瞬时速度，单位 m/s。</small>
            </div>
            <button type="button" class="toggle ${this.state.showVelocity ? 'is-on' : ''}"
              data-action="toggle-display" data-key="showVelocity" aria-pressed="${this.state.showVelocity}"></button>
          </div>
          <div class="toggle-row">
            <div class="toggle-copy">
              <strong><span class="color-key red"></span>加速度</strong>
              <small>由模拟速度变化率估计，单位 m/s²。</small>
            </div>
            <button type="button" class="toggle ${this.state.showAcceleration ? 'is-on' : ''}"
              data-action="toggle-display" data-key="showAcceleration" aria-pressed="${this.state.showAcceleration}"></button>
          </div>
        </section>
        <section class="panel-section">
          <h3 class="section-title">画布</h3>
          <div class="toggle-row">
            <div class="toggle-copy">
              <strong>网格与坐标</strong>
              <small>显示米制网格、坐标轴和刻度。</small>
            </div>
            <button type="button" class="toggle ${this.state.showGrid ? 'is-on' : ''}"
              data-action="toggle-display" data-key="showGrid" aria-pressed="${this.state.showGrid}"></button>
          </div>
          <div class="notice">
            三类箭头各自使用统一比例尺：同一时刻所有物体的箭头长度与矢量大小成正比，零向量不绘制。比例显示在画布左下角。
          </div>
        </section>
      `;
    }

    renderAnalysisPanel() {
      const bodies = [...this.entities.values()].filter((e) => e.body);
      const current = this.chartEntity();
      const chips = bodies.map((entity) => `
        <button type="button" class="chip ${current && current.id === entity.id ? 'is-active' : ''}"
          data-select-id="${entity.id}">${entity.name}${entity.locked ? ' · 锁' : ''}</button>
      `).join('');

      return `
        ${this.panelHeader('CHARTS / 06', '自动分析')}
        <section class="panel-section">
          <h3 class="section-title">分析对象 <span class="section-count">${bodies.length} BODIES</span></h3>
          ${bodies.length ? `<div class="chip-row">${chips}</div>` : '<div class="empty-state">场景中没有可分析的物体。</div>'}
          <div class="status-line">
            <span>运动状态</span><strong data-live="chart-state">—</strong>
          </div>
          <div class="section-copy">
            每 1/60 秒采样一次，按水平 x（向右为正）与竖直 y（向上为正）两个分量分别记录，曲线窗口为最近 10 秒。
          </div>
        </section>
        <section class="panel-section">
          ${this.chartGroupHTML('force', 'F–t 合力', 'fx', 'fy', 'N')}
          ${this.chartGroupHTML('velocity', 'v–t 速度', 'vx', 'vy', 'm/s')}
          ${this.chartGroupHTML('acceleration', 'a–t 加速度', 'ax', 'ay', 'm/s²')}
          <button type="button" class="btn wide" data-action="clear-history">清空曲线数据</button>
          <div class="notice">
            横轴为时间，纵轴中线上方为正、下方为负；合力由 F = ma 反推。锁定物体的速度恒为 0。
          </div>
        </section>
      `;
    }

    chartGroupHTML(kind, title, keyX, keyY, unit) {
      return `
        <div class="chart-block">
          <div class="chart-head">
            <span><i class="chart-key ${kind}"></i>${title}</span>
            <span class="chart-unit">${unit}</span>
          </div>
          <div class="chart-row">
            <div class="chart-cell">
              <div class="chart-caption">
                <span>水平 x</span><b data-live="chart-${keyX}">—</b>
              </div>
              <canvas class="chart-canvas sm" data-chart="${keyX}" aria-label="${title}水平分量"></canvas>
            </div>
            <div class="chart-cell">
              <div class="chart-caption">
                <span>竖直 y</span><b data-live="chart-${keyY}">—</b>
              </div>
              <canvas class="chart-canvas sm" data-chart="${keyY}" aria-label="${title}竖直分量"></canvas>
            </div>
          </div>
        </div>
      `;
    }

    /* ----------------------------------------------------------------------
       F-t / v-t / a-t charts
       ---------------------------------------------------------------------- */

    /* ----------------------------------------------------------------------
       Detailed force analysis (particle model)
       ---------------------------------------------------------------------- */

    forceEntity() {
      const selected = this.selectedEntity();
      if (selected && selected.body) return selected;
      return this.chartEntity();
    }

    renderForcesPanel() {
      const bodies = [...this.entities.values()].filter((e) => e.body);
      const current = this.forceEntity();
      const chips = bodies.map((entity) => `
        <button type="button" class="chip ${current && current.id === entity.id ? 'is-active' : ''}"
          data-select-id="${entity.id}">${entity.name}${entity.locked ? ' · 锁' : ''}</button>
      `).join('');

      return `
        ${this.panelHeader('FORCES / 03', '详细受力分析')}
        <section class="panel-section">
          <h3 class="section-title">分析对象 <span class="section-count">${bodies.length} BODIES</span></h3>
          ${bodies.length ? `<div class="chip-row">${chips}</div>` : '<div class="empty-state">场景中没有物体。</div>'}
          <div class="section-copy">
            质点模型：用中心的一个点代表整个物体，每支箭头是一个作用在该物体上的力，方向与相对大小按统一比例绘制。
          </div>
        </section>
        <section class="panel-section">
          <div class="fbd-wrap">
            <canvas class="fbd-canvas" data-force-canvas aria-label="受力示意图"></canvas>
          </div>
          <div class="fbd-hint">
            <span>右为 +x，上为 +y</span><span data-live="fbd-scale">—</span>
          </div>
          <div class="force-table" data-force-table></div>
          <div class="status-line force-total">
            <span>合力 F合</span><strong data-live="force-net">—</strong>
          </div>
          <div class="notice">
            合力等于各力的矢量和（平行四边形法则）；物体平衡时箭头首尾相互抵消，合力为 0。
          </div>
        </section>
      `;
    }

    directionLabel(vec) {
      const angle = Math.atan2(vec.y, vec.x) * 180 / Math.PI;
      const deg = (angle + 360) % 360;
      const ax = Math.abs(vec.x);
      const ay = Math.abs(vec.y);
      let word;
      if (ax < ay * 0.12) word = vec.y >= 0 ? '竖直向上' : '竖直向下';
      else if (ay < ax * 0.12) word = vec.x >= 0 ? '水平向右' : '水平向左';
      else word = `${vec.y >= 0 ? '向上' : '向下'}${vec.x >= 0 ? '偏右' : '偏左'}`;
      return `${word} ${deg.toFixed(0)}°`;
    }

    updateForceTable() {
      if (this.state.openPanel !== 'forces') return;
      const node = this.panelBody.querySelector('[data-force-table]');
      if (!node) return;
      const entity = this.forceEntity();
      if (!entity) {
        if (node.innerHTML !== '') node.innerHTML = '';
        this.setLive('force-net', '—');
        this.setLive('fbd-scale', '—');
        return;
      }
      const list = this.analyzeForces(entity)
        .map((item) => ({
          ...item,
          mag: lengthOf(item.vec),
          // Panel convention: +x right, +y up (screen y grows downward).
          pv: { x: item.vec.x, y: -item.vec.y }
        }))
        .filter((item) => item.mag > 0.01);
      const net = list.reduce((acc, item) => ({
        x: acc.x + item.pv.x, y: acc.y + item.pv.y
      }), { x: 0, y: 0 });
      const netMag = Math.hypot(net.x, net.y);

      const rows = list.map((item) => `
        <div class="force-row">
          <span class="force-name">${item.label}</span>
          <span class="force-mag">${formatForce(item.mag)} N</span>
          <span class="force-dir">${this.directionLabel(item.pv)}</span>
          <span class="force-comp">Fx ${formatSigned(item.pv.x)}　Fy ${formatSigned(item.pv.y)}</span>
        </div>
      `).join('');

      const html = rows || '<div class="empty-state">该物体当前不受力。</div>';
      if (node.innerHTML !== html) node.innerHTML = html;
      this.setLive('force-net',
        `${formatForce(netMag)} <small>N</small>　` +
        `(Fx ${formatSigned(net.x)} · Fy ${formatSigned(net.y)})`);
    }

    drawForceDiagram() {
      if (this.state.openPanel !== 'forces') return;
      const canvas = this.panelBody.querySelector('[data-force-canvas]');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(80, Math.round(rect.width));
      const h = Math.max(90, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const fbd = canvas.getContext('2d');
      fbd.setTransform(dpr, 0, 0, dpr, 0, 0);
      fbd.fillStyle = '#040404';
      fbd.fillRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      fbd.strokeStyle = 'rgba(255,255,255,0.09)';
      fbd.lineWidth = 1;
      fbd.beginPath();
      fbd.moveTo(10, Math.round(cy) + 0.5);
      fbd.lineTo(w - 10, Math.round(cy) + 0.5);
      fbd.moveTo(Math.round(cx) + 0.5, 10);
      fbd.lineTo(Math.round(cx) + 0.5, h - 10);
      fbd.stroke();
      fbd.fillStyle = '#4d4d4d';
      fbd.font = '8px "Cascadia Mono", Consolas, monospace';
      fbd.textAlign = 'right';
      fbd.textBaseline = 'middle';
      fbd.fillText('+x', w - 10, cy - 8);
      fbd.textAlign = 'left';
      fbd.fillText('+y', cx + 6, 14);

      const entity = this.forceEntity();
      if (!entity) {
        fbd.fillStyle = '#3f3f3f';
        fbd.textAlign = 'center';
        fbd.textBaseline = 'middle';
        fbd.fillText('场景中没有物体', cx, cy);
        this.forceDiagramScale = 0;
        return;
      }

      const list = this.analyzeForces(entity)
        .map((item) => ({ ...item, mag: lengthOf(item.vec) }))
        .filter((item) => item.mag > 0.01);
      let maxMag = 0;
      for (const item of list) maxMag = Math.max(maxMag, item.mag);
      const maxLen = Math.min(w, h) / 2 - 28;
      const scale = maxMag > 0 ? Math.min(maxLen / maxMag, 70) : 1;
      this.forceDiagramScale = scale;
      this.setLive('fbd-scale', scale > 0 ? `1 N = ${formatNumber(scale, 1)} px` : '—');

      // Reuse the canvas helpers by pointing them at this canvas for the frame.
      const prev = { ctx: this.ctx, width: this.width, height: this.height };
      this.ctx = fbd;
      this.width = w;
      this.height = h;
      this.labelObstacles = [];

      const net = { x: 0, y: 0 };
      const drawn = [];
      for (const item of list) {
        net.x += item.vec.x;
        net.y += item.vec.y;
        const ux = item.vec.x / item.mag;
        const uy = item.vec.y / item.mag;
        // Nearly collinear forces would hide each other at the particle point,
        // so fan them apart by a few pixels.
        let parallel = 0;
        for (const dir of drawn) {
          if (Math.abs(dir.x * uy - dir.y * ux) < 0.16 && dir.x * ux + dir.y * uy > 0) parallel += 1;
        }
        const shift = parallel === 0 ? 0 : (parallel % 2 === 1 ? 1 : -1) * (7 * Math.ceil(parallel / 2));
        const origin = { x: cx - uy * shift, y: cy + ux * shift };
        drawn.push({ x: ux, y: uy });
        const length = Math.min(item.mag * scale, maxLen);
        const label = `${item.label} ${formatForce(item.mag)} N`;
        const placement = this.placeArrowLabel(label, origin, ux, uy, length, 'side');
        this.drawArrow(origin, { x: ux * length, y: uy * length }, '#ff8a24', 1.8,
          label, { ...placement });
      }

      const netMag = Math.hypot(net.x, net.y);
      if (netMag > 0.05 && list.length > 1) {
        const ux = net.x / netMag;
        const uy = net.y / netMag;
        const length = Math.min(netMag * scale, maxLen);
        const origin = { x: cx - uy * 9, y: cy + ux * 9 };
        const label = `F合 ${formatForce(netMag)} N`;
        const placement = this.placeArrowLabel(label, origin, ux, uy, length, 'side');
        this.drawArrow(origin, { x: ux * length, y: uy * length }, '#c9c9c9', 1.3,
          label, { dash: true, ...placement });
      }

      this.ctx = prev.ctx;
      this.width = prev.width;
      this.height = prev.height;

      fbd.fillStyle = '#000';
      fbd.fillRect(cx - 4, cy - 4, 8, 8);
      fbd.strokeStyle = '#f2f2f2';
      fbd.lineWidth = 1.2;
      fbd.strokeRect(cx - 4.5, cy - 4.5, 9, 9);
      fbd.fillStyle = '#f2f2f2';
      fbd.fillRect(cx - 1.5, cy - 1.5, 3, 3);

      fbd.fillStyle = '#5f5f5f';
      fbd.font = '9px "Segoe UI", "Microsoft YaHei", sans-serif';
      fbd.textAlign = 'left';
      fbd.textBaseline = 'bottom';
      fbd.fillText(`${entity.name} · ${formatMass(entity.mass)}`, 10, h - 8);
      if (Math.abs(netMag) < 0.05 && list.length) {
        fbd.textAlign = 'right';
        fbd.fillStyle = '#8a8a8a';
        fbd.fillText('受力平衡', w - 10, h - 8);
      }
    }

    chartEntity() {
      const selected = this.selectedEntity();
      if (selected && selected.body) return selected;
      for (const entity of this.entities.values()) {
        if (entity.body) return entity;
      }
      return null;
    }

    niceAxis(value) {
      if (!(value > 0) || !Number.isFinite(value)) return 0;
      const exp = Math.floor(Math.log10(value));
      const pow = 10 ** exp;
      const norm = value / pow;
      const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
      return mult * pow;
    }

    drawCharts() {
      if (this.state.openPanel !== 'analysis') return;
      const entity = this.chartEntity();
      const entry = entity ? this.history.get(entity.id) : null;
      for (const canvas of this.panelBody.querySelectorAll('[data-chart]')) {
        this.drawChart(canvas, canvas.dataset.chart, entry);
      }
    }

    drawChart(canvas, key, entry) {
      const config = {
        fx: { color: '#ff8a24', fallback: 10, axis: 'x' },
        fy: { color: '#ff8a24', fallback: 10, axis: 'y' },
        vx: { color: '#56e07b', fallback: 2, axis: 'x' },
        vy: { color: '#56e07b', fallback: 2, axis: 'y' },
        ax: { color: '#ff4e4e', fallback: 2, axis: 'x' },
        ay: { color: '#ff4e4e', fallback: 2, axis: 'y' }
      }[key];
      if (!config) return;

      const rect = canvas.getBoundingClientRect();
      const w = Math.max(60, Math.round(rect.width));
      const h = Math.max(44, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#040404';
      ctx.fillRect(0, 0, w, h);

      const padL = 24;
      const padR = 5;
      const padT = 6;
      const padB = 12;
      const plotW = Math.max(10, w - padL - padR);
      const plotH = Math.max(10, h - padT - padB);

      const now = this.state.simTime;
      const t1 = Math.max(2, now);
      const t0 = Math.max(0, t1 - 10);
      const times = entry ? entry.t : [];
      const series = (entry && entry[key]) || [];

      let startIndex = 0;
      while (startIndex < times.length && times[startIndex] < t0) startIndex += 1;
      let maxAbs = 0;
      const magnitudes = [];
      for (let i = startIndex; i < series.length; i += 1) {
        const value = series[i];
        if (!Number.isFinite(value)) continue;
        maxAbs = Math.max(maxAbs, Math.abs(value));
        magnitudes.push(Math.abs(value));
      }
      // Scale on the bulk of the samples so a single impact spike does not flatten
      // the whole curve; rare extremes simply run off the top edge.
      let scaleRef = maxAbs;
      if (magnitudes.length > 12) {
        magnitudes.sort((a, b) => a - b);
        const p = magnitudes[Math.floor(magnitudes.length * 0.92)] || maxAbs;
        scaleRef = Math.max(p, maxAbs * 0.08);
      }
      const yMax = Math.max(this.niceAxis(scaleRef * 1.2), config.fallback * 0.25);
      const zeroY = padT + plotH / 2;

      ctx.font = '7px "Cascadia Mono", Consolas, monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';

      for (const value of [yMax, 0, -yMax]) {
        const y = zeroY - (value / yMax) * (plotH / 2);
        ctx.strokeStyle = value === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.055)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, Math.round(y) + 0.5);
        ctx.lineTo(padL + plotW, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.fillStyle = value === 0 ? '#6a6a6a' : '#4a4a4a';
        ctx.fillText(this.axisTickLabel(value), padL - 3, y);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#464646';
      ctx.fillText(`${formatNumber(t1, 1)} s`, padL + plotW - 6, padT + plotH + 2);

      if (times.length < 2) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#3f3f3f';
        ctx.fillText('等待数据', padL + plotW / 2, zeroY);
        return;
      }

      const toX = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;
      const toY = (value) => zeroY - (clamp(value, -yMax, yMax) / yMax) * (plotH / 2);

      const lastX = toX(times[times.length - 1]);
      ctx.beginPath();
      let started = false;
      for (let i = startIndex; i < times.length; i += 1) {
        const x = toX(times[i]);
        const y = toY(series[i]);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (!started) return;
      ctx.lineTo(lastX, zeroY);
      ctx.lineTo(toX(times[startIndex]), zeroY);
      ctx.closePath();
      ctx.fillStyle = key.charAt(0) === 'f' ? 'rgba(255,138,36,0.10)'
        : key.charAt(0) === 'v' ? 'rgba(86,224,123,0.10)' : 'rgba(255,78,78,0.10)';
      ctx.fill();

      ctx.beginPath();
      started = false;
      for (let i = startIndex; i < times.length; i += 1) {
        const x = toX(times[i]);
        const y = toY(series[i]);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = config.color;
      ctx.lineWidth = 1.3;
      ctx.stroke();

      const lastValue = series[series.length - 1];
      if (Number.isFinite(lastValue)) {
        ctx.fillStyle = config.color;
        ctx.beginPath();
        ctx.arc(lastX, toY(lastValue), 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    axisTickLabel(value) {
      if (Math.abs(value) < 1e-9) return '0';
      const text = formatNumber(Math.abs(value), 1);
      return value < 0 ? `−${text}` : text;
    }

    renderHelpPanel() {
      return `
        ${this.panelHeader('GUIDE / 07', '帮助')}
        <section class="panel-section">
          <h3 class="section-title">基本操作</h3>
          <ul class="help-list">
            <li><span><b>平移画布</b><br>鼠标左键拖动空白处</span><span>拖拽</span></li>
            <li><span><b>缩放画布</b><br>鼠标滚轮，以指针位置为中心</span><span>滚轮</span></li>
            <li><span><b>开始 / 暂停</b><br>底部按钮或空格键</span><span><kbd>Space</kbd></span></li>
            <li><span><b>单步模拟</b><br>暂停时前进 1/60 秒</span><span>单步</span></li>
            <li><span><b>回到初始位置</b><br>保留场景，重置时间与速度</span><span><kbd>R</kbd></span></li>
            <li><span><b>删除选中</b><br>物体或连接件</span><span><kbd>Del</kbd></span></li>
            <li><span><b>取消选择 / 拾取</b><br>关闭当前操作</span><span><kbd>Esc</kbd></span></li>
          </ul>
        </section>
        <section class="panel-section">
          <h3 class="section-title">物理模式</h3>
          <div class="section-copy">
            按住任意未锁定的物体并拖动，就在重心处施加一个外力；松手立即撤销。拖动时模拟继续运行，受力箭头、速度和加速度同步更新。
          </div>
          <div class="notice">
            外力作用在重心上，因此拖动不会让物体凭空旋转。拖动物体以外的空白处仍然是平移画布。受力箭头按各自的比例尺线性绘制，接触力画在实际接触点上，因此叠放物块之间的压力会单独显示。
          </div>
        </section>
        <section class="panel-section">
          <h3 class="section-title">编辑模式</h3>
          <div class="section-copy">
            切换到「编辑」后模拟暂停。拖动物块、斜面或锚点即可改变位置；右侧面板可修改质量、尺寸、摩擦和连接参数。
          </div>
          <div class="notice">
            添加连接时，依次点击两个端点。端点可以是物块、斜面或锚点；连接件画在物体后面，端点处用实心点标记。
          </div>
          <div class="notice">
            「锁定位置」的物体在模拟中完全不动、速度恒为 0，但仍参与碰撞与受力分析；编辑模式下依然可以拖动。斜面默认锁定。
          </div>
        </section>
        <section class="panel-section">
          <h3 class="section-title">曲线分析</h3>
          <div class="section-copy">
            「曲线」面板记录所选物体的 F–t、v–t、a–t 曲线，每行左右两图分别是水平 x 与竖直 y 分量，向上、向右为正，带符号。采样频率 60 Hz，窗口为最近 10 秒。
          </div>
        </section>
        <section class="panel-section">
          <h3 class="section-title">详细受力分析</h3>
          <div class="section-copy">
            「受力」面板采用质点模型：用中心的一个点代表整个物体，画出作用在它上面的每一个力，并列出大小、方向角与水平/竖直分量，最后给出合力。
          </div>
        </section>
        <section class="panel-section">
          <h3 class="section-title">模型说明</h3>
          <div class="section-copy">
            摩擦使用库仑模型：界面摩擦系数取两物体 μ 的较小值，最大静摩擦与滑动摩擦按同一 μ 计算。斜面与地面之间、物体之间都会发生摩擦。
          </div>
          <div class="notice">
            「固定连接方向」的锚点会锁定连接件的方向：弹簧沿固定轴伸缩，硬杆/绳的端点被约束在该方向的直线上，可用于模拟竖直导轨或固定光滑杆。
          </div>
          <div class="notice">
            模拟使用 360 Hz 固定步长和自定义接触摩擦；空气阻力为零。极小质量或极大劲度系数下，仍可能出现轻微数值振荡。
          </div>
        </section>
        <section class="panel-section">
          <div class="status-line"><span>单位</span><strong>m · kg · N · s</strong></div>
          <div class="section-copy">1 米 = 100 像素（缩放 100% 时）。重力加速度默认 9.8 m/s²。</div>
        </section>
      `;
    }

    /* ----------------------------------------------------------------------
       Panel form helpers
       ---------------------------------------------------------------------- */

    fieldHTML(config) {
      const {
        field, label, value, min, max, step, unit = '', hint = '',
        log = false, display = null, scope = 'entity', numberStep = null
      } = config;
      const rangeMin = log ? 0 : min;
      const rangeMax = log ? 1000 : max;
      const rangeStep = log ? 1 : step;
      const rangeValue = log
        ? clamp(1000 * Math.log(value / min) / Math.log(max / min), 0, 1000)
        : clamp(value, min, max);
      const progress = ((rangeValue - rangeMin) / (rangeMax - rangeMin)) * 100;
      const nStep = numberStep ?? step;
      const displayText = display ?? this.fieldDisplay(field, value);
      const unitHtml = unit ? `<span class="num-unit">${unit}</span>` : '';
      return `
        <div class="field" data-field-wrap="${field}" data-scope="${scope}" data-log="${log ? '1' : '0'}"
          data-min="${min}" data-max="${max}">
          <div class="field-head">
            <span class="field-label">${label}</span>
            <span class="field-value" data-field-value>${displayText}</span>
          </div>
          <div class="field-controls">
            <input class="range" type="range" min="${rangeMin}" max="${rangeMax}" step="${rangeStep}"
              value="${rangeValue}" data-field="${field}" data-role="range" data-log="${log ? '1' : '0'}"
              style="--range-progress:${progress.toFixed(2)}%"
              aria-label="${label}">
            <input class="num-input" type="number" min="${min}" max="${max}" step="${nStep}"
              value="${this.fieldInputValue(field, value)}" data-field="${field}" data-role="number"
              aria-label="${label}">
            ${unitHtml}
          </div>
          ${hint ? `<div class="field-hint">${hint}</div>` : ''}
          ${log ? `<div class="range-labels"><span>${formatMass(min)}</span><span>${formatMass(max)}</span></div>` : ''}
        </div>
      `;
    }

    fieldInputValue(field, value) {
      if (field === 'mass') return formatMassInput(value);
      if (field === 'angle') return value.toFixed(1);
      if (field === 'friction' || field === 'groundFriction') return value.toFixed(2);
      if (field === 'gravity' || field === 'k') return value.toFixed(1);
      return String(roundTo(value, 3));
    }

    fieldDisplay(field, value) {
      if (field === 'mass') return formatMass(value);
      if (field === 'angle') return `${value.toFixed(1)}°`;
      if (field === 'friction' || field === 'groundFriction') return value.toFixed(2);
      if (field === 'gravity') return `${value.toFixed(1)} m/s²`;
      if (field === 'k') return `${value.toFixed(1)} N/m`;
      return `${formatNumber(value)} m`;
    }

    getFieldValue(scope, field) {
      if (scope === 'global') {
        if (field === 'gravity') return this.state.gravity;
        if (field === 'groundFriction') return this.state.groundFriction;
        return null;
      }
      if (scope === 'connector') {
        const conn = this.selectedConnector();
        if (!conn) return null;
        return conn[field];
      }
      const entity = this.selectedEntity();
      if (!entity) return null;
      if (field === 'angle') return Math.atan2(entity.height, entity.base) * 180 / Math.PI;
      return entity[field];
    }

    onFieldInput(input, final) {
      const wrap = input.closest('[data-field-wrap]');
      if (!wrap) return;
      const field = wrap.dataset.fieldWrap;
      const scope = wrap.dataset.scope || 'entity';
      const range = wrap.querySelector('[data-role="range"]');
      const number = wrap.querySelector('[data-role="number"]');

      if (input.type === 'number' && !final) return;

      let value;
      if (input === range) {
        const raw = Number(input.value);
        if (range.dataset.log === '1') {
          const min = Number(wrap.dataset.min);
          const max = Number(wrap.dataset.max);
          value = min * Math.pow(max / min, raw / 1000);
        } else {
          value = raw;
        }
      } else {
        value = Number(input.value);
      }
      if (!Number.isFinite(value)) {
        this.renderPanel(true);
        return;
      }

      const actual = this.applyField(scope, field, value);
      if (actual === null || actual === undefined) {
        this.renderPanel(true);
        return;
      }

      if (range && input !== range) {
        const raw = range.dataset.log === '1'
          ? clamp(1000 * Math.log(actual / Number(wrap.dataset.min)) /
            Math.log(Number(wrap.dataset.max) / Number(wrap.dataset.min)), 0, 1000)
          : actual;
        range.value = raw;
      }
      if (number && input !== number) {
        number.value = this.fieldInputValue(field, actual);
      }
      if (range) {
        const raw = Number(range.value);
        const p = ((raw - Number(range.min)) / (Number(range.max) - Number(range.min))) * 100;
        range.style.setProperty('--range-progress', `${clamp(p, 0, 100).toFixed(2)}%`);
      }
      const fieldValue = wrap.querySelector('[data-field-value]');
      if (fieldValue) fieldValue.textContent = this.fieldDisplay(field, actual);

      if (final) {
        this.renderPanel(true);
        this.updateLiveReadouts(true);
        if (this.state.openPanel === 'scene' && (field === 'gravity' || field === 'groundFriction')) {
          this.updateLegend();
        }
      }
    }

    applyField(scope, field, rawValue) {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) return null;

      if (scope === 'global') {
        if (field === 'gravity') {
          this.state.gravity = clamp(value, 0, 20);
          this.engine.gravity.y = this.state.gravity;
          return this.state.gravity;
        }
        if (field === 'groundFriction') {
          this.state.groundFriction = clamp(value, 0, 5);
          return this.state.groundFriction;
        }
        return null;
      }

      if (scope === 'connector') {
        const conn = this.selectedConnector();
        if (!conn) return null;
        if (field === 'k') {
          conn.k = clamp(value, 1, 100);
          return conn.k;
        }
        if (field === 'restLength') {
          conn.restLength = clamp(value, 0.05, 20);
          return conn.restLength;
        }
        if (field === 'length') {
          conn.length = clamp(value, 0.05, 20);
          if (conn.constraint) conn.constraint.length = conn.length;
          return conn.length;
        }
        return null;
      }

      const entity = this.selectedEntity();
      if (!entity) return null;

      if (field === 'mass') {
        entity.mass = clamp(value, 0.001, 100);
        if (entity.body) {
          this.Body.setMass(entity.body, entity.mass);
          if (entity.locked) this.Body.setStatic(entity.body, true);
        }
        return entity.mass;
      }
      if (field === 'friction') {
        entity.friction = clamp(value, 0, 5);
        return entity.friction;
      }

      if (entity.kind === 'block') {
        if (field !== 'width' && field !== 'height') return null;
        entity[field] = clamp(value, 0.1, 5);
        this.pauseForEditing();
        const body = entity.body;
        const position = { x: body.position.x, y: body.position.y };
        const angle = body.angle;
        this.buildBlockBody(entity, position, angle);
        this.afterGeometryChange(entity);
        return entity[field];
      }

      if (entity.kind === 'incline') {
        if (field === 'base' || field === 'height') {
          entity[field] = clamp(value, 0.1, 5);
          this.rebuildIncline(entity);
          return entity[field];
        }
        if (field === 'angle') {
          const desired = clamp(value, 0, 89.9);
          entity.height = clamp(entity.base * Math.tan(desired * Math.PI / 180), 0.1, 5);
          this.rebuildIncline(entity);
          return Math.atan2(entity.height, entity.base) * 180 / Math.PI;
        }
      }

      return null;
    }

    afterGeometryChange(entity) {
      for (const conn of this.getAttachedConnectors(entity.id)) {
        this.syncConnectorConstraint(conn);
      }
      this.refreshLocksAround(entity.id);
      this.updateHome(entity);
      this.updateAcceleration();
      this.updateLiveReadouts(true);
    }

    rebuildIncline(entity) {
      this.pauseForEditing();
      const old = entity.body;
      const bounds = old.bounds;
      const cx = (bounds.min.x + bounds.max.x) / 2;
      const bottom = bounds.max.y;
      this.buildInclineBody(entity, cx, bottom);
      this.afterGeometryChange(entity);
    }

    /* ----------------------------------------------------------------------
       Panel actions
       ---------------------------------------------------------------------- */

    handlePanelAction(action, element) {
      switch (action) {
        case 'close-panel':
          this.closePanel();
          break;
        case 'add-block':
          this.addBlockInteractive();
          break;
        case 'add-incline':
          this.addInclineInteractive();
          break;
        case 'add-anchor':
          this.addAnchorInteractive();
          break;
        case 'pick-connector':
          this.startConnectorPick(element.dataset.type);
          break;
        case 'delete-selected':
          this.deleteSelected();
          break;
        case 'delete-row': {
          const id = element.dataset.deleteId;
          if (!id) break;
          if (this.connectors.has(id)) {
            this.removeConnector(id);
          } else {
            this.removeEntity(id);
          }
          if (this.state.selectedId === id) this.state.selectedId = null;
          this.renderPanel(true);
          this.updateLiveReadouts(true);
          break;
        }
        case 'set-orientation': {
          const entity = this.selectedEntity();
          if (!entity || entity.kind !== 'incline') break;
          const orientation = element.dataset.value;
          if (orientation !== 'left' && orientation !== 'right') break;
          if (entity.orientation === orientation) break;
          this.pauseForEditing();
          entity.orientation = orientation;
          this.rebuildIncline(entity);
          this.renderPanel(true);
          break;
        }
        case 'toggle-anchor-fixed': {
          const entity = this.selectedEntity();
          if (!entity || entity.kind !== 'anchor') break;
          this.setAnchorFixed(entity, !entity.fixedDirection);
          this.renderPanel(true);
          this.updateLiveReadouts(true);
          break;
        }
        case 'toggle-lock': {
          const entity = this.selectedEntity();
          if (!entity || entity.kind === 'anchor') break;
          this.setEntityLocked(entity, !entity.locked);
          this.toast(entity.locked ? `${entity.name} 已锁定` : `${entity.name} 已解锁`);
          break;
        }
        case 'toggle-lock-row': {
          const entity = this.entities.get(element.dataset.lockId);
          if (!entity || entity.kind === 'anchor') break;
          this.setEntityLocked(entity, !entity.locked);
          this.updateLiveReadouts(true);
          break;
        }
        case 'clear-history':
          this.clearHistory();
          this.drawCharts();
          this.updateLiveReadouts(true);
          break;
        case 'toggle-display': {
          const key = element.dataset.key;
          if (!key) break;
          this.state[key] = !this.state[key];
          this.updateLegend();
          this.renderPanel(true);
          break;
        }
        case 'load-preset':
          this.loadPreset(element.dataset.preset);
          break;
        case 'clear-scene':
          if (window.confirm('确定清空整个场景吗？此操作无法撤销。')) {
            this.clearScene();
          }
          break;
        default:
          break;
      }
    }

    bindRenderedControls() {
      this.panelBody.querySelectorAll('.range').forEach((range) => {
        const value = Number(range.value);
        const min = Number(range.min);
        const max = Number(range.max);
        const p = max > min ? ((value - min) / (max - min)) * 100 : 0;
        range.style.setProperty('--range-progress', `${p.toFixed(2)}%`);
      });
    }

    /* ======================================================================
       Live readouts
       ====================================================================== */

    updateLiveReadouts(force = false) {
      if (!force && !this.state.openPanel) return;
      this.updateChartReadouts();
      this.updateForceTable();
      const entity = this.selectedEntity();
      if (entity) {
        if (entity.kind === 'anchor') {
          this.setLive('anchor-x', `${formatCoord(entity.x)} <small>m</small>`);
          this.setLive('anchor-y', `${formatCoord(-entity.y)} <small>m</small>`);
          const attached = this.getAttachedConnectors(entity.id).length;
          this.setLive('anchor-links', `${attached} <small>个</small>`);
          return;
        }
        const body = entity.body;
        if (!body) return;
        const speed = entity.locked ? 0 : this.bodySpeed(body);
        const v = this.bodyVelocity(body);
        const accel = entity.locked ? { x: 0, y: 0 } : (body._accel || { x: 0, y: 0 });
        const angle = ((body.angle * 180 / Math.PI) % 360 + 540) % 360 - 180;
        this.setLive('speed', `${formatNumber(speed)} <small>m/s</small>`);
        this.setLive('accel', `${formatNumber(Math.hypot(accel.x, accel.y))} <small>m/s²</small>`);
        this.setLive('position', `X ${formatCoord(body.position.x)} · H ${formatCoord(-body.position.y)} <small>m</small>`);
        this.setLive('angle', `${angle.toFixed(1)}°`);
        return;
      }

      const conn = this.selectedConnector();
      if (!conn) return;
      const pA = this.getRefPoint(conn.a);
      const pB = this.getRefPoint(conn.b);
      if (!pA || !pB) return;
      const span = distance(pA, pB);
      this.setLive('conn-length', `${formatNumber(span)} <small>m</small>`);
      if (conn.type === 'spring' || conn.type === 'elastic') {
        const force = this.connectorForce(conn, pA, pB).magnitude;
        this.setLive('conn-force', `${formatForce(Math.abs(force))} <small>N</small>`);
      } else {
        this.setLive('conn-force', '—');
      }
    }

    setLive(key, html) {
      const node = this.panelBody.querySelector(`[data-live="${key}"]`);
      if (node) node.innerHTML = html;
    }

    updateChartReadouts() {
      if (this.state.openPanel !== 'analysis') return;
      const entity = this.chartEntity();
      const entry = entity ? this.history.get(entity.id) : null;
      const latest = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
      const read = (key, unit) => {
        const value = latest(entry && entry[key]);
        if (value === null) return '—';
        return `${formatSigned(value)} <small>${unit}</small>`;
      };
      this.setLive('chart-fx', read('fx', 'N'));
      this.setLive('chart-fy', read('fy', 'N'));
      this.setLive('chart-vx', read('vx', 'm/s'));
      this.setLive('chart-vy', read('vy', 'm/s'));
      this.setLive('chart-ax', read('ax', 'm/s²'));
      this.setLive('chart-ay', read('ay', 'm/s²'));
      const motion = this.motionSummary(entry);
      this.setLive('chart-state', motion.detail ? `${motion.label} · ${motion.detail}` : motion.label);
    }

    /* Coarse classification of the last 1.5 s of motion. */
    motionSummary(entry) {
      if (!entry || entry.t.length < 6) return { label: '等待数据', detail: '' };
      const n = entry.t.length;
      const cutoff = entry.t[n - 1] - 1.5;
      let start = 0;
      while (start < n && entry.t[start] < cutoff) start += 1;
      const speeds = entry.v.slice(start);
      const accels = entry.a.slice(start);
      if (!speeds.length) return { label: '等待数据', detail: '' };
      let maxV = 0;
      let maxA = 0;
      let sumA = 0;
      for (let i = 0; i < speeds.length; i += 1) {
        maxV = Math.max(maxV, speeds[i]);
        maxA = Math.max(maxA, accels[i]);
        sumA += accels[i];
      }
      const avgA = sumA / accels.length;
      let variance = 0;
      for (const value of accels) variance += (value - avgA) ** 2;
      const deviation = Math.sqrt(variance / accels.length);

      // Does the velocity direction stay on one line, reverse, or turn?
      // A curved path has acceleration with a component perpendicular to the
      // velocity (centripetal), which a straight-line motion never has.
      let minDot = 1;
      let bendSum = 0;
      let bendCount = 0;
      let previous = null;
      for (let i = start; i < n; i += 1) {
        const speed = entry.v[i];
        const accel = entry.a[i];
        if (speed > 0.15 && accel > 0.15) {
          const vx = entry.vx[i] / speed;
          const vy = entry.vy[i] / speed;
          const ax = entry.ax[i] / accel;
          const ay = entry.ay[i] / accel;
          bendSum += Math.abs(vx * ay - vy * ax);
          bendCount += 1;
        }
        if (!(speed > 0.06)) continue;
        const ux = entry.vx[i] / speed;
        const uy = entry.vy[i] / speed;
        if (previous) minDot = Math.min(minDot, ux * previous.x + uy * previous.y);
        previous = { x: ux, y: uy };
      }
      const bend = bendCount ? bendSum / bendCount : 0;

      if (bend > 0.34) {
        return { label: '曲线运动', detail: `v ≈ ${formatNumber(maxV)} m/s` };
      }
      if (maxA < 0.05 && maxV < 0.03) return { label: '静止或受力平衡', detail: '合力 ≈ 0' };
      if (maxA < 0.05) return { label: '匀速直线运动', detail: `v ≈ ${formatNumber(maxV)} m/s` };
      if (minDot < 0.94) return { label: '往复直线运动', detail: `v 最大 ${formatNumber(maxV)} m/s` };
      if (deviation < Math.max(0.12, Math.abs(avgA) * 0.25)) {
        return { label: '匀变速直线运动', detail: `a ≈ ${formatNumber(avgA)} m/s²` };
      }
      return { label: '变加速直线运动', detail: `a 最大 ${formatNumber(maxA)} m/s²` };
    }

    /* ======================================================================
       Pointer interaction
       ====================================================================== */

    bindCanvasEvents() {
      this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
      this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
      this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
      this.canvas.addEventListener('pointercancel', (event) => this.onPointerUp(event));
      this.canvas.addEventListener('pointerenter', () => {
        this.pointer.inside = true;
      });
      this.canvas.addEventListener('pointerleave', () => {
        this.pointer.inside = false;
        this.hoverId = null;
        if (!this.drag) {
          this.canvas.classList.remove('is-movable');
          this.canvas.classList.remove('is-panning');
          this.canvas.classList.remove('is-pullable');
        }
      });
      this.canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        const p = this.getPointer(event);
        const delta = event.deltaMode === 1 ? event.deltaY * 18 : event.deltaY;
        this.zoomAt(p.x, p.y, Math.exp(-delta * 0.00125));
      }, { passive: false });
      this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    onPointerDown(event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      const p = this.getPointer(event);
      this.pointer.x = p.x;
      this.pointer.y = p.y;
      this.pointer.inside = true;
      if (this.hintEl && this.hintEl.textContent.startsWith('按空格')) this.setHint('');

      if (this.state.pendingConnector) {
        const hit = this.hitTest(p.x, p.y, true);
        this.handleConnectorPick(hit);
        return;
      }

      const hit = this.hitTest(p.x, p.y);
      this.pointer.down = true;

      if (this.state.mode === 'physics' && hit && hit.type === 'body') {
        const entity = this.entities.get(hit.id);
        if (entity && !entity.locked) {
          const world = this.screenToWorld(p.x, p.y);
          if (this.startForceDrag(entity, world)) {
            this.drag = { kind: 'force', id: entity.id, startX: p.x, startY: p.y, moved: false };
            this.select(entity.id, { openPanel: false });
            try { this.canvas.setPointerCapture(event.pointerId); } catch (error) { /* synthetic events */ }
            this.canvas.classList.add('is-pulling');
            return;
          }
        }
      }

      if (this.state.mode === 'edit' && hit && (hit.type === 'anchor' || hit.type === 'body')) {
        const entity = this.entities.get(hit.id);
        if (entity) {
          this.pauseForEditing();
          const world = this.screenToWorld(p.x, p.y);
          const offset = entity.kind === 'anchor'
            ? { x: world.x - entity.x, y: world.y - entity.y }
            : { x: world.x - entity.body.position.x, y: world.y - entity.body.position.y };
          this.drag = {
            kind: 'entity',
            id: entity.id,
            entity,
            startX: p.x,
            startY: p.y,
            offset,
            moved: false
          };
          this.select(entity.id, { openPanel: false });
          try { this.canvas.setPointerCapture(event.pointerId); } catch (error) { /* synthetic events */ }
          this.canvas.classList.add('is-movable');
          return;
        }
      }

      this.drag = {
        kind: 'pan',
        startX: p.x,
        startY: p.y,
        camX: this.camera.x,
        camY: this.camera.y,
        moved: false
      };
      try { this.canvas.setPointerCapture(event.pointerId); } catch (error) { /* synthetic events */ }
      this.canvas.classList.add('is-panning');
    }
    onPointerMove(event) {
      const p = this.getPointer(event);
      this.pointer.x = p.x;
      this.pointer.y = p.y;
      this.pointer.inside = true;

      if (this.drag) {
        const dx = p.x - this.drag.startX;
        const dy = p.y - this.drag.startY;
        if (!this.drag.moved && Math.hypot(dx, dy) > 2.5) this.drag.moved = true;

        if (this.drag.kind === 'force') {
          if (this.drag.moved && this.forceDrag) {
            this.forceDrag.moved = true;
            if (!this.state.running) this.startSimulation();
            this.setHint('拖动中：按下的位置施加外力，松开即撤销');
          }
          return;
        }

        if (this.drag.kind === 'entity' && this.drag.moved) {
          const entity = this.drag.entity;
          const world = this.screenToWorld(p.x, p.y);
          if (entity.kind === 'anchor') {
            let x = world.x - this.drag.offset.x;
            let y = world.y - this.drag.offset.y;
            y = Math.min(y, 0.8);
            this.setAnchorPosition(entity, x, y);
          } else if (entity.body) {
            let x = world.x - this.drag.offset.x;
            let y = world.y - this.drag.offset.y;
            this.Body.setPosition(entity.body, { x, y });
            if (entity.body.bounds.max.y > 0.002) {
              this.Body.setPosition(entity.body, {
                x: entity.body.position.x,
                y: entity.body.position.y - entity.body.bounds.max.y + 0.002
              });
            }
            this.Body.setVelocity(entity.body, { x: 0, y: 0 });
            this.Body.setAngularVelocity(entity.body, 0);
            entity.body._contactForce = { x: 0, y: 0 };
            entity.body._contactSmooth = null;
            this.refreshLocksAround(entity.id);
          }
          this.updateLiveReadouts(true);
        } else if (this.drag.kind === 'pan') {
          const scale = PPU * this.camera.zoom;
          this.camera.x = this.drag.camX - dx / scale;
          this.camera.y = this.drag.camY - dy / scale;
        }
        return;
      }

      const hit = this.hitTest(p.x, p.y);
      this.hoverId = hit ? hit.id : null;
      this.canvas.classList.remove('is-pullable');
      if (this.state.mode === 'edit' && hit && (hit.type === 'anchor' || hit.type === 'body')) {
        this.canvas.classList.add('is-movable');
      } else {
        this.canvas.classList.remove('is-movable');
        if (this.state.mode === 'physics' && hit && hit.type === 'body') {
          const entity = this.entities.get(hit.id);
          if (entity && !entity.locked) this.canvas.classList.add('is-pullable');
        }
      }
    }

    onPointerUp(event) {
      if (!this.drag) {
        this.pointer.down = false;
        return;
      }
      const p = this.getPointer(event);
      const drag = this.drag;
      this.drag = null;
      this.pointer.down = false;
      this.canvas.classList.remove('is-panning');
      this.canvas.classList.remove('is-pulling');

      if (drag.kind === 'force') {
        this.endForceDrag();
        if (!drag.moved) {
          const hit = this.hitTest(p.x, p.y);
          if (hit) this.select(hit.id, { openPanel: false });
          else this.select(null, { openPanel: false });
        } else {
          this.toast('外力已撤销', 1400);
        }
      } else if (drag.kind === 'entity' && drag.moved) {
        this.updateHome(drag.entity);
        if (drag.entity.body) {
          drag.entity.body._accel = { x: 0, y: 0 };
          drag.entity.body._lastV = { x: 0, y: 0 };
          drag.entity.body._accelTime = this.state.simTime;
        }
        this.refreshLocksAround(drag.entity.id);
        this.select(drag.entity.id, { openPanel: true });
        this.toast('位置已更新');
      } else if (!drag.moved) {
        const hit = this.hitTest(p.x, p.y);
        if (hit) {
          this.select(hit.id, { openPanel: this.state.mode === 'edit' });
        } else {
          this.select(null, { openPanel: false });
        }
      }

      this.canvas.classList.remove('is-movable');
      this.canvas.classList.remove('is-pullable');
      const hit = this.hitTest(p.x, p.y);
      if (this.state.mode === 'edit' && hit && (hit.type === 'anchor' || hit.type === 'body')) {
        this.canvas.classList.add('is-movable');
      } else if (this.state.mode === 'physics' && hit && hit.type === 'body') {
        const entity = this.entities.get(hit.id);
        if (entity && !entity.locked) this.canvas.classList.add('is-pullable');
      }
    }

    hitTest(screenX, screenY, forConnectorPick = false) {
      const point = { x: screenX, y: screenY };
      const entities = [...this.entities.values()].reverse();

      for (const entity of entities) {
        if (entity.kind !== 'anchor') continue;
        const p = this.worldToScreen(entity.x, entity.y);
        if (Math.hypot(p.x - screenX, p.y - screenY) <= 13) {
          return { type: 'anchor', id: entity.id, entity };
        }
      }

      for (const entity of entities) {
        if (entity.kind === 'anchor' || !entity.body) continue;
        const polygon = entity.body.vertices.map((v) => this.worldToScreen(v.x, v.y));
        if (pointInPolygon(point, polygon)) {
          return { type: 'body', id: entity.id, entity };
        }
      }

      if (!forConnectorPick) {
        const conns = [...this.connectors.values()].reverse();
        for (const conn of conns) {
          const pA = this.getRefPoint(conn.a);
          const pB = this.getRefPoint(conn.b);
          if (!pA || !pB) continue;
          const a = this.worldToScreen(pA.x, pA.y);
          const b = this.worldToScreen(pB.x, pB.y);
          if (pointSegmentDistance(point, a, b) <= 8) {
            return { type: 'connector', id: conn.id, conn };
          }
        }
      }
      return null;
    }

    /* ======================================================================
       Rendering
       ====================================================================== */

    render(now) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';

      this.drawGrid();
      this.drawGround();
      this.drawAxesAndLabels();
      this.drawConnectors();
      this.drawEntities();
      this.drawAnchors();
      this.drawVectors();
      this.drawEntityLabels();
      this.drawPendingOverlay();
      this.drawEmptyState();
    }

    drawGrid() {
      if (!this.state.showGrid) return;
      const ctx = this.ctx;
      const scale = PPU * this.camera.zoom;
      const step = niceStep(68 / scale);
      const left = this.camera.x - (this.width / 2) / scale;
      const right = this.camera.x + (this.width / 2) / scale;
      const top = this.camera.y - (this.height / 2) / scale;
      const bottom = this.camera.y + (this.height / 2) / scale;

      const startX = Math.floor(left / step) * step;
      for (let x = startX; x <= right + step; x += step) {
        const sx = Math.round(this.worldToScreen(x, 0).x) + 0.5;
        const index = Math.round(x / step);
        ctx.strokeStyle = index % 5 === 0 ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.032)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, this.height);
        ctx.stroke();
      }

      const startY = Math.floor(top / step) * step;
      for (let y = startY; y <= bottom + step; y += step) {
        const sy = Math.round(this.worldToScreen(0, y).y) + 0.5;
        const index = Math.round(y / step);
        ctx.strokeStyle = index % 5 === 0 ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.032)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, sy);
        ctx.lineTo(this.width, sy);
        ctx.stroke();
      }
    }

    drawGround() {
      const ctx = this.ctx;
      const groundY = this.worldToScreen(0, 0).y;
      if (groundY > this.height + 2) return;

      const top = Math.max(0, groundY);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, this.width, this.height - top);
      ctx.clip();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, top, this.width, this.height - top);
      ctx.strokeStyle = 'rgba(255,255,255,0.055)';
      ctx.lineWidth = 1;
      const span = this.height - top;
      for (let x = -span; x < this.width + span; x += 18) {
        ctx.beginPath();
        ctx.moveTo(x, top + 1);
        ctx.lineTo(x + span, this.height);
        ctx.stroke();
      }
      ctx.restore();

      if (groundY >= 0 && groundY <= this.height) {
        ctx.strokeStyle = '#cfcfcf';
        ctx.lineWidth = 1.35;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(groundY) + 0.5);
        ctx.lineTo(this.width, Math.round(groundY) + 0.5);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(groundY) + 4.5);
        ctx.lineTo(this.width, Math.round(groundY) + 4.5);
        ctx.stroke();

        const label = `地面  μ ${this.state.groundFriction.toFixed(2)}`;
        ctx.font = '9px "Cascadia Mono", Consolas, monospace';
        ctx.fillStyle = '#5f5f5f';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(label, 18, groundY - 8);
      }
    }

    drawAxesAndLabels() {
      if (!this.state.showGrid) return;
      const ctx = this.ctx;
      const scale = PPU * this.camera.zoom;
      const step = niceStep(68 / scale);
      const groundY = this.worldToScreen(0, 0).y;
      const yAxisX = this.worldToScreen(0, 0).x;

      ctx.strokeStyle = '#404040';
      ctx.lineWidth = 1;
      if (yAxisX >= 0 && yAxisX <= this.width) {
        ctx.beginPath();
        ctx.moveTo(Math.round(yAxisX) + 0.5, 0);
        ctx.lineTo(Math.round(yAxisX) + 0.5, Math.min(this.height, groundY));
        ctx.stroke();
      }

      ctx.strokeStyle = '#ececec';
      ctx.lineWidth = 1.35;
      if (groundY >= 0 && groundY <= this.height) {
        ctx.beginPath();
        ctx.moveTo(0, Math.round(groundY) + 0.5);
        ctx.lineTo(this.width, Math.round(groundY) + 0.5);
        ctx.stroke();
      }

      ctx.font = '9px "Cascadia Mono", Consolas, monospace';
      ctx.fillStyle = '#5a5a5a';
      ctx.textBaseline = 'top';

      if (groundY >= 0 && groundY <= this.height - 20) {
        const left = this.camera.x - (this.width / 2) / scale;
        const right = this.camera.x + (this.width / 2) / scale;
        const startX = Math.floor(left / step) * step;
        ctx.textAlign = 'center';
        for (let x = startX; x <= right + step; x += step) {
          if (Math.abs(x) < step * 0.01) continue;
          const sx = this.worldToScreen(x, 0).x;
          if (sx < 14 || sx > this.width - 14) continue;
          ctx.fillStyle = '#505050';
          ctx.fillText(formatCoord(x), sx, groundY + 11);
          ctx.strokeStyle = '#555';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx + 0.5, groundY + 1);
          ctx.lineTo(sx + 0.5, groundY + 4);
          ctx.stroke();
        }
      }

      if (yAxisX >= 10 && yAxisX <= this.width - 10) {
        const top = this.camera.y - (this.height / 2) / scale;
        const bottom = Math.min(0, this.camera.y + (this.height / 2) / scale);
        const startY = Math.floor(top / step) * step;
        ctx.textAlign = 'right';
        for (let y = startY; y <= bottom + step; y += step) {
          if (Math.abs(y) < step * 0.01) continue;
          const sy = this.worldToScreen(0, y).y;
          if (sy < 12 || sy > this.height - 12) continue;
          if (groundY >= 0 && sy > groundY - 8) continue;
          ctx.fillStyle = '#505050';
          ctx.fillText(formatCoord(-y), yAxisX - 6, sy - 4);
          ctx.strokeStyle = '#555';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(yAxisX - 4, sy + 0.5);
          ctx.lineTo(yAxisX - 1, sy + 0.5);
          ctx.stroke();
        }
      }

      if (groundY >= 0 && groundY <= this.height && yAxisX >= 0 && yAxisX <= this.width) {
        ctx.fillStyle = '#5a5a5a';
        ctx.textAlign = 'left';
        ctx.fillText('0', yAxisX + 4, groundY + 11);
      }
      if (groundY >= 0 && groundY <= this.height) {
        ctx.fillStyle = '#484848';
        ctx.textAlign = 'right';
        ctx.fillText('x / m', this.width - 16, groundY + 11);
      }
      if (yAxisX >= 0 && yAxisX <= this.width) {
        ctx.fillStyle = '#484848';
        ctx.textAlign = 'left';
        ctx.fillText('h / m', yAxisX + 7, 12);
      }
    }

    connectorPath(conn, pA, pB, selected) {
      const ctx = this.ctx;
      const len = Math.hypot(pB.x - pA.x, pB.y - pA.y);
      if (len < 1) {
        ctx.beginPath();
        ctx.arc(pA.x, pA.y, 2, 0, Math.PI * 2);
        ctx.stroke();
        return;
      }
      const ux = (pB.x - pA.x) / len;
      const uy = (pB.y - pA.y) / len;
      const px = -uy;
      const py = ux;
      const zoom = this.camera.zoom;

      if (conn.type === 'spring') {
        const lead = Math.min(13, len * 0.14);
        const coils = 9;
        const amp = Math.min(5.5, 3 + zoom * 1.8) * (selected ? 1.15 : 1);
        ctx.beginPath();
        ctx.moveTo(pA.x, pA.y);
        ctx.lineTo(pA.x + ux * lead, pA.y + uy * lead);
        const inside = len - lead * 2;
        for (let i = 0; i <= coils; i += 1) {
          const t = i / coils;
          const off = (i === 0 || i === coils) ? 0 : (i % 2 === 0 ? -amp : amp);
          ctx.lineTo(
            pA.x + ux * (lead + inside * t) + px * off,
            pA.y + uy * (lead + inside * t) + py * off
          );
        }
        ctx.lineTo(pB.x - ux * lead, pB.y - uy * lead);
        ctx.lineTo(pB.x, pB.y);
        ctx.stroke();
        return;
      }

      if (conn.type === 'elastic') {
        const amp = Math.min(3.4, 1.5 + zoom * 1.1) * (selected ? 1.2 : 1);
        const segments = Math.max(24, Math.min(80, Math.round(len / 4)));
        ctx.beginPath();
        for (let i = 0; i <= segments; i += 1) {
          const t = i / segments;
          const envelope = Math.sin(Math.PI * t);
          const off = Math.sin(t * Math.PI * 9) * amp * envelope;
          const x = pA.x + (pB.x - pA.x) * t + px * off;
          const y = pA.y + (pB.y - pA.y) * t + py * off;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        return;
      }

      if (conn.type === 'rod') {
        ctx.beginPath();
        ctx.moveTo(pA.x, pA.y);
        ctx.lineTo(pB.x, pB.y);
        ctx.strokeStyle = selected ? '#ffffff' : '#d8d8d8';
        ctx.lineWidth = selected ? 4.6 : 3.8;
        ctx.stroke();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = selected ? 1.8 : 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(pA.x - px * 4, pA.y - py * 4);
        ctx.lineTo(pA.x + px * 4, pA.y + py * 4);
        ctx.moveTo(pB.x - px * 4, pB.y - py * 4);
        ctx.lineTo(pB.x + px * 4, pB.y + py * 4);
        ctx.strokeStyle = selected ? '#ffffff' : '#d8d8d8';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        return;
      }

      const span = this.connectorSpan(conn);
      const slack = Math.max(0, conn.length - span);
      const sag = slack > 0.008 ? Math.min(30, 4 + slack * PPU * zoom * 1.1) : 0;
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      if (sag > 0.5) {
        ctx.quadraticCurveTo(
          (pA.x + pB.x) / 2, (pA.y + pB.y) / 2 + sag * 1.7,
          pB.x, pB.y
        );
      } else {
        ctx.lineTo(pB.x, pB.y);
      }
      ctx.stroke();
    }

    drawConnectors() {
      const ctx = this.ctx;
      for (const conn of this.connectors.values()) {
        const pA = this.getRefPoint(conn.a);
        const pB = this.getRefPoint(conn.b);
        if (!pA || !pB) continue;
        const a = this.worldToScreen(pA.x, pA.y);
        const b = this.worldToScreen(pB.x, pB.y);
        const selected = this.state.selectedId === conn.id;
        const hovered = this.hoverId === conn.id;
        const fixed = this.getFixedAnchorInfo(conn);

        if (fixed) {
          const anchor = this.worldToScreen(fixed.anchor.x, fixed.anchor.y);
          const dir = this.ensureLockDir(conn) || { x: 0, y: 1 };
          ctx.save();
          ctx.setLineDash([3, 5]);
          ctx.strokeStyle = selected ? 'rgba(114,183,255,0.5)' : 'rgba(255,255,255,0.16)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(anchor.x - dir.x * 22, anchor.y - dir.y * 22);
          ctx.lineTo(anchor.x + dir.x * 22, anchor.y + dir.y * 22);
          ctx.stroke();
          ctx.restore();
        }

        const colors = {
          spring: '#c8c8c8',
          elastic: '#b8b8b8',
          rod: '#d8d8d8',
          rope: '#a4adb8'
        };
        ctx.strokeStyle = selected ? '#ffffff' : hovered ? '#e9e9e9' : colors[conn.type];
        ctx.lineWidth = selected ? 2.4 : hovered ? 2 : 1.5;
        this.connectorPath(conn, a, b, selected);

        if (selected) {
          ctx.fillStyle = '#72b7ff';
          ctx.fillRect(a.x - 3, a.y - 3, 6, 6);
          ctx.fillRect(b.x - 3, b.y - 3, 6, 6);
        }

        if (selected || hovered) {
          const span = this.connectorSpan(conn);
          let text = `${formatNumber(span)} m`;
          if (conn.type === 'spring' || conn.type === 'elastic') {
            const force = this.connectorForce(conn, pA, pB).magnitude;
            text = `${CONNECTOR_INFO[conn.type].label} · L ${formatNumber(span)} m · F ${formatForce(Math.abs(force))} N`;
          } else {
            text = `${CONNECTOR_INFO[conn.type].label} · ${formatNumber(conn.length)} m · ${this.connectorStateLabel(conn)}`;
          }
          this.drawLabel(text, (a.x + b.x) / 2, (a.y + b.y) / 2, '#e8e8e8', {
            align: 'center',
            baseline: 'middle',
            bg: 'rgba(0,0,0,0.78)'
          });
        }
      }
    }

    drawEntities() {
      const ctx = this.ctx;
      for (const entity of this.entities.values()) {
        if (entity.kind === 'anchor' || !entity.body) continue;
        const body = entity.body;
        const selected = this.state.selectedId === entity.id;
        const hovered = this.hoverId === entity.id;
        const polygon = body.vertices.map((v) => this.worldToScreen(v.x, v.y));
        const tracePolygon = () => {
          ctx.beginPath();
          ctx.moveTo(polygon[0].x, polygon[0].y);
          for (let i = 1; i < polygon.length; i += 1) ctx.lineTo(polygon[i].x, polygon[i].y);
          ctx.closePath();
        };

        tracePolygon();
        ctx.fillStyle = selected ? '#171717' : hovered ? '#141414' : '#0e0e0e';
        ctx.fill();

        if (entity.kind === 'incline') {
          ctx.save();
          ctx.clip();
          ctx.strokeStyle = 'rgba(255,255,255,0.035)';
          ctx.lineWidth = 1;
          const minX = Math.min(...polygon.map((p) => p.x));
          const maxX = Math.max(...polygon.map((p) => p.x));
          const minY = Math.min(...polygon.map((p) => p.y));
          const maxY = Math.max(...polygon.map((p) => p.y));
          for (let x = minX - (maxY - minY); x < maxX + (maxY - minY); x += 12) {
            ctx.beginPath();
            ctx.moveTo(x, maxY);
            ctx.lineTo(x + (maxY - minY), minY);
            ctx.stroke();
          }
          ctx.restore();
          tracePolygon();
        }

        ctx.strokeStyle = selected ? '#72b7ff' : hovered ? '#ababab' : '#c7c7c7';
        ctx.lineWidth = selected ? 2 : 1.35;
        ctx.stroke();

        let badge = null;
        if (entity.locked) {
          ctx.save();
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = selected ? 'rgba(114,183,255,0.65)' : 'rgba(255,255,255,0.42)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
          const minY = Math.min(...polygon.map((p) => p.y));
          const topVertex = polygon.reduce((best, p) => (p.y < best.y - 0.5 || (Math.abs(p.y - best.y) < 0.5 && p.x < best.x) ? p : best), polygon[0]);
          badge = { x: topVertex.x + 10, y: minY - 9 };
          this.drawLockBadge(badge.x, badge.y);
          ctx.font = '8px "Cascadia Mono", Consolas, monospace';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const label = '锁定';
          ctx.fillStyle = 'rgba(0,0,0,0.85)';
          ctx.fillRect(badge.x + 9, badge.y - 6, ctx.measureText(label).width + 4, 12);
          ctx.fillStyle = '#b9b9b9';
          ctx.fillText(label, badge.x + 11, badge.y);
        }

        if (selected) {
          ctx.fillStyle = '#72b7ff';
          for (const p of polygon) ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5);
        }

        const center = this.worldToScreen(body.position.x, body.position.y);
        const minX = Math.min(...polygon.map((p) => p.x));
        const maxX = Math.max(...polygon.map((p) => p.x));
        const widthPx = Math.max(1, maxX - minX);
        entity._labelBox = {
          left: minX + 5,
          top: Math.min(...polygon.map((p) => p.y)) + 4,
          width: widthPx - 10,
          fontSize: widthPx < 44 ? 8 : widthPx < 65 ? 9 : 10
        };
        entity._center = center;
      }
    }

    /* Mass labels are drawn after the vectors so they stay readable. */
    drawEntityLabels() {
      const ctx = this.ctx;
      for (const entity of this.entities.values()) {
        if (entity.kind === 'anchor' || !entity.body || !entity._labelBox) continue;
        const selected = this.state.selectedId === entity.id;
        const center = entity._center;
        const fontSize = entity._labelBox.fontSize;
        const text = formatMass(entity.mass);
        const sub = selected
          ? (entity.kind === 'block'
            ? `${entity.width.toFixed(2)} × ${entity.height.toFixed(2)} m`
            : `底 ${entity.base.toFixed(2)} m · ${(Math.atan2(entity.height, entity.base) * 180 / Math.PI).toFixed(1)}°`)
          : '';
        ctx.font = `500 ${fontSize}px "Cascadia Mono", Consolas, monospace`;
        const textWidth = ctx.measureText(text).width;
        const lineHeight = fontSize + 2;
        const boxWidth = textWidth + 10;
        const boxHeight = lineHeight + (sub ? 11 : 0) + 4;
        const top = center.y - boxHeight / 2;
        ctx.fillStyle = 'rgba(0,0,0,0.78)';
        ctx.fillRect(center.x - boxWidth / 2, top, boxWidth, boxHeight);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#f2f2f2';
        ctx.fillText(text, center.x, top + 2 + lineHeight / 2);
        if (sub) {
          ctx.font = '8px "Cascadia Mono", Consolas, monospace';
          ctx.fillStyle = '#a9a9a9';
          ctx.fillText(sub, center.x, top + 4 + lineHeight + 5);
        }
      }
    }

    drawLockBadge(x, y) {
      const ctx = this.ctx;
      ctx.save();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(0,0,0,0.92)';
      ctx.fillRect(x - 7, y - 7, 14, 14);
      ctx.strokeStyle = '#f2f2f2';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x - 7, y - 7, 14, 14);
      ctx.fillStyle = '#f2f2f2';
      ctx.fillRect(x - 3, y - 1, 6, 5);
      ctx.beginPath();
      ctx.arc(x, y - 1.5, 2.4, Math.PI, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    drawAnchors() {
      const ctx = this.ctx;
      for (const entity of this.entities.values()) {
        if (entity.kind !== 'anchor') continue;
        const p = this.worldToScreen(entity.x, entity.y);
        const selected = this.state.selectedId === entity.id;
        const hovered = this.hoverId === entity.id;

        if (selected) {
          ctx.strokeStyle = '#72b7ff';
          ctx.lineWidth = 1;
          const r = 12;
          ctx.beginPath();
          ctx.moveTo(p.x - r, p.y - 4); ctx.lineTo(p.x - r, p.y - r); ctx.lineTo(p.x - 4, p.y - r);
          ctx.moveTo(p.x + 4, p.y - r); ctx.lineTo(p.x + r, p.y - r); ctx.lineTo(p.x + r, p.y - 4);
          ctx.moveTo(p.x + r, p.y + 4); ctx.lineTo(p.x + r, p.y + r); ctx.lineTo(p.x + 4, p.y + r);
          ctx.moveTo(p.x - 4, p.y + r); ctx.lineTo(p.x - r, p.y + r); ctx.lineTo(p.x - r, p.y + 4);
          ctx.stroke();
        }

        if (entity.fixedDirection) {
          ctx.strokeStyle = hovered ? '#ffffff' : '#e0e0e0';
          ctx.lineWidth = 1.4;
          ctx.strokeRect(p.x - 5.5, p.y - 5.5, 11, 11);
          ctx.strokeStyle = 'rgba(255,255,255,0.4)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p.x - 8.5, p.y); ctx.lineTo(p.x - 6.5, p.y);
          ctx.moveTo(p.x + 6.5, p.y); ctx.lineTo(p.x + 8.5, p.y);
          ctx.moveTo(p.x, p.y - 8.5); ctx.lineTo(p.x, p.y - 6.5);
          ctx.moveTo(p.x, p.y + 6.5); ctx.lineTo(p.x, p.y + 8.5);
          ctx.stroke();
        } else {
          ctx.strokeStyle = hovered ? '#ffffff' : '#d5d5d5';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5.2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = 'rgba(255,255,255,0.22)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 8.5, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(p.x - 1.7, p.y - 1.7, 3.4, 3.4);

        if (selected || hovered) {
          const title = entity.name;
          const sub = entity.fixedDirection ? '方向锁定' : '光滑转轴';
          this.drawLabel(`${title} · ${sub}`, p.x + 13, p.y - 1, '#dedede', {
            align: 'left', baseline: 'middle', bg: 'rgba(0,0,0,0.8)'
          });
        }
      }
    }

    attachedHardFix(entityId) {
      for (const conn of this.getAttachedConnectors(entityId)) {
        if (conn.type === 'rod') return true;
        if (conn.type === 'rope' && conn._state === 'taut') return true;
      }
      return false;
    }

    /* ----------------------------------------------------------------------
       Force analysis
       Every force acting on a body is resolved separately, and contact forces
       are attached to their own contact point. That is what makes the pressure
       of a stacked block on the block below it visible instead of cancelling
       against the ground reaction.
       ---------------------------------------------------------------------- */

    shortName(name) {
      if (!name) return '';
      return name
        .replace('物块', '物')
        .replace('斜面', '斜')
        .replace('锚点', '锚')
        .replace(/\s+/g, '');
    }

    analyzeForces(entity) {
      const body = entity.body;
      if (!body) return [];
      const list = [];
      const weight = entity.mass * this.state.gravity;
      if (weight > 0.0005) {
        list.push({
          kind: 'weight',
          label: 'G',
          vec: { x: 0, y: weight },
          point: { x: body.position.x, y: body.position.y },
          width: 1.7
        });
      }

      for (const conn of this.getAttachedConnectors(entity.id)) {
        if (conn.type !== 'spring' && conn.type !== 'elastic') continue;
        const pA = this.getRefPoint(conn.a);
        const pB = this.getRefPoint(conn.b);
        if (!pA || !pB) continue;
        const result = this.connectorForce(conn, pA, pB);
        const vec = conn.a.id === entity.id ? result.a : result.b;
        if (lengthOf(vec) < 0.01) continue;
        list.push({
          kind: 'spring',
          label: 'F弹',
          vec,
          point: { x: body.position.x, y: body.position.y },
          width: 1.6
        });
      }

      for (const contact of body._contacts || []) {
        const normalMag = lengthOf(contact.normal);
        if (normalMag > 0.02) {
          list.push({
            kind: 'normal',
            label: `N·${this.shortName(contact.otherName)}`,
            vec: contact.normal,
            point: contact.point,
            width: 1.8
          });
        }
        const frictionMag = lengthOf(contact.friction);
        if (frictionMag > 0.02) {
          list.push({
            kind: 'friction',
            label: `f·${this.shortName(contact.otherName)}`,
            vec: contact.friction,
            point: contact.point,
            width: 1.3
          });
        }
      }

      const drag = body._dragForce;
      if (drag && lengthOf(drag) > 0.02) {
        list.push({
          kind: 'pull',
          label: 'F外',
          vec: drag,
          point: body._dragPoint || { x: body.position.x, y: body.position.y },
          width: 1.9
        });
      }

      let constrained = Boolean(entity.locked);
      for (const conn of this.getAttachedConnectors(entity.id)) {
        if (conn.type === 'rod') constrained = true;
        if (conn.type === 'rope' && conn._state === 'taut') constrained = true;
        if (conn.type === 'spring' || conn.type === 'elastic') {
          if (this.getFixedAnchorInfo(conn)) constrained = true;
        }
      }
      if (constrained) {
        const net = {
          x: entity.mass * (body._accel?.x || 0),
          y: entity.mass * (body._accel?.y || 0)
        };
        const sum = list.reduce((acc, item) => ({ x: acc.x + item.vec.x, y: acc.y + item.vec.y }), { x: 0, y: 0 });
        const residual = { x: net.x - sum.x, y: net.y - sum.y };
        if (lengthOf(residual) > 0.08) {
          list.push({
            kind: 'constraint',
            label: entity.locked ? 'F锁' : 'F约',
            vec: residual,
            point: { x: body.position.x, y: body.position.y },
            width: 1.4
          });
        }
      }

      return list;
    }

    niceScale(value) {
      if (!(value > 0) || !Number.isFinite(value)) return 1;
      const exp = Math.floor(Math.log10(value));
      const pow = 10 ** exp;
      const norm = value / pow;
      const steps = [1, 1.5, 2, 3, 5, 7, 10];
      let best = steps[0];
      let bestDistance = Infinity;
      for (const step of steps) {
        const distance = Math.abs(Math.log(norm / step));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = step;
        }
      }
      return best * pow;
    }

    vectorScale(kind, maxMagnitude) {
      const cfg = VECTOR_SCALE[kind];
      const now = performance.now();
      const last = this.scaleTime[kind] || now;
      const dt = clamp((now - last) / 1000, 0, 0.25);
      this.scaleTime[kind] = now;
      // A short-lived impact must not rescale the whole diagram, so the
      // reference magnitude follows the scene with a small time constant.
      const prevRef = Number.isFinite(this.scaleRef[kind]) ? this.scaleRef[kind] : maxMagnitude;
      const blend = 1 - Math.exp(-dt / 0.3);
      const ref = prevRef + (maxMagnitude - prevRef) * blend;
      this.scaleRef[kind] = ref;

      const prev = this.scales[kind] || cfg.base;
      if (!(ref > EPS[kind])) return prev;
      const px = ref * prev;
      let want = null;
      let hold = 0;
      if (px > cfg.band[1]) {
        want = 'shrink';
        hold = 150;
      } else if (px < cfg.band[0]) {
        want = 'grow';
        hold = 700;
      }
      if (!want) {
        this.scaleHold[kind] = null;
        return prev;
      }
      const state = this.scaleHold[kind];
      if (!state || state.want !== want) {
        this.scaleHold[kind] = { want, since: now };
        return prev;
      }
      if (now - state.since < hold) return prev;
      const target = clamp(cfg.target / ref, cfg.min, cfg.max);
      const snapped = this.niceScale(target);
      this.scales[kind] = snapped;
      this.scaleHold[kind] = null;
      return snapped;
    }

    /* ----------------------------------------------------------------------
       Label layout helpers: keep vector labels clear of the mass badges and of
       each other.
       ---------------------------------------------------------------------- */

    massLabelLayout(entity) {
      if (!entity._center || !entity._labelBox) return null;
      const ctx = this.ctx;
      const center = entity._center;
      const fontSize = entity._labelBox.fontSize;
      const text = formatMass(entity.mass);
      const selected = this.state.selectedId === entity.id;
      const sub = selected
        ? (entity.kind === 'block'
          ? `${entity.width.toFixed(2)} × ${entity.height.toFixed(2)} m`
          : `底 ${entity.base.toFixed(2)} m · ${(Math.atan2(entity.height, entity.base) * 180 / Math.PI).toFixed(1)}°`)
        : '';
      ctx.font = `500 ${fontSize}px "Cascadia Mono", Consolas, monospace`;
      const textWidth = ctx.measureText(text).width;
      const lineHeight = fontSize + 2;
      const boxWidth = textWidth + 10;
      const boxHeight = lineHeight + (sub ? 11 : 0) + 4;
      return {
        text,
        sub,
        fontSize,
        lineHeight,
        boxWidth,
        boxHeight,
        center,
        left: center.x - boxWidth / 2,
        top: center.y - boxHeight / 2
      };
    }

    rectsOverlap(a, b) {
      return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    }

    labelRect(x, y, dirX, dirY, width, height) {
      let left = x;
      if (dirX > 0.28) left = x;
      else if (dirX < -0.28) left = x - width;
      else left = x - width / 2;
      let top = y;
      if (dirY > 0.35) top = y;
      else if (dirY < -0.35) top = y - height;
      else top = y - height / 2;
      return { x0: left, y0: top, x1: left + width, y1: top + height };
    }

    placeArrowLabel(text, origin, ux, uy, length, mode = 'side') {
      const ctx = this.ctx;
      ctx.font = '9px "Cascadia Mono", Consolas, monospace';
      const width = ctx.measureText(text).width + 6;
      const height = 14;
      const dirX = mode === 'side' ? -uy : ux;
      const dirY = mode === 'side' ? ux : uy;
      const baseX = mode === 'side' ? origin.x + ux * length * 0.5 : origin.x + ux * (length + 9);
      const baseY = mode === 'side' ? origin.y + uy * length * 0.5 : origin.y + uy * (length + 9);
      let offset = mode === 'side' ? 12 : 0;
      let ax = baseX;
      let ay = baseY;
      let rect = null;
      for (let attempt = 0; attempt < 7; attempt += 1) {
        ax = baseX + dirX * offset;
        ay = baseY + dirY * offset;
        rect = this.labelRect(ax, ay, dirX, dirY, width, height);
        if (!this.labelObstacles.some((other) => this.rectsOverlap(other, rect))) break;
        offset += 9;
      }
      if (rect) this.labelObstacles.push(rect);
      return { labelAt: { x: ax, y: ay }, labelDir: { x: dirX, y: dirY } };
    }

    drawVectors() {
      const bodies = [...this.entities.values()].filter((e) => e.body);
      if (!bodies.length) {
        this.updateScaleReadout();
        return;
      }
      this.labelObstacles = [];
      for (const entity of bodies) {
        const layout = this.massLabelLayout(entity);
        if (!layout) continue;
        this.labelObstacles.push({
          x0: layout.left - 2, y0: layout.top - 2,
          x1: layout.left + layout.boxWidth + 2, y1: layout.top + layout.boxHeight + 2
        });
      }
      const analyses = new Map();
      if (this.state.showForces) {
        for (const entity of bodies) analyses.set(entity.id, this.analyzeForces(entity));
      }

      // Draw acceleration and velocity first, forces last, so a force arrow that
      // happens to point the same way stays readable on top of the wider vectors.
      if (this.state.showAcceleration) {
        let maxAccel = 0;
        for (const entity of bodies) {
          const a = entity.body._accel || { x: 0, y: 0 };
          maxAccel = Math.max(maxAccel, Math.hypot(a.x, a.y));
        }
        const scale = this.vectorScale('acceleration', maxAccel);
        const cap = VECTOR_SCALE.acceleration.target * 1.6;
        for (const entity of bodies) {
          const a = entity.body._accel || { x: 0, y: 0 };
          const mag = Math.hypot(a.x, a.y);
          if (mag < EPS.acceleration) continue;
          const origin = this.worldToScreen(entity.body.position.x, entity.body.position.y);
          const length = Math.min(mag * scale, cap);
          const ux = a.x / mag;
          const uy = a.y / mag;
          const label = `a ${formatNumber(mag)} m/s²`;
          const placement = this.placeArrowLabel(label, origin, ux, uy, length, 'tip');
          this.drawArrow(origin, { x: ux * length, y: uy * length }, VECTOR.acceleration, 3.2,
            label, placement);
        }
      }

      if (this.state.showVelocity) {
        let maxSpeed = 0;
        for (const entity of bodies) maxSpeed = Math.max(maxSpeed, this.bodySpeed(entity.body));
        const scale = this.vectorScale('velocity', maxSpeed);
        const cap = VECTOR_SCALE.velocity.target * 1.6;
        for (const entity of bodies) {
          const v = this.bodyVelocity(entity.body);
          const mag = Math.hypot(v.x, v.y);
          if (mag < EPS.velocity) continue;
          const origin = this.worldToScreen(entity.body.position.x, entity.body.position.y);
          const length = Math.min(mag * scale, cap);
          const ux = v.x / mag;
          const uy = v.y / mag;
          const label = `v ${formatNumber(mag)} m/s`;
          const placement = this.placeArrowLabel(label, origin, ux, uy, length, 'tip');
          this.drawArrow(origin, { x: ux * length, y: uy * length }, VECTOR.velocity, 2.2,
            label, placement);
        }
      }

      if (this.state.showForces) {
        let maxForce = 0;
        for (const list of analyses.values()) {
          for (const item of list) maxForce = Math.max(maxForce, lengthOf(item.vec));
        }
        const scale = this.vectorScale('force', maxForce);
        const forceCap = VECTOR_SCALE.force.target * 1.6;
        for (const entity of bodies) {
          const list = analyses.get(entity.id) || [];
          const polygon = entity.body.vertices.map((v) => this.worldToScreen(v.x, v.y));
          for (const item of list) {
            const mag = lengthOf(item.vec);
            if (mag < EPS.force) continue;
            let origin = this.worldToScreen(item.point.x, item.point.y);
            if (item.kind === 'constraint') {
              // Keep the reaction force visually separate from the like-directed
              // weight arrow drawn from the centre of mass.
              const ux = item.vec.x / mag;
              const uy = item.vec.y / mag;
              origin = { x: origin.x - uy * 15, y: origin.y + ux * 15 };
            }
            const ux = item.vec.x / mag;
            const uy = item.vec.y / mag;
            const length = Math.min(mag * scale, forceCap);
            const color = item.kind === 'constraint' ? '#ffab5e' : VECTOR.force;
            const label = `${item.label} ${formatForce(mag)} N`;
            const placement = this.placeArrowLabel(label, origin, ux, uy, length, 'side');
            this.drawArrow(origin, { x: ux * length, y: uy * length }, color,
              item.width || 1.6, label,
              { dash: item.kind === 'constraint', ...placement });
          }
        }
      }

      this.updateScaleReadout();
      this.drawForceDragOverlay();
    }

    updateScaleReadout() {
      const node = this.scaleReadoutEl;
      if (!node) return;
      const parts = [];
      if (this.state.showForces) {
        parts.push(`力 1 N = ${formatNumber(this.scales.force || VECTOR_SCALE.force.base, 2)} px`);
      }
      if (this.state.showVelocity) {
        parts.push(`速度 1 m/s = ${formatNumber(this.scales.velocity || VECTOR_SCALE.velocity.base, 1)} px`);
      }
      if (this.state.showAcceleration) {
        parts.push(`加速度 1 m/s² = ${formatNumber(this.scales.acceleration || VECTOR_SCALE.acceleration.base, 1)} px`);
      }
      const text = parts.join('　·　');
      if (node.textContent !== text) node.textContent = text;
      node.classList.toggle('is-visible', parts.length > 0);
    }

    drawForceDragOverlay() {
      const drag = this.forceDrag;
      if (!drag || !drag.moved) return;
      const entity = this.entities.get(drag.id);
      if (!entity || !entity.body) return;
      const grab = this.localToWorld(entity.body, drag.local);
      const a = this.worldToScreen(grab.x, grab.y);
      const ctx = this.ctx;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(255,138,36,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(this.pointer.x, this.pointer.y);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,138,36,0.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    drawArrow(origin, vector, color, width, label, options = {}) {
      const ctx = this.ctx;
      const mag = Math.hypot(vector.x, vector.y);
      if (mag < 3.2) return;
      const ux = vector.x / mag;
      const uy = vector.y / mag;
      const end = { x: origin.x + vector.x, y: origin.y + vector.y };
      const head = Math.min(8, Math.max(5, mag * 0.2));

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width;
      ctx.save();
      if (options.dash) ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(end.x - ux * head * 0.65, end.y - uy * head * 0.65);
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - ux * head - uy * head * 0.55, end.y - uy * head + ux * head * 0.55);
      ctx.lineTo(end.x - ux * head + uy * head * 0.55, end.y - uy * head - ux * head * 0.55);
      ctx.closePath();
      ctx.fill();

      const lx = options.labelDir ? options.labelDir.x : ux;
      const ly = options.labelDir ? options.labelDir.y : uy;
      let align = 'center';
      let baseline = 'middle';
      if (lx > 0.28) align = 'left';
      else if (lx < -0.28) align = 'right';
      if (ly > 0.35) baseline = 'top';
      else if (ly < -0.35) baseline = 'bottom';
      const pad = options.labelPad || 9;
      const at = options.labelAt || { x: end.x + lx * pad, y: end.y + ly * pad };
      this.drawLabel(label, at.x, at.y, color, {
        align, baseline, bg: 'rgba(0,0,0,0.8)'
      });
    }

    drawLabel(text, x, y, color, options = {}) {
      const ctx = this.ctx;
      const align = options.align || 'left';
      const baseline = options.baseline || 'middle';
      ctx.font = '9px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = align;
      ctx.textBaseline = baseline;
      const pad = 3;
      const width = ctx.measureText(text).width;
      let left = x;
      if (align === 'center') left = x - width / 2;
      else if (align === 'right') left = x - width;
      let top = y;
      if (baseline === 'middle') top = y - 7;
      else if (baseline === 'bottom') top = y - 14;
      // Keep the label inside the canvas, so labels near an edge stay readable.
      if (left + width + pad > this.width - 2) left = this.width - 2 - width - pad;
      if (left < 2) left = 2;
      if (top + 14 > this.height - 2) top = this.height - 16;
      if (top < 2) top = 2;
      let textX = left;
      if (align === 'center') textX = left + width / 2;
      else if (align === 'right') textX = left + width;
      let textY = top;
      if (baseline === 'middle') textY = top + 7;
      else if (baseline === 'bottom') textY = top + 14;
      if (options.bg) {
        ctx.fillStyle = options.bg;
        ctx.fillRect(left - pad, top, width + pad * 2, 14);
      }
      ctx.fillStyle = color;
      ctx.fillText(text, textX, textY);
    }

    drawPendingOverlay() {
      if (!this.state.pendingConnector) return;
      const pending = this.state.pendingConnector;
      const p = { x: this.pointer.x, y: this.pointer.y };
      if (!this.pointer.inside) return;
      if (pending.first) {
        const start = this.getRefPoint(pending.first);
        if (start) {
          const a = this.worldToScreen(start.x, start.y);
          const ctx = this.ctx;
          ctx.save();
          ctx.setLineDash([5, 5]);
          ctx.strokeStyle = 'rgba(114,183,255,0.8)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.restore();
          ctx.strokeStyle = '#72b7ff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(a.x - 8, a.y - 8, 16, 16);
          ctx.fillStyle = '#72b7ff';
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        const ctx = this.ctx;
        ctx.strokeStyle = 'rgba(114,183,255,0.9)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - 7, p.y);
        ctx.lineTo(p.x + 7, p.y);
        ctx.moveTo(p.x, p.y - 7);
        ctx.lineTo(p.x, p.y + 7);
        ctx.stroke();
      }

      const hover = this.hitTest(p.x, p.y, true);
      if (hover && hover.entity) {
        if (hover.entity.kind === 'anchor') {
          const hp = this.worldToScreen(hover.entity.x, hover.entity.y);
          const ctx = this.ctx;
          ctx.strokeStyle = '#72b7ff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(hp.x - 10, hp.y - 10, 20, 20);
        } else if (hover.entity.body) {
          const ctx = this.ctx;
          const poly = hover.entity.body.vertices.map((v) => this.worldToScreen(v.x, v.y));
          ctx.strokeStyle = '#72b7ff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(poly[0].x, poly[0].y);
          for (let i = 1; i < poly.length; i += 1) ctx.lineTo(poly[i].x, poly[i].y);
          ctx.closePath();
          ctx.stroke();
        }
      }
    }

    drawEmptyState() {
      if (this.entities.size > 0 || this.connectors.size > 0) return;
      const ctx = this.ctx;
      const cx = this.width / 2;
      const cy = this.height / 2 - 18;
      ctx.strokeStyle = '#252525';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 22, cy);
      ctx.lineTo(cx + 22, cy);
      ctx.moveTo(cx, cy - 22);
      ctx.lineTo(cx, cy + 22);
      ctx.stroke();
      ctx.fillStyle = '#5e5e5e';
      ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('场景为空', cx, cy + 38);
      ctx.fillStyle = '#444';
      ctx.font = '10px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText('从右侧工具栏添加物体，或载入一个演示预设', cx, cy + 58);
    }
  }

  /* Expose constructor for the boot function below. */
  window.__MechanicsLab = MechanicsLab;

  /* ------------------------------------------------------------------------
     Boot: ensure Matter.js is available, even if the primary CDN fails.
     ------------------------------------------------------------------------ */

  async function boot() {
    if (!window.Matter) {
      for (const url of MATTER_FALLBACKS) {
        try {
          await loadScript(url);
          if (window.Matter) break;
        } catch (error) {
          // Try the next CDN.
        }
      }
    }
    if (!window.Matter) {
      const loading = document.getElementById('bootLoading');
      if (loading) loading.classList.add('is-hidden');
      const error = document.getElementById('bootError');
      if (error) error.hidden = false;
      return;
    }
    window.__mechanicsLab = new window.__MechanicsLab();
    const loading = document.getElementById('bootLoading');
    if (loading) loading.classList.add('is-hidden');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
