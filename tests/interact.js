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

/* ---------- escenas ---------- */
// índices de slide (0 = portada)
const SL = { command: 1, direct: 2, pubsub: 3, pace: 4, consistency: 5, chain: 6, complex: 7, summary: 8 };

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
