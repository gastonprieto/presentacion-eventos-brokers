/* Motor de mensajería para las slides: productor → (cola) → workers.
   Modos: 'sync' (el productor llama al servicio y espera; sin lugar → 503) y
          'queue' (el productor deja el mensaje en la cola y sigue; los workers lo toman).
   Usa el Clock y la geometría de NetKit. Expone window.MsgKit = { MsgSim, rng }. */
(function () {
  'use strict';

  const { Clock, Speed, svgEl, cubic, curve, edge, pop, C, MOBILE, W, H } = window.NetKit;
  const ORANGE = '#fb923c', POISON = '#f87171', REDO = '#facc15';

  // PRNG con semilla (mulberry32): mismas opciones → misma simulación
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DEFAULTS = {
    mode: 'queue', rate: 2, arrival: 'poisson', workers: 1, maxWorkers: 6,
    workTime: 1.2, workJitter: 0.2, slots: 3, travel: 0.4, maxRetries: 3, seed: 1,
    pops: true, clickWorkers: false,
    labels: { producer: 'App', producerSub: 'productor', queue: 'Cola', worker: 'Worker', service: 'Servicio', serviceSub: '' }
  };

  const quant = (arr, q) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };

  class MsgSim {
    constructor(svg, opts) {
      this.svg = svg;
      this.v = MOBILE;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.classList.add('netsim', 'msgsim');
      this.clock = new Clock();
      this.clock.onTick = () => this._frame();
      this.listeners = {};
      this.reset(opts);
    }

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    emit(ev, ...a) { (this.listeners[ev] || []).forEach(f => f(...a)); }
    start() { this.clock.start(); }
    stop() { this.clock.stop(); }
    get now() { return this.clock.now; }

    reset(opts) {
      if (opts) {
        this.o = Object.assign({}, DEFAULTS, opts);
        this.o.labels = Object.assign({}, DEFAULTS.labels, opts.labels);
      }
      this.gen = (this.gen || 0) + 1;
      this.rand = rng(this.o.seed);
      this.clock.clear();
      this.svg.innerHTML = '';
      this.gLinks = svgEl('g', {}, this.svg);
      this.gNodes = svgEl('g', {}, this.svg);
      this.gMsg = svgEl('g', {}, this.svg);
      this.gTop = svgEl('g', {}, this.svg);
      this.c = { sent: 0, accepted: 0, rejected: 0, done: 0, dup: 0, dlq: 0 };
      this.sentLog = []; this.doneLog = []; this.respLog = [];
      this.queue = []; this.flying = new Set(); this.seq = 0;
      this.crashPending = false; this.arrTimer = null;
      this.workers = [];
      this.subs = []; this.pub = {}; this.paused = false;
      this._build();
      this._scheduleArrival();
      this._frame();
      this.emit('reset');
    }

    /* ---------- topología y dibujo ---------- */

    get events() { return this.o.mode === 'direct' || this.o.mode === 'pubsub'; }

    _build() {
      if (this.events) { this._buildEvents(); return; }
      const L = this.o.labels, v = this.v, sync = this.o.mode === 'sync';
      this.prod = v ? { x: W / 2, y: 46, hw: 92, hh: 28 } : { x: 105, y: H / 2, hw: 78, hh: 36 };
      this._box(this.prod, 'prod', L.producer, L.producerSub);
      if (sync) {
        this.svc = v ? { x: W / 2, y: 290, hw: 150, hh: 70 } : { x: 600, y: H / 2, hw: 170, hh: 90 };
        this._box(this.svc, 'srv', L.service, L.serviceSub, true);
        this.svc.slotsG = svgEl('g', {}, this.svc.g);
        this._link(this.prod, this.svc);
        this.slots = Array.from({ length: this.o.slots }, () => null);
      } else {
        this.q = v ? { x: W / 2, y: 170, hw: 180, hh: 30 } : { x: 400, y: H / 2, hw: 150, hh: 38 };
        this._box(this.q, 'queue', L.queue, '', true);
        this.q.cells = svgEl('g', {}, this.q.g);
        this.q.count = svgEl('text', { class: 't-info', 'text-anchor': v ? 'end' : 'middle' }, this.q.g);
        this.q.count.setAttribute('x', v ? this.q.hw : 0);
        this.q.count.setAttribute('y', v ? -this.q.hh - 10 : this.q.hh + 24);
        this.dlqN = v ? { x: W - 52, y: 236, hw: 44, hh: 16 } : { x: 400, y: H / 2 + 120, hw: 70, hh: 22 };
        this._box(this.dlqN, 'dlq', '☠ DLQ', '', true);
        this.dlqN.g.style.display = 'none';
        this.dlqN.txt = this.dlqN.title;
        this._link(this.prod, this.q);
        for (let i = 0; i < this.o.workers; i++) this._addWorker(false);
        this._layoutWorkers(false);
      }
    }

    _box(n, cls, title, sub, noEmojiPad) {
      n.g = svgEl('g', { class: cls, transform: `translate(${n.x},${n.y})` }, this.gNodes);
      n.box = svgEl('rect', { class: 'node-box', x: -n.hw, y: -n.hh, width: n.hw * 2, height: n.hh * 2, rx: 10 }, n.g);
      const top = cls === 'queue' || cls === 'srv' && this.o.mode === 'sync';
      const ty = top ? -n.hh + 22 : sub ? -2 : 6;
      n.title = svgEl('text', { x: top ? -n.hw + 12 : 0, y: ty, class: 't-title', 'text-anchor': top ? 'start' : 'middle' }, n.g);
      n.title.textContent = title;
      if (cls === 'queue') { n.title.setAttribute('y', -n.hh - 10); n.title.setAttribute('x', -n.hw); }
      if (cls === 'dlq') { n.title.setAttribute('class', 't-info'); n.title.setAttribute('y', 5); }
      if (sub) {
        n.sub = svgEl('text', { x: top ? -n.hw + 12 : 0, y: ty + 17, class: 't-sub', 'text-anchor': top ? 'start' : 'middle' }, n.g);
        n.sub.textContent = sub;
      }
      return n;
    }

    _link(a, b) {
      const l = { a, b, el: svgEl('path', { class: 'link' }, this.gLinks) };
      (this.links = this.links || []).push(l);
      return l;
    }

    _addWorker(fresh) {
      const w = { x: 0, y: 0, hw: 80, hh: 26, up: true, busy: null, removing: false, downUntil: 0, n: 0, scale: fresh ? 0 : 1 };
      w.g = svgEl('g', { class: 'srv worker' }, this.gNodes);
      w.inner = svgEl('g', {}, w.g);
      w.box = svgEl('rect', { class: 'node-box', rx: 9 }, w.inner);
      w.title = svgEl('text', { class: 't-title small' }, w.inner);
      w.sub = svgEl('text', { class: 't-sub' }, w.inner);
      w.barBg = svgEl('rect', { class: 'bar-bg', rx: 2.5, height: 5 }, w.inner);
      w.bar = svgEl('rect', { class: 'prog', rx: 2.5, height: 5 }, w.inner);
      w.link = this._link(this.q, w);
      if (this.o.clickWorkers) {
        w.g.classList.add('clickable');
        w.g.addEventListener('click', () => this.toggleWorker(w));
      }
      this.workers.push(w);
      return w;
    }

    _layoutWorkers(animate) {
      const ws = this.workers, m = ws.length;
      ws.forEach((w, i) => {
        let x, y, hw, hh;
        if (this.v) {
          hw = Math.min(64, W / m / 2 - 5); hh = 28;
          x = W * (i + 0.5) / m; y = 330;
        } else {
          const gap = Math.min(96, (H - 130) / m);
          hw = 82; hh = Math.min(28, gap / 2 - 5);
          x = 760; y = H / 2 + (i - (m - 1) / 2) * gap;
        }
        const t = { x, y, hw, hh };
        if (w.scale === 0) { Object.assign(w, t); gsap.to(w, { scale: 1, duration: 0.45, ease: 'back.out(1.7)' }); }
        else if (animate) gsap.to(w, Object.assign({ duration: 0.45, ease: 'power2.inOut' }, t));
        else Object.assign(w, t);
      });
    }

    /* ---------- llegadas ---------- */

    _interval() {
      const r = this.o.rate;
      if (this.o.arrival === 'uniform') return 1 / r;
      return -Math.log(1 - this.rand()) / r;
    }

    _scheduleArrival() {
      if (this.arrTimer) this.clock.cancel(this.arrTimer);
      if (this.o.rate <= 0) { this.arrTimer = this.clock.after(0.25, () => this._scheduleArrival()); return; }
      this.arrTimer = this.clock.after(this._interval(), () => { this._send(); this._scheduleArrival(); });
    }

    setRate(r) { this.o.rate = r; this._scheduleArrival(); }

    burst(n, secs) {
      for (let i = 0; i < n; i++) this.clock.after((secs * i) / n, () => this._send());
    }

    sendPoison() { this._send({ poison: true }); }
    crashBeforeAck() { this.crashPending = true; }

    _send(extra) {
      if (this.events) { if (!this.paused) this._sendEvent(); return; }
      const m = Object.assign({ id: ++this.seq, poison: false, tries: 0, redo: false, tt: 0 }, extra);
      this.c.sent++;
      this.sentLog.push(this.now);
      this.flying.add(m);
      const to = this.o.mode === 'sync' ? this.svc : this.q;
      this._fly(m, this.prod, to, m.poison ? POISON : C.req, () => {
        m.t0 = this.now;
        if (this.o.mode === 'sync') this._arriveSync(m); else this._enqueue(m);
      });
    }

    // Animación de un punto de a → b; al llegar llama a done (si no hubo reset)
    _fly(m, a, b, color, done, dur) {
      const gen = this.gen;
      const el = svgEl('circle', { r: 6, fill: color, class: 'pk msg' }, this.gMsg);
      const d = dur || this.o.travel;
      this.clock.animate(d, p => {
        const P = cubic(edge(a, b, this.v), edge(b, a, this.v), p, this.v);
        el.setAttribute('cx', P.x); el.setAttribute('cy', P.y);
      }, () => { el.remove(); if (gen === this.gen) done(); });
      return d;
    }

    _pop(n, text, color, dy) {
      if (this.o.pops) pop(this.gTop, n.x, n.y - n.hh - 8 + (dy || 0), text, color);
    }

    /* ---------- sincrónico ---------- */

    _arriveSync(m) {
      const i = this.slots.indexOf(null);
      if (i < 0) {
        this.flying.delete(m);
        this.c.rejected++;
        this._pop(this.svc, '503', C.err);
        return;
      }
      this.slots[i] = m;
      m.dur = this._workTime();
      m.start = this.now;
      this.clock.after(m.dur, () => {
        this.slots[i] = null;
        this.flying.delete(m);
        this.c.done++;
        const lat = this.now - m.t0;
        this.respLog.push([this.now, lat]); this.doneLog.push([this.now, lat]);
        this._fly({}, this.svc, this.prod, C.ok, () => {}, this.o.travel * 0.8);
      });
    }

    _workTime() {
      const j = this.o.workJitter;
      return this.o.workTime * (1 - j + 2 * j * this.rand());
    }

    /* ---------- cola ---------- */

    _enqueue(m, front) {
      this.flying.delete(m);
      if (front) this.queue.unshift(m); else this.queue.push(m);
      if (!m.accepted) {
        m.accepted = true;
        this.c.accepted++;
        this.respLog.push([this.now, 0]);
        this._pop(this.q, '202', C.req, 0);
      }
      this._dispatch();
    }

    _dispatch() {
      for (const w of this.workers) {
        if (!this.queue.length) return;
        if (!w.up || w.busy || w.removing) continue;
        const m = this.queue.shift();
        w.busy = m;
        this.flying.add(m);
        const token = m.token = (m.token || 0) + 1;
        m.tt += this._fly(m, this.q, w, m.poison ? POISON : m.redo ? REDO : C.req, () => this._startWork(w, m, token), this.o.travel * 0.75);
      }
    }

    _startWork(w, m, token) {
      if (m.token !== token) return;
      if (!w.up || w.busy !== m) { this._requeue(m, w); return; }
      // el viaje desde la cola cuenta dentro del tiempo de trabajo: capacidad = workers / workTime
      m.dur = Math.max(0.05, this._workTime() - this.o.travel * 0.75);
      m.start = this.now;
      m.timer = this.clock.after(m.dur, () => this._finish(w, m, token));
    }

    // Devuelve el mensaje al frente de la cola (el worker no confirmó)
    _requeue(m, w) {
      if (w && w.busy === m) w.busy = null;
      m.token++;
      if (m.timer) { this.clock.cancel(m.timer); m.timer = null; }
      this._enqueue(m, true);
    }

    _finish(w, m, token) {
      if (m.token !== token || w.busy !== m) return;
      m.timer = null;
      if (m.poison) {
        m.tries++;
        w.busy = null;
        if (m.tries > this.o.maxRetries) {
          this._pop(w, '✗', C.err);
          m.tt += this._fly(m, w, this.dlqN, POISON, () => {
            this.flying.delete(m);
            this.c.dlq++;
            this.dlqN.g.style.display = '';
            this._pop(this.dlqN, '☠ DLQ', C.err);
          });
        } else {
          this._pop(w, `✗ reintento ${m.tries}`, C.err);
          this.flying.delete(m);
          this._enqueue(m);
        }
        this._afterFree(w);
        return;
      }
      if (this.crashPending) {
        // hizo el trabajo pero se cae antes de confirmar: el mensaje vuelve y se procesa otra vez
        this.crashPending = false;
        m.redo = true;
        w.busy = null;
        this._pop(w, '💥 sin ack', C.err);
        this.flying.delete(m);
        this._enqueue(m, true);
        this._down(w, 1.5);
        return;
      }
      w.busy = null;
      w.n++;
      this.flying.delete(m);
      this.c.done++;
      if (m.redo) { this.c.dup++; this._pop(w, '↺ duplicado', REDO); }
      else this._pop(w, '✔', C.ok);
      this.doneLog.push([this.now, this.now - m.t0 - m.tt]);
      this._afterFree(w);
    }

    _afterFree(w) {
      if (w.removing) this._dropWorker(w);
      this._dispatch();
    }

    _down(w, secs) {
      w.up = false;
      w.crashed = true;
      this.clock.after(secs, () => { w.crashed = false; if (!w.off) { w.up = true; this._dispatch(); } });
    }

    /* ---------- workers ---------- */

    get activeWorkers() { return this.workers.filter(w => !w.removing).length; }

    addWorker() {
      if (this.o.mode === 'sync' || this.activeWorkers >= this.o.maxWorkers) return;
      const w = this._addWorker(true);
      if (this.workers.some(x => x.off)) { w.off = true; w.up = false; }
      this.o.workers = this.activeWorkers;
      this._layoutWorkers(true);
      this._dispatch();
    }

    removeWorker() {
      if (this.o.mode === 'sync') return;
      const live = this.workers.filter(w => !w.removing);
      if (live.length <= 1) return;
      const w = live.slice().reverse().find(x => !x.busy) || live[live.length - 1];
      w.removing = true;
      this.o.workers = this.activeWorkers;
      if (!w.busy) this._dropWorker(w);
    }

    _dropWorker(w) {
      this.workers = this.workers.filter(x => x !== w);
      this.links = this.links.filter(l => l !== w.link);
      w.link.el.remove();
      gsap.to(w, { scale: 0, duration: 0.3, onComplete: () => w.g.remove() });
      this._layoutWorkers(true);
    }

    setWorkersUp(up) { this.workers.forEach(w => this._setUp(w, up)); this._dispatch(); }
    toggleWorker(w) { this._setUp(w, !w.up && !w.crashed ? true : w.off); this._dispatch(); }

    _setUp(w, up) {
      w.off = !up;
      if (up) { if (!w.crashed) w.up = true; return; }
      w.up = false;
      if (w.busy) {
        const m = w.busy;
        w.busy = null;
        // se apagó a mitad del trabajo: sin confirmación, el mensaje vuelve a la cola
        this.flying.delete(m);
        m.token++;
        if (m.timer) { this.clock.cancel(m.timer); m.timer = null; }
        this._enqueue(m, true);
      }
    }

    /* ---------- métricas ---------- */

    window(sec) {
      const t0 = this.now - sec;
      const inW = arr => arr.filter(e => e[0] >= t0).map(e => e[1]);
      const resp = inW(this.respLog), done = inW(this.doneLog);
      if (this.events) return Object.assign({}, this.c, {
        respP50: quant(resp, 0.5), respP95: quant(resp, 0.95), queueLen: 0, inFlight: 0,
        inRate: this.sentLog.filter(t => t >= t0).length / sec, outRate: 0
      });
      return Object.assign({}, this.c, {
        queueLen: this.queue.length,
        inFlight: this.flying.size,
        respP50: quant(resp, 0.5), respP95: quant(resp, 0.95),
        doneP50: quant(done, 0.5), doneP95: quant(done, 0.95),
        inRate: this.sentLog.filter(t => t >= t0).length / sec,
        outRate: done.length / sec
      });
    }

    // Avanza el tiempo de simulación sin depender de la velocidad global (para pruebas)
    fastForward(sec) {
      const sp = Speed.value;
      Speed.value = 1;
      try { for (let i = 0, n = Math.round(sec / 0.05); i < n; i++) this.clock._tick(0, 50); }
      finally { Speed.value = sp; }
    }

    /* ---------- render por frame ---------- */

    _frame() {
      // recortar logs viejos
      const old = this.now - 120;
      if (this.sentLog.length > 4000) this.sentLog = this.sentLog.filter(t => t >= old);
      if (this.doneLog.length > 4000) this.doneLog = this.doneLog.filter(e => e[0] >= old);
      if (this.respLog.length > 4000) this.respLog = this.respLog.filter(e => e[0] >= old);

      for (const l of this.links) l.el.setAttribute('d', curve(edge(l.a, l.b, this.v), edge(l.b, l.a, this.v), this.v));
      if (this.events) this._drawEvents();
      else if (this.o.mode === 'sync') this._drawSlots(); else { this._drawQueue(); this.workers.forEach(w => this._drawWorker(w)); }
      this.emit('tick', this.now);
    }

    _drawSlots() {
      const s = this.svc, n = this.slots.length, g = s.slotsG;
      const sw = Math.min(76, (s.hw * 2 - 30) / n - 8), sh = 48;
      const sig = this.slots.map(m => (m ? 1 : 0)).join('');
      if (g._sig !== sig || !g.childNodes.length) {
        g._sig = sig;
        g.innerHTML = '';
        this.slots.forEach((m, i) => {
          const x = -((n * (sw + 8)) - 8) / 2 + i * (sw + 8);
          const cell = svgEl('g', { transform: `translate(${x},${-sh / 2 + 16})` }, g);
          svgEl('rect', { class: 'slot' + (m ? ' busy' : ''), width: sw, height: sh, rx: 6 }, cell);
          svgEl('rect', { class: 'bar-bg', x: 6, y: sh - 10, width: sw - 12, height: 5, rx: 2.5 }, cell);
          svgEl('rect', { class: 'prog', x: 6, y: sh - 10, width: 0, height: 5, rx: 2.5 }, cell);
        });
      }
      this.slots.forEach((m, i) => {
        const bar = g.childNodes[i] && g.childNodes[i].childNodes[2];
        if (bar) bar.setAttribute('width', m && m.start != null ? Math.min(1, (this.now - m.start) / m.dur) * (sw - 12) : 0);
      });
      const busy = this.slots.filter(Boolean).length;
      s.title.textContent = `${this.o.labels.service} · ${busy}/${n} ocupados`;
      if (this.prod.sub) this.prod.sub.textContent = busy ? `⏳ ${busy} esperando` : this.o.labels.producerSub;
    }

    _drawQueue() {
      const q = this.q, g = q.cells, MAXC = this.v ? 14 : 12;
      const n = this.queue.length;
      const sig = this.queue.slice(0, MAXC).map(m => (m.poison ? 'p' : m.redo ? 'r' : 'n')).join('') + n;
      if (g._sig !== sig) {
        g._sig = sig;
        g.innerHTML = '';
        const cw = 18, gap = 4;
        // la cabeza de la cola (próximo a salir) va del lado de los workers
        this.queue.slice(0, MAXC).forEach((m, i) => {
          const x = this.v ? -q.hw + 10 + i * (cw + gap) : q.hw - 10 - cw - i * (cw + gap);
          svgEl('rect', {
            class: 'msg q', x, y: -cw / 2 + (this.v ? 0 : 8), width: cw, height: cw, rx: 4,
            fill: m.poison ? POISON : m.redo ? REDO : ORANGE
          }, g);
        });
        q.count.textContent = n > MAXC ? `${n} mensajes (+${n - MAXC})` : `${n} mensaje${n === 1 ? '' : 's'}`;
        q.box.classList.toggle('full', n > MAXC);
      }
      if (this.c.dlq) this.dlqN.txt.textContent = `☠ DLQ · ${this.c.dlq}`;
    }

    _drawWorker(w) {
      w.g.setAttribute('transform', `translate(${w.x},${w.y}) scale(${w.scale})`);
      w.g.classList.toggle('down', !w.up);
      w.box.setAttribute('x', -w.hw); w.box.setAttribute('y', -w.hh);
      w.box.setAttribute('width', w.hw * 2); w.box.setAttribute('height', w.hh * 2);
      const narrow = w.hw < 70;
      w.title.setAttribute('x', narrow ? 0 : -w.hw + 12); w.title.setAttribute('y', narrow ? -5 : -3);
      w.title.setAttribute('text-anchor', narrow ? 'middle' : 'start');
      w.sub.setAttribute('x', narrow ? 0 : -w.hw + 12); w.sub.setAttribute('y', narrow ? 10 : 13);
      w.sub.setAttribute('text-anchor', narrow ? 'middle' : 'start');
      const i = this.workers.indexOf(w) + 1;
      w.title.textContent = narrow ? `W${i}` : `${this.o.labels.worker} ${i}`;
      w.sub.textContent = !w.up ? (w.crashed ? 'caído' : 'apagado') : w.busy ? 'procesando' : narrow ? `✓ ${w.n}` : `libre · ✓ ${w.n}`;
      const bw = w.hw * 2 - 20;
      w.barBg.setAttribute('x', -w.hw + 10); w.barBg.setAttribute('y', w.hh - 9); w.barBg.setAttribute('width', bw);
      w.bar.setAttribute('x', -w.hw + 10); w.bar.setAttribute('y', w.hh - 9);
      const m = w.busy;
      w.bar.setAttribute('width', m && m.start != null && m.timer ? Math.min(1, (this.now - m.start) / m.dur) * bw : 0);
    }
  }

  /* ================= eventos: 'direct' y 'pubsub' ================= */
  // direct: Órdenes llama en serie a cada servicio y espera; si uno no responde, la orden falla.
  // pubsub: Órdenes publica un evento en el broker; el broker deja una copia en la cola de cada suscriptor.

  const EV_COLORS = { OrdenCreada: '#7dd3fc', FacturaEmitida: '#a78bfa' };
  const CELL_COLORS = { OrdenCreada: ORANGE, FacturaEmitida: '#a78bfa' };
  const DEFAULT_SUBS = [
    { id: 'facturacion', label: 'Facturación', icon: '🧾', workTime: 0.8, workers: 1, listens: ['OrdenCreada'] },
    { id: 'stock', label: 'Stock', icon: '📦', workTime: 0.5, workers: 1, listens: ['OrdenCreada'] },
    { id: 'mails', label: 'Mails', icon: '✉️', workTime: 0.6, workers: 1, listens: ['OrdenCreada'] },
    { id: 'analytics', label: 'Analytics', icon: '📊', workTime: 0.4, workers: 1, listens: ['OrdenCreada'] }
  ];
  Object.assign(DEFAULTS, { event: 'OrdenCreada', maxSubscribers: 5, subscribers: null, client: false });

  Object.assign(MsgSim.prototype, {
    _buildEvents() {
      const v = this.v, L = this.o.labels, cl = this.o.client;
      if (cl) {
        // el cliente le pide la orden a Órdenes y espera su respuesta
        this.client = v ? { x: W / 2, y: 30, hw: 80, hh: 22 } : { x: 70, y: H / 2, hw: 56, hh: 32 };
        this._box(this.client, 'client', '👤 Cliente', 'navegador');
        this.client.g.style.setProperty('--c', C.req);
        this.prod = v ? { x: W / 2, y: 110, hw: 96, hh: 24 } : { x: 215, y: H / 2, hw: 64, hh: 36 };
      } else this.prod = v ? { x: W / 2, y: 40, hw: 96, hh: 26 } : { x: 100, y: H / 2, hw: 74, hh: 36 };
      this._box(this.prod, 'prod', L.producer === DEFAULTS.labels.producer ? '🛒 Órdenes' : L.producer, this.o.mode === 'direct' ? 'servicio' : 'productor');
      if (cl) this._link(this.client, this.prod);
      if (this.o.mode === 'pubsub') {
        this.broker = cl
          ? { x: v ? W / 2 : 430, y: v ? 205 : H / 2, hw: v ? 188 : 130, hh: v ? 62 : 200 }
          : { x: v ? W / 2 : 400, y: v ? 160 : H / 2, hw: v ? 188 : 150, hh: v ? 62 : 200 };
        this._box(this.broker, 'queue broker', 'Broker', '', true);
        this.broker.title.setAttribute('text-anchor', 'start');
        this.broker.cells = svgEl('g', {}, this.broker.g);
        this._link(this.prod, this.broker);
      }
      (this.o.subscribers || DEFAULT_SUBS).forEach(x => this._addSub(x, false));
      this._layoutSubs(false);
      this._banner = null;
    },

    _addSub(def, fresh) {
      const sb = Object.assign({ workers: 1, listens: [this.o.event] }, def, {
        queue: [], busy: [], up: true, done: 0, received: 0, scale: fresh ? 0 : 1, hw: 80, hh: 30, x: 0, y: 0
      });
      sb.g = svgEl('g', { class: 'srv sub clickable' }, this.gNodes);
      sb.inner = svgEl('g', {}, sb.g);
      sb.box = svgEl('rect', { class: 'node-box', rx: 9 }, sb.inner);
      sb.title = svgEl('text', { class: 't-title small' }, sb.inner);
      sb.sub = svgEl('text', { class: 't-sub' }, sb.inner);
      sb.g.addEventListener('click', () => this.setSubscriberUp(sb.id, !sb.up));
      if (this.broker) {
        sb.lane = { x: 0, y: 0, hw: 0, hh: 0 };
        sb.link = this._link(sb.lane, sb);
      } else sb.link = this._link(this.prod, sb);
      this.subs.push(sb);
      return sb;
    },

    _layoutSubs(animate) {
      const n = this.subs.length, v = this.v, b = this.broker;
      this.subs.forEach((sb, i) => {
        let t;
        if (v) {
          const rows = n > 4 ? 2 : 1, per = rows === 2 ? 3 : n;
          const row = Math.floor(i / per), col = i % per;
          const inRow = row === rows - 1 ? n - per * (rows - 1) : per;
          // con dos filas, la segunda va en los huecos de la primera para que sus líneas no crucen cajas
          const x = rows === 2 && row === 1 && inRow < per ? W * (col + 1) / (inRow + 1) : W * (col + 0.5) / inRow;
          t = { x, y: rows === 1 ? 340 : row === 0 ? 300 : 392, hw: Math.min(rows === 2 ? 52 : 64, W / inRow / 2 - 4), hh: rows === 1 ? 32 : 26 };
        } else {
          const gap = Math.min(112, (H - 110) / n);
          t = { x: 770, y: H / 2 + (i - (n - 1) / 2) * gap, hw: 92, hh: Math.min(32, gap / 2 - 6) };
        }
        if (sb.scale === 0) { Object.assign(sb, t); gsap.to(sb, { scale: 1, duration: 0.45, ease: 'back.out(1.7)' }); }
        else if (animate) gsap.to(sb, Object.assign({ duration: 0.45, ease: 'power2.inOut' }, t));
        else Object.assign(sb, t);
      });
    },

    sub(id) {
      const sb = this.subs.find(x => x.id === id);
      if (!sb) return null;
      return { queueLen: sb.queue.length, done: sb.done, up: sb.up, workers: sb.workers, received: sb.received, lag: sb.received - sb.done };
    },

    published(type) { return this.pub[type] || 0; },
    publish() { this._sendEvent(); },

    _sendEvent() {
      this.c.sent++;
      this.sentLog.push(this.now);
      if (this.client) this._fly({}, this.client, this.prod, C.req, () => this._handleOrder());
      else this._handleOrder();
    },

    // Órdenes le contesta al cliente (si lo hay)
    _reply(code, color) {
      if (this.client) this._fly({}, this.prod, this.client, color, () => this._pop(this.client, code, color));
      else this._pop(this.prod, code, color);
    },

    _handleOrder() {
      if (this.o.mode === 'pubsub') {
        this._fly({}, this.prod, this.broker, EV_COLORS[this.o.event], () => {
          this.c.accepted++;
          this.respLog.push([this.now, 0]);
          this._publish(this.o.event);
          // apenas el broker la acepta, Órdenes ya puede contestar
          if (this.client) this._fly({}, this.broker, this.prod, C.ok, () => this._reply('200', C.ok), this.o.travel * 0.6);
        });
        return;
      }
      // direct: llamadas en serie, cada una espera la respuesta
      this.pub[this.o.event] = (this.pub[this.o.event] || 0) + 1;
      const targets = this.subs.filter(x => x.listens.includes(this.o.event));
      const tr = this.o.travel * 0.6;
      let spent = 0;
      const next = i => {
        if (i >= targets.length) {
          this.c.done++;
          this.respLog.push([this.now, spent]);
          this._reply('200', C.ok);
          return;
        }
        const sb = targets[i];
        this._fly({}, this.prod, sb, C.req, () => {
          if (!sb.up) {
            // nadie atiende: a Órdenes le falla la conexión y le contesta 503 al cliente
            this._pop(sb, '✕ conexión', C.err);
            this._fly({}, sb, this.prod, C.err, () => {
              this.c.rejected++;
              this.respLog.push([this.now, spent]);
              this._reply('503', C.err);
            }, tr);
            return;
          }
          const d = this._workTime(sb.workTime);
          sb.busy.push(1);
          this.clock.after(d, () => {
            sb.busy.pop();
            sb.done++; sb.received++;
            spent += d;
            this._fly({}, sb, this.prod, C.ok, () => next(i + 1), tr);
          });
        }, tr);
      };
      next(0);
    },

    _publish(type) {
      this.pub[type] = (this.pub[type] || 0) + 1;
      this.subs.filter(x => x.listens.includes(type)).forEach(sb => {
        sb.received++;
        sb.queue.push({ type, t0: this.now });
        this._dispatchSub(sb);
      });
    },

    _dispatchSub(sb) {
      while (sb.up && sb.busy.length < sb.workers && sb.queue.length) {
        const m = sb.queue.shift();
        sb.busy.push(m);
        const tok = m.tok = (m.tok || 0) + 1;
        const tr = this.o.travel * 0.6;
        this._fly({}, sb.lane, sb, EV_COLORS[m.type], () => {
          if (m.tok !== tok) return;
          m.start = this.now;
          m.dur = Math.max(0.05, this._workTime(sb.workTime) - tr);
          m.timer = this.clock.after(m.dur, () => {
            if (m.tok !== tok) return;
            sb.busy = sb.busy.filter(x => x !== m);
            sb.done++;
            this._pop(sb, '✔', C.ok, 4);
            if (sb.emits) this._fly({}, sb, this.broker, EV_COLORS[sb.emits], () => this._publish(sb.emits));
            this._dispatchSub(sb);
          });
        }, tr);
      }
    },

    setSubscriberUp(id, up) {
      const sb = this.subs.find(x => x.id === id);
      if (!sb) return;
      sb.up = up;
      if (!up) {
        // lo que estaba procesando no se confirmó: vuelve a su cola
        sb.busy.slice().reverse().forEach(m => {
          if (m === 1) return;
          m.tok++;
          if (m.timer) this.clock.cancel(m.timer);
          sb.queue.unshift(m);
        });
        if (this.broker) sb.busy = [];
      } else if (this.broker) this._dispatchSub(sb);
    },

    setSubscriberWorkers(id, n) {
      const sb = this.subs.find(x => x.id === id);
      if (!sb) return;
      sb.workers = Math.max(1, Math.min(4, n));
      this._dispatchSub(sb);
    },

    addSubscriber(def) {
      if (this.subs.length >= this.o.maxSubscribers || this.subs.some(x => x.id === def.id)) return false;
      this._addSub(def, true);
      this._layoutSubs(true);
      if (this.o.mode === 'direct') {
        // sin broker, sumar un servicio es cambiar el código de Órdenes
        this.paused = true;
        this.banner('🔧 Hay que cambiar y redesplegar Órdenes', C.slow);
        this.clock.after(2, () => { this.paused = false; this.banner(null); });
      }
      return true;
    },

    banner(text, color) {
      if (this._banner) { this._banner.remove(); this._banner = null; }
      if (!text) return;
      const g = svgEl('g', { class: 'banner' }, this.gTop);
      // en celular va entre el productor y los servicios, para no tapar las cajas
      const y = this.v ? 175 : 40, w = this.v ? 360 : 440;
      svgEl('rect', { x: W / 2 - w / 2, y: y - 20, width: w, height: 36, rx: 10, stroke: color }, g);
      const t = svgEl('text', { x: W / 2, y: y + 4, 'text-anchor': 'middle', fill: color }, g);
      t.textContent = text;
      this._banner = g;
    },

    _drawEvents() {
      const b = this.broker, v = this.v;
      if (b && !v && this.subs.length) {
        // el broker abarca todos los carriles
        const ys = this.subs.map(sb => sb.y);
        b.hh = (Math.max(...ys) - Math.min(...ys)) / 2 + 30;
        b.y = (Math.max(...ys) + Math.min(...ys)) / 2;
        b.g.setAttribute('transform', `translate(${b.x},${b.y})`);
        b.box.setAttribute('y', -b.hh); b.box.setAttribute('height', b.hh * 2);
        b.title.setAttribute('y', -b.hh - 10);
        b.title.setAttribute('x', -b.hw);
      }
      if (b && v) { b.title.setAttribute('y', -b.hh - 8); b.title.setAttribute('x', -b.hw); }
      if (b) {
        // un carril por suscriptor dentro del broker, con su cola
        const sig = this.subs.map(sb => `${sb.x|0},${sb.y|0}:` + sb.queue.slice(0, 8).map(m => m.type[0]).join('') + sb.queue.length).join('|');
        this.subs.forEach(sb => {
          Object.assign(sb.lane, v ? { x: sb.x, y: b.y + b.hh } : { x: b.x + b.hw, y: sb.y });
        });
        if (b.cells._sig !== sig) {
          b.cells._sig = sig;
          b.cells.innerHTML = '';
          const cw = 16, gap = 4;
          this.subs.forEach(sb => {
            const max = v ? 4 : 8;
            const ly = v ? 0 : sb.y - b.y;
            const lx = v ? sb.x - b.x : 0;
            if (!v) svgEl('rect', { class: 'lane', x: -b.hw + 12, y: ly - 14, width: b.hw * 2 - 24, height: 28, rx: 6 }, b.cells);
            else svgEl('rect', { class: 'lane', x: lx - 15, y: -b.hh + 30, width: 30, height: b.hh * 2 - 36, rx: 6 }, b.cells);
            sb.queue.slice(0, max).forEach((m, i) => {
              const x = v ? lx - cw / 2 : b.hw - 18 - cw - i * (cw + gap);
              const y = v ? b.hh - 12 - cw - i * (cw + gap) : ly - cw / 2;
              svgEl('rect', { class: 'msg q', x, y, width: cw, height: cw, rx: 4, fill: CELL_COLORS[m.type] || ORANGE }, b.cells);
            });
            if (sb.queue.length > max || !v && sb.queue.length) {
              const t = svgEl('text', { class: 't-info', x: v ? lx : -b.hw + 22, y: v ? -b.hh + 46 : ly + 5, 'text-anchor': v ? 'middle' : 'start' }, b.cells);
              t.textContent = v ? `${sb.queue.length}` : `${sb.queue.length}`;
            }
          });
        }
      }
      this.subs.forEach(sb => {
        sb.g.setAttribute('transform', `translate(${sb.x},${sb.y}) scale(${sb.scale})`);
        sb.g.classList.toggle('down', !sb.up);
        sb.box.setAttribute('x', -sb.hw); sb.box.setAttribute('y', -sb.hh);
        sb.box.setAttribute('width', sb.hw * 2); sb.box.setAttribute('height', sb.hh * 2);
        const narrow = sb.hw < 70;
        sb.title.setAttribute('x', narrow ? 0 : -sb.hw + 12); sb.title.setAttribute('y', narrow ? -4 : -3);
        sb.title.setAttribute('text-anchor', narrow ? 'middle' : 'start');
        sb.sub.setAttribute('x', narrow ? 0 : -sb.hw + 12); sb.sub.setAttribute('y', narrow ? 12 : 14);
        sb.sub.setAttribute('text-anchor', narrow ? 'middle' : 'start');
        sb.title.textContent = narrow ? `${sb.icon} ${sb.label.length > 7 ? sb.label.slice(0, 6) + '.' : sb.label}` : `${sb.icon} ${sb.label}${sb.workers > 1 ? ` ×${sb.workers}` : ''}`;
        const lag = sb.received - sb.done;
        sb.sub.textContent = !sb.up ? 'caído' : narrow ? `✓ ${sb.done}${sb.workers > 1 ? ` ×${sb.workers}` : ''}` : `✓ ${sb.done}${b ? ` · atraso ${lag}` : sb.busy.length ? ' · procesando' : ''}`;
      });
    }
  });

  // _workTime con un tiempo base propio (suscriptores)
  const baseWork = MsgSim.prototype._workTime;
  MsgSim.prototype._workTime = function (t) {
    if (t == null) return baseWork.call(this);
    const j = this.o.workJitter;
    return t * (1 - j + 2 * j * this.rand());
  };

  window.MsgKit = { MsgSim, rng, DEFAULT_SUBS, EV_COLORS };
})();
