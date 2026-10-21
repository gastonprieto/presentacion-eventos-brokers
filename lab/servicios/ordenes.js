// Órdenes: crea órdenes de las dos formas de la presentación.
//   POST /ordenes        → publica OrdenCreada en el broker y responde enseguida (con broker)
//   POST /ordenes/sync   → llama en serie a cada servicio y espera a todos (sin broker)
//   GET  /estado         → órdenes creadas y cuántos eventos le faltan procesar a cada servicio
const http = require('node:http');
const dns = require('node:dns').promises;
const { conectar, publicar } = require('./comun');

// Sin broker, Órdenes tiene que conocer a cada servicio. Sumar uno es cambiar esta lista.
const SERVICIOS = ['facturacion', 'stock', 'mails', 'analytics'];
// Todos los suscriptores que conoce el tablero de /estado (Órdenes no les manda nada).
const SUSCRIPTORES = ['facturacion', 'stock', 'mails', 'analytics', 'fraude'];

let creadas = 0;
const log = (...a) => console.log('[Órdenes]', ...a);

function responder(res, code, texto) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(texto + '\n');
}

// Cuántos mensajes esperan en la cola de un servicio y cuántas réplicas la consumen.
// Un canal por consulta: si la cola no existe, RabbitMQ cierra el canal.
async function cola(conn, nombre) {
  const ch = await conn.createChannel();
  ch.on('error', () => {});
  try { return await ch.checkQueue(nombre); } catch { return null; } finally { ch.close().catch(() => {}); }
}

// Qué está haciendo cada réplica de un servicio: el DNS de Docker devuelve una IP por réplica.
async function replicas(nombre) {
  const ips = await dns.lookup(nombre, { all: true }).catch(() => []);
  const r = await Promise.all(ips.map(({ address }) =>
    fetch(`http://${address}:3000/estado`, { signal: AbortSignal.timeout(500) }).then((x) => x.json()).catch(() => null)));
  return r.filter(Boolean);
}

const fila = (servicio, consumidores, pendientes, procesados, marca = '') =>
  `${servicio.padEnd(12)}${String(consumidores).padStart(9)}${String(pendientes).padStart(12)}${String(procesados).padStart(12)}   ${marca}`;

async function estado(conn) {
  const filas = await Promise.all(SUSCRIPTORES.map(async (s) => {
    const q = await cola(conn, s);
    if (!q) return fila(s, '—', '—', '—', 'no está suscripto (no tiene cola)');
    const r = await replicas(s);
    // Pendientes: los que esperan en su cola más los que sus réplicas tienen entre manos.
    const pendientes = q.messageCount + r.reduce((a, x) => a + x.enCurso, 0);
    const procesados = r.reduce((a, x) => a + x.procesados, 0);
    const marca = q.consumerCount === 0 ? '⏻ caído: los eventos lo esperan en su cola'
      : pendientes > 0 ? '⏳ atrasado' : '✓ al día';
    return fila(s, q.consumerCount, pendientes, procesados, marca);
  }));
  return [
    `Órdenes creadas: ${creadas}`,
    '',
    fila('servicio', 'réplicas', 'pendientes', 'procesados'),
    ...filas,
    '',
    'procesados: eventos desde que arrancó cada réplica (Mails recibe OrdenCreada y FacturaEmitida)',
  ].join('\n');
}

conectar('Órdenes').then(({ conn, ch }) => {
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ruta = `${req.method} ${url.pathname}`;
    try {
      if (ruta === 'POST /ordenes') {
        const n = Math.min(Number(url.searchParams.get('n') || 1), 500);
        const desde = creadas + 1;
        for (let i = 0; i < n; i++) publicar(ch, 'OrdenCreada', { id: ++creadas });
        const rango = n > 1 ? `#${desde}…#${creadas}` : `#${creadas}`;
        log(`orden ${rango} creada → publiqué OrdenCreada (no sé quién escucha)`);
        return responder(res, 201, `201: orden ${rango} creada. OrdenCreada publicado en el broker.`);
      }

      if (ruta === 'POST /ordenes/sync') {
        const id = ++creadas;
        const t0 = Date.now();
        for (const s of SERVICIOS) {
          try {
            const r = await fetch(`http://${s}:3000/procesar?orden=${id}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
            if (!r.ok) throw new Error(`respondió ${r.status}`);
          } catch (e) {
            log(`orden #${id}: no pude hablar con ${s} (${e.cause?.code || e.message}) → 503 al cliente`);
            return responder(res, 503, `503: la orden #${id} falló porque ${s} no respondió (${e.cause?.code || e.message})`);
          }
        }
        log(`orden #${id}: llamé a ${SERVICIOS.join(', ')} y esperé a todos (${Date.now() - t0} ms)`);
        return responder(res, 200, `200: orden #${id} creada después de esperar a ${SERVICIOS.length} servicios (${Date.now() - t0} ms)`);
      }

      if (ruta === 'GET /estado') return responder(res, 200, await estado(conn));

      responder(res, 404, 'rutas: POST /ordenes[?n=5] · POST /ordenes/sync · GET /estado');
    } catch (e) {
      responder(res, 500, `500: ${e.message}`);
    }
  }).listen(3000, () => log('escuchando en :3000'));
});
