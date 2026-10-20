/* Una función por slide interactiva. Cada una recibe el <section> y devuelve { start, stop }.
   main.js las crea la primera vez que se visita la slide y las pausa al salir.
   Para una slide nueva: <section data-scene="nombre"> en index.html + S.nombre = slide => { … } acá. */
(function () {
  'use strict';

  const { Sim, Clock, svgEl, cubic, curve, edge, pop, C } = window.NetKit;
  const S = {};

  /* ---------- helpers ---------- */

  // Crea la Sim sobre <svg class="sim"> y conecta los widgets que haya en la slide:
  // .stats (data-fields, data-window), .strip, canvas.chart, canvas.histo
  function setup(slide, opts) {
    const sim = new Sim(slide.querySelector('svg.sim'), opts);
    const st = slide.querySelector('.stats');
    if (st) Widgets.stats(st, sim, st.dataset.fields ? st.dataset.fields.split(',') : null, +(st.dataset.window || 5));
    const strip = slide.querySelector('.strip');
    if (strip) Widgets.strip(strip, sim);
    const cv = slide.querySelector('canvas.chart');
    if (cv) Widgets.chart(cv, sim);
    const hist = slide.querySelector('canvas.histo');
    if (hist) Widgets.histogram(hist, sim);
    return sim;
  }

  function on(slide, sel, fn) {
    slide.querySelectorAll(sel).forEach(b => b.addEventListener('click', e => { fn(b, e); b.blur(); }));
  }

  // Control segmentado: <div class="seg" data-group="x"><button data-v="a">…
  function seg(slide, group, fn) {
    const root = slide.querySelector(`.seg[data-group="${group}"]`);
    root.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      root.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      b.blur();
      fn(b.dataset.v);
    }));
  }

  // Muestra solo los elementos [data-mode] que coinciden
  function showMode(slide, mode) {
    slide.querySelectorAll('[data-mode]').forEach(el => { el.hidden = el.dataset.mode !== mode; });
  }

  const life = sim => ({ start: () => sim.start(), stop: () => sim.stop(), sim });

  // Crea un MsgSim sobre <svg class="sim"> y conecta .mstats y canvas.qchart si existen
  function msetup(slide, opts) {
    const sim = new MsgKit.MsgSim(slide.querySelector('svg.sim'), opts);
    const st = slide.querySelector('.mstats');
    if (st) Widgets.mstats(st, sim, st.dataset.fields.split(','), +(st.dataset.window || 5));
    const qc = slide.querySelector('canvas.qchart');
    if (qc && Widgets.qchart) Widgets.qchart(qc, sim);
    return sim;
  }

  const fmtRate = r => `${String(r).replace('.', ',')} /s`;

  const FRAUDE = { id: 'fraude', label: 'Fraude', icon: '🛡', workTime: 0.5, workers: 1, listens: ['OrdenCreada'] };

  // Escena de eventos: ＋ Fraude, reset y clic en los servicios (lo maneja el motor)
  function eventScene(slide, base) {
    const sim = msetup(slide, base);
    const add = slide.querySelector('[data-act=add]');
    const sync = () => { if (add) add.disabled = !!sim.sub('fraude'); };
    on(slide, '[data-act=add]', () => { sim.addSubscriber(FRAUDE); sync(); });
    on(slide, '[data-act=reset]', () => { sim.reset(base); sync(); });
    sync();
    return sim;
  }

  /* ---------- 3. sin broker: llamadas directas en serie ---------- */

  // más lentas que el resto para poder seguir cada pedido del cliente
  S.direct = slide => life(eventScene(slide, { mode: 'direct', rate: 0.4, travel: 0.9, seed: 3, client: true }));

  /* ---------- 4. publicar y suscribirse ---------- */

  S.pubsub = slide => life(eventScene(slide, { mode: 'pubsub', rate: 0.5, travel: 0.9, seed: 4, client: true }));

  /* ---------- 1. portada: pub/sub decorativo de fondo ---------- */

  S.title = slide => life(new MsgKit.MsgSim(slide.querySelector('svg.bg'), { mode: 'pubsub', rate: 1.5, seed: 11, pops: false }));

  const SUBS = () => MsgKit.DEFAULT_SUBS.map(x => Object.assign({}, x));

  /* ---------- 5. cada uno a su ritmo: Analytics lento, réplicas adentro ---------- */

  S.pace = slide => {
    const subs = SUBS().map(x => (x.id === 'analytics' ? Object.assign(x, { workTime: 1.2 }) : x));
    const base = { mode: 'pubsub', rate: 1.5, seed: 5, subscribers: subs };
    const sim = msetup(slide, base);
    Widgets.lag(slide.querySelector('.lag'), sim, subs.map(x => x.id));
    const n = () => sim.sub('analytics').workers;
    on(slide, '[data-act=add]', () => sim.setSubscriberWorkers('analytics', n() + 1));
    on(slide, '[data-act=remove]', () => sim.setSubscriberWorkers('analytics', n() - 1));
    on(slide, '[data-act=reset]', () => sim.reset(base));
    return life(sim);
  };

  /* ---------- 6. consistencia eventual: órdenes vs. stock descontado ---------- */

  S.consistency = slide => {
    const subs = SUBS().filter(x => x.id === 'facturacion' || x.id === 'stock')
      .map(x => (x.id === 'stock' ? Object.assign(x, { workTime: 2 }) : x));
    const base = { mode: 'pubsub', rate: 0, seed: 6, subscribers: subs };
    const sim = msetup(slide, base);
    const nEl = slide.querySelector('.cnt-orders'), mEl = slide.querySelector('.cnt-stock');
    const draw = () => {
      const n = sim.published('OrdenCreada'), m = sim.sub('stock').done;
      nEl.textContent = n; mEl.textContent = m;
      mEl.classList.toggle('warn', m < n);
      mEl.classList.toggle('ok', m >= n);
    };
    sim.on('tick', draw);
    sim.on('reset', draw);
    on(slide, '[data-act=order]', () => sim.publish());
    on(slide, '[data-act=reset]', () => sim.reset(base));
    draw();
    return life(sim);
  };

  /* ---------- 7. reacciones en cadena: FacturaEmitida → Mails ---------- */

  S.chain = slide => {
    // solo acá Facturación publica FacturaEmitida, y Mails la escucha
    const subs = SUBS().map(x => (x.id === 'mails' ? Object.assign(x, { listens: ['FacturaEmitida'] }) : x.id === 'facturacion' ? Object.assign(x, { emits: 'FacturaEmitida' }) : x));
    const base = { mode: 'pubsub', rate: 0.8, seed: 7, subscribers: subs };
    const sim = msetup(slide, base);
    const btn = slide.querySelector('[data-act=toggle]');
    const label = () => { btn.textContent = sim.sub('facturacion').up ? '⏻ Apagar Facturación' : '⏻ Prender Facturación'; };
    on(slide, '[data-act=toggle]', () => { sim.setSubscriberUp('facturacion', !sim.sub('facturacion').up); label(); });
    on(slide, '[data-act=reset]', () => { sim.reset(base); label(); });
    sim.svg.addEventListener('click', () => setTimeout(label));
    return life(sim);
  };

  window.Scenes = S;
})();
