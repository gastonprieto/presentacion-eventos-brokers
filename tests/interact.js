// Pruebas de interacción con Chrome headless: motor de mensajería y escenas.
// Uso: node tests/interact.js [filtro]   (filtro = parte del nombre de la prueba)
// Requiere `npm i` en presentaciones-guideline/tools (usa su puppeteer-core).
const path = require('path');
const puppeteer = require(path.resolve(__dirname, '../../presentaciones-guideline/tools/node_modules/puppeteer-core'));

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const filter = process.argv[2] || '';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------- helpers ---------- */

async function open(page, idx = 0, mobile = false) {
  await page.goto(`file://${ROOT}/index.html?mobile=${mobile ? 1 : 0}#/${idx}`);
  await sleep(600);
}

// Va a la slide idx y espera a que su escena exista (section._scene)
async function goto(page, idx) {
  await page.evaluate(i => Reveal.slide(i, 0, 99), idx);
  await page.waitForFunction(i => window.__sec(i)._scene, { timeout: 4000 }, idx);
}

// Ejecuta fn(section, ...args) en la página sobre la slide idx
async function evalScene(page, idx, fn, ...args) {
  await goto(page, idx);
  return page.evaluate(`(${fn})(window.__sec(${idx}), ...${JSON.stringify(args)})`);
}

// Ejecuta fn(svg, ...args) con un <svg> nuevo en la página (para probar motores sin slide)
async function engine(page, fn, ...args) {
  return page.evaluate(`(() => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', 'position:fixed;left:0;top:0;width:900px;height:590px;opacity:0;pointer-events:none');
    document.body.appendChild(svg);
    try { return (${fn})(svg, ...${JSON.stringify(args)}); } finally { svg.remove(); }
  })()`);
}

function check(cond, msg) { if (!cond) throw new Error(msg); }

/* ---------- pruebas ---------- */

test('base: carga sin errores de consola', async (page, errors) => {
  await open(page, 0);
  check(errors.length === 0, `errores: ${errors.join(' | ')}`);
});

/* ---------- motor MsgKit ---------- */

// invariante: todo mensaje enviado está en algún estado
const INV = `w => w.sent === w.rejected + w.done + w.dlq + w.queueLen + w.inFlight`;

test('msg: sync se satura', async page => {
  await open(page);
  const w = await engine(page, svg => {
    const s = new MsgKit.MsgSim(svg, { mode: 'sync', rate: 4, slots: 3, workTime: 1.5, seed: 1 });
    s.fastForward(20);
    return s.window(5);
  });
  check(w.rejected > 10, `rejected=${w.rejected}`);
  check(w.queueLen === 0, `queueLen=${w.queueLen}`);
});

test('msg: queue no rechaza', async page => {
  await open(page);
  const w = await engine(page, svg => {
    const s = new MsgKit.MsgSim(svg, { mode: 'queue', rate: 4, workers: 1, workTime: 1.5, seed: 1 });
    s.fastForward(20);
    return s.window(10);
  });
  check(w.rejected === 0, `rejected=${w.rejected}`);
  check(w.queueLen > 20, `queueLen=${w.queueLen}`);
  check(w.respP95 === 0, `respP95=${w.respP95}`);
  check(w.doneP95 > 3, `doneP95=${w.doneP95}`);
});

test('msg: workers apagados no pierden', async page => {
  await open(page);
  const r = await engine(page, (svg, INV) => {
    const inv = eval(INV);
    const s = new MsgKit.MsgSim(svg, { mode: 'queue', rate: 2, workers: 2, workTime: 0.6, seed: 1 });
    s.fastForward(5);
    s.setWorkersUp(false);
    const d0 = s.window(5).done;
    s.fastForward(10);
    const off = s.window(5);
    s.setWorkersUp(true);
    s.fastForward(40);
    const end = s.window(5);
    return { d0, off, end, inv: inv(end) };
  }, INV);
  check(r.off.done === r.d0, `done cambió con workers apagados: ${r.d0} → ${r.off.done}`);
  check(r.off.queueLen >= 15, `queueLen apagado=${r.off.queueLen}`);
  check(r.end.queueLen <= 1, `queueLen final=${r.end.queueLen}`);
  check(r.inv, `invariante: ${JSON.stringify(r.end)}`);
});

test('msg: más workers vacían más rápido', async page => {
  await open(page);
  const [one, four] = await engine(page, svg => [1, 4].map(n => {
    const s = new MsgKit.MsgSim(svg, { mode: 'queue', rate: 3, workers: n, workTime: 1, seed: 1 });
    s.fastForward(20);
    return s.window(5).queueLen;
  }));
  check(four < one / 3, `1 worker=${one}, 4 workers=${four}`);
});

test('msg: crash antes del ack duplica', async page => {
  await open(page);
  const r = await engine(page, (svg, INV) => {
    const s = new MsgKit.MsgSim(svg, { mode: 'queue', rate: 1.5, workers: 2, workTime: 1, seed: 1 });
    s.fastForward(2);
    s.crashBeforeAck();
    s.fastForward(10);
    const w = s.window(5);
    return { w, inv: eval(INV)(w) };
  }, INV);
  check(r.w.dup === 1, `dup=${r.w.dup}`);
  check(r.inv, `invariante: ${JSON.stringify(r.w)}`);
});

test('msg: poison va a DLQ', async page => {
  await open(page);
  const w = await engine(page, svg => {
    const s = new MsgKit.MsgSim(svg, { mode: 'queue', rate: 1, workers: 2, workTime: 1, maxRetries: 3, seed: 1 });
    s.sendPoison();
    s.fastForward(20);
    return s.window(5);
  });
  check(w.dlq === 1, `dlq=${w.dlq}`);
});

test('msg: toggles rápidos conservan mensajes', async page => {
  await open(page);
  const r = await engine(page, (svg, INV) => {
    const s = new MsgKit.MsgSim(svg, { mode: 'queue', rate: 3, workers: 2, workTime: 1, seed: 1 });
    s.fastForward(3);
    for (let i = 0; i < 10; i++) s.addWorker();
    const max = s.o.workers;
    for (let i = 0; i < 5; i++) { s.setWorkersUp(false); s.fastForward(0.3); s.setWorkersUp(true); s.fastForward(0.3); }
    for (let i = 0; i < 5; i++) s.removeWorker();
    s.fastForward(30);
    const w = s.window(5);
    const neg = Object.values(w).some(v => typeof v === 'number' && v < 0);
    return { w, max, workers: s.o.workers, neg, inv: eval(INV)(w) };
  }, INV);
  check(r.max === 6, `maxWorkers=${r.max}`);
  check(r.workers >= 1, `workers=${r.workers}`);
  check(!r.neg, `contador negativo: ${JSON.stringify(r.w)}`);
  check(r.inv, `invariante: ${JSON.stringify(r.w)}`);
});

test('msg: reset limpia svg y timers', async page => {
  await open(page);
  const r = await engine(page, svg => {
    const s = new MsgKit.MsgSim(svg, { mode: 'queue', rate: 3, workers: 2, workTime: 1, seed: 1 });
    s.fastForward(3);
    const before = svg.querySelectorAll('.msg').length;
    s.reset(Object.assign({}, s.o, { rate: 0 }));
    const after = svg.querySelectorAll('.msg').length;
    const w0 = s.window(60);
    s.fastForward(3);
    return { before, after, sent: w0.sent, doneLater: s.window(60).done };
  });
  check(r.before > 0, `antes del reset no había mensajes: ${r.before}`);
  check(r.after === 0, `mensajes después del reset: ${r.after}`);
  check(r.sent === 0, `sent=${r.sent}`);
  check(r.doneLater === 0, `terminó un mensaje viejo: ${r.doneLater}`);
});

test('msg: resultados independientes de la velocidad', async page => {
  await open(page);
  const [a, b] = await engine(page, svg => [0.25, 1.5].map(v => {
    NetKit.Speed.value = v;
    const s = new MsgKit.MsgSim(svg, { mode: 'sync', rate: 4, slots: 3, workTime: 1.5, seed: 7 });
    s.fastForward(20);
    const w = s.window(5);
    return { sent: w.sent, rejected: w.rejected };
  }));
  check(a.sent === b.sent && a.rejected === b.rejected, `0,25×=${JSON.stringify(a)} 1,5×=${JSON.stringify(b)}`);
});

/* ---------- motor: modos direct y pubsub ---------- */

test('msg: direct falla si uno cae', async page => {
  await open(page);
  const r = await engine(page, svg => {
    const s = new MsgKit.MsgSim(svg, { mode: 'direct', rate: 1, seed: 1 });
    s.setSubscriberUp('mails', false);
    s.fastForward(15);
    return { rejected: s.window(5).rejected, analytics: s.sub('analytics').done };
  });
  check(r.rejected > 5, `rejected=${r.rejected}`);
  check(r.analytics === 0, `analytics.done=${r.analytics}`);
});

test('msg: pubsub aísla fallas', async page => {
  await open(page);
  const r = await engine(page, svg => {
    const s = new MsgKit.MsgSim(svg, { mode: 'pubsub', rate: 1, seed: 1 });
    s.setSubscriberUp('mails', false);
    s.fastForward(15);
    const mid = { rejected: s.window(5).rejected, stockLag: s.sub('stock').lag, mailsQ: s.sub('mails').queueLen };
    s.setSubscriberUp('mails', true);
    s.fastForward(30);
    return Object.assign(mid, { mailsLag: s.sub('mails').lag });
  });
  check(r.rejected === 0, `rejected=${r.rejected}`);
  check(r.stockLag <= 1, `stock.lag=${r.stockLag}`);
  check(r.mailsQ >= 10, `mails.queueLen=${r.mailsQ}`);
  check(r.mailsLag <= 1, `mails.lag final=${r.mailsLag}`);
});

test('msg: fan-out una copia por suscriptor', async page => {
  await open(page);
  const r = await engine(page, svg => {
    const s = new MsgKit.MsgSim(svg, { mode: 'pubsub', rate: 1, seed: 1 });
    s.fastForward(10);
    s.setRate(0);
    s.fastForward(10);
    return { pub: s.published('OrdenCreada'), done: ['facturacion', 'stock', 'mails', 'analytics'].map(id => s.sub(id).done) };
  });
  check(r.pub > 5, `published=${r.pub}`);
  check(r.done.every(d => d === r.pub), `published=${r.pub} done=${r.done}`);
});

test('msg: addSubscriber en vivo', async page => {
  await open(page);
  const r = await engine(page, svg => {
    const s = new MsgKit.MsgSim(svg, { mode: 'pubsub', rate: 1, seed: 1 });
    s.fastForward(3);
    const sent0 = s.window(5).sent;
    s.addSubscriber({ id: 'fraude', label: 'Fraude', icon: '🛡', workTime: 0.5, workers: 1, listens: ['OrdenCreada'] });
    s.fastForward(2);
    const sent1 = s.window(5).sent;
    s.fastForward(8);
    return { sent0, sent1, fraude: s.sub('fraude').done };
  });
  check(r.sent1 > r.sent0, `el productor se frenó: ${r.sent0} → ${r.sent1}`);
  check(r.fraude > 0, `fraude.done=${r.fraude}`);
});

test('msg: addSubscriber respeta el máximo', async page => {
  await open(page);
  const n = await engine(page, svg => {
    const s = new MsgKit.MsgSim(svg, { mode: 'pubsub', rate: 1, seed: 1 });
    for (let i = 0; i < 3; i++) s.addSubscriber({ id: 'x' + i, label: 'X', icon: '•', workTime: 0.5, workers: 1, listens: ['OrdenCreada'] });
    return s.subs.length;
  });
  check(n === 5, `suscriptores=${n}`);
});

test('msg: direct addSubscriber frena al productor', async page => {
  await open(page);
  const r = await engine(page, svg => {
    const s = new MsgKit.MsgSim(svg, { mode: 'direct', rate: 2, seed: 1 });
    s.fastForward(3);
    s.addSubscriber({ id: 'fraude', label: 'Fraude', icon: '🛡', workTime: 0.5, workers: 1, listens: ['OrdenCreada'] });
    const a = s.window(5).sent;
    s.fastForward(1.8);
    const b = s.window(5).sent;
    s.fastForward(3);
    return { a, b, c: s.window(5).sent };
  });
  check(r.b === r.a, `envió durante el redeploy: ${r.a} → ${r.b}`);
  check(r.c > r.b, `no volvió a enviar: ${r.b} → ${r.c}`);
});

test('msg: cadena espera al emisor', async page => {
  await open(page);
  const r = await engine(page, svg => {
    const subs = MsgKit.DEFAULT_SUBS.map(x => Object.assign({}, x, x.id === 'mails' ? { listens: ['FacturaEmitida'] } : {}));
    const s = new MsgKit.MsgSim(svg, { mode: 'pubsub', rate: 1, seed: 1, subscribers: subs });
    s.setSubscriberUp('facturacion', false);
    s.fastForward(10);
    const fe0 = s.published('FacturaEmitida');
    s.setSubscriberUp('facturacion', true);
    s.fastForward(20);
    return { fe0, fe1: s.published('FacturaEmitida'), mails: s.sub('mails').done };
  });
  check(r.fe0 === 0, `FacturaEmitida con facturación apagada=${r.fe0}`);
  check(r.fe1 > 0, `FacturaEmitida=${r.fe1}`);
  check(r.mails > 0, `mails.done=${r.mails}`);
});

test('msg: reset vuelve a los suscriptores iniciales', async page => {
  await open(page);
  const n = await engine(page, svg => {
    const o = { mode: 'pubsub', rate: 1, seed: 1 };
    const s = new MsgKit.MsgSim(svg, o);
    s.addSubscriber({ id: 'fraude', label: 'Fraude', icon: '🛡', workTime: 0.5, workers: 1, listens: ['OrdenCreada'] });
    s.reset(o);
    return s.subs.length;
  });
  check(n === 4, `suscriptores=${n}`);
});

/* ---------- escenas ---------- */
// índices de slide (0 = portada)
const SL = { command: 1, direct: 2, pubsub: 3, pace: 4, consistency: 5, chain: 6, complex: 7, summary: 8 };

test('escena: direct clic apaga y falla', async page => {
  await open(page);
  const r = await evalScene(page, SL.direct, sec => {
    const sim = sec._scene.sim;
    sim.subs.find(x => x.id === 'mails').g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    sim.fastForward(10);
    return { up: sim.sub('mails').up, rejected: sim.window(5).rejected };
  });
  check(r.up === false, 'mails sigue prendido');
  check(r.rejected > 0, `rejected=${r.rejected}`);
});

test('escena: direct ＋Fraude frena al productor', async page => {
  await open(page);
  const r = await evalScene(page, SL.direct, sec => {
    const sim = sec._scene.sim;
    sec.querySelector('[data-act=add]').click();
    const a = sim.window(5).sent;
    sim.fastForward(1.8);
    return { a, b: sim.window(5).sent, fraude: !!sim.sub('fraude') };
  });
  check(r.fraude, 'no se agregó fraude');
  check(r.a === r.b, `envió durante el redeploy: ${r.a} → ${r.b}`);
});

test('escena: pubsub ＋Fraude sin frenar', async page => {
  await open(page);
  const r = await evalScene(page, SL.pubsub, sec => {
    const sim = sec._scene.sim;
    sec.querySelector('[data-act=add]').click();
    const a = sim.window(5).sent;
    sim.fastForward(4);
    return { a, b: sim.window(5).sent, fraude: sim.sub('fraude') && sim.sub('fraude').done };
  });
  check(r.b > r.a, `el productor se frenó: ${r.a} → ${r.b}`);
  check(r.fraude > 0, `fraude.done=${r.fraude}`);
});

test('notas: las 9 slides con pregunta', async page => {
  await open(page);
  const r = await page.evaluate(() => [...document.querySelectorAll('.reveal .slides > section')]
    .map((s, i) => (s.querySelector('aside.notes') && s.querySelector('aside.notes').textContent.includes('?') ? 0 : i + 1)));
  check(r.length === 9, `slides=${r.length}`);
  check(!r.filter(Boolean).length, `sin pregunta: ${r.filter(Boolean)}`);
});

test('estática: resumen nombra Kafka y EventBridge', async page => {
  await open(page);
  const t = await page.evaluate(i => window.__sec(i) ? window.__sec(i).textContent : '', SL.summary);
  check(t.includes('Kafka') && t.includes('EventBridge'), 'faltan Kafka / EventBridge en el resumen');
});

test('escena: portada anima en escritorio', async page => {
  await open(page);
  await page.waitForFunction(() => window.__sec(0)._scene, { timeout: 4000 });
  const mode = await page.evaluate(() => window.__sec(0)._scene.sim.o.mode);
  check(mode === 'pubsub', `mode=${mode}`);
});

test('escena: analytics se atrasa y réplicas lo arreglan', async page => {
  await open(page);
  const r = await evalScene(page, SL.pace, sec => {
    const sim = sec._scene.sim;
    sim.fastForward(20);
    const lag0 = sim.sub('analytics').lag;
    for (let i = 0; i < 2; i++) sec.querySelector('[data-act=add]').click();
    sim.fastForward(40);
    return { lag0, lag1: sim.sub('analytics').queueLen, workers: sim.sub('analytics').workers, others: sim.sub('stock').queueLen, bars: sec.querySelectorAll('.lag-row').length };
  });
  check(r.lag0 > 5, `lag inicial=${r.lag0}`);
  check(r.workers === 3, `workers=${r.workers}`);
  check(r.lag1 <= 1, `cola de analytics al final=${r.lag1}`);
  check(r.others <= 1, `cola de stock=${r.others}`);
  check(r.bars === 4, `filas de atraso=${r.bars}`);
});

test('escena: consistencia se ve y se cierra', async page => {
  await open(page);
  const r = await evalScene(page, SL.consistency, sec => {
    const sim = sec._scene.sim;
    sec.querySelector('[data-act=order]').click();
    sim.fastForward(0.8);
    sim._frame();
    const n = sec.querySelector('.cnt-orders').textContent, m = sec.querySelector('.cnt-stock').textContent;
    const warn = sec.querySelector('.cnt-stock').classList.contains('warn');
    sim.fastForward(5);
    sim._frame();
    return { n, m, warn, n2: sec.querySelector('.cnt-orders').textContent, m2: sec.querySelector('.cnt-stock').textContent, ok: sec.querySelector('.cnt-stock').classList.contains('ok') };
  });
  check(r.n === '1' && r.m === '0' && r.warn, `durante: órdenes=${r.n} stock=${r.m} warn=${r.warn}`);
  check(r.n2 === '1' && r.m2 === '1' && r.ok, `después: órdenes=${r.n2} stock=${r.m2} ok=${r.ok}`);
});

test('escena: cadena de eventos', async page => {
  await open(page);
  const r = await evalScene(page, SL.chain, sec => {
    const sim = sec._scene.sim;
    sim.fastForward(6);
    const fe = sim.published('FacturaEmitida'), mails = sim.sub('mails').done;
    sec.querySelector('[data-act=toggle]').click();
    const a = sim.published('FacturaEmitida');
    sim.fastForward(10);
    return { fe, mails, a, b: sim.published('FacturaEmitida'), color: MsgKit.EV_COLORS.FacturaEmitida, listens: sim.subs.find(x => x.id === 'mails').listens.join() };
  });
  check(r.listens === 'FacturaEmitida', `mails escucha ${r.listens}`);
  check(r.fe > 0 && r.mails > 0, `FacturaEmitida=${r.fe} mails.done=${r.mails}`);
  check(r.b <= r.a + 1, `siguió emitiendo con Facturación apagada: ${r.a} → ${r.b}`);
  check(r.color === '#a78bfa', `color=${r.color}`);
});

/* ---------- runner ---------- */

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  let fails = 0, ran = 0;
  for (const t of tests.filter(t => t.name.includes(filter))) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluateOnNewDocument(() => {
      window.__sec = i => document.querySelectorAll('.reveal .slides > section')[i];
    });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => m.type() === 'error' && errors.push(m.text()));
    ran++;
    try {
      await t.fn(page, errors);
      check(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      fails++;
      console.log(`  FAIL ${t.name}\n       ${e.message.split('\n')[0]}`);
    }
    await page.close();
  }
  console.log(`${ran - fails}/${ran} ok`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})();

module.exports = { open, goto, evalScene, engine, check, sleep };
