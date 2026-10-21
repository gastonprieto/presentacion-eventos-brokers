// Un suscriptor genérico: Facturación, Stock, Mails, Analytics y Fraude son este mismo
// código con otra configuración. Cada servicio tiene SU cola (con el nombre del servicio)
// atada al exchange: así cada uno recibe su copia de cada evento. Las réplicas de un
// mismo servicio comparten la cola y se reparten los mensajes.
//   NOMBRE    nombre del servicio (y de su cola)
//   ESCUCHA   eventos a los que se suscribe, separados por coma
//   ACCION    qué hace con cada evento (sólo para el log)
//   WORK_MS   cuánto tarda en procesar cada evento
//   PUBLICA   evento que publica después de procesar OrdenCreada (opcional)
const http = require('node:http');
const os = require('node:os');
const { conectar, publicar, dormir, EXCHANGE } = require('./comun');

const NOMBRE = process.env.NOMBRE;
const ESCUCHA = (process.env.ESCUCHA || 'OrdenCreada').split(',');
const ACCION = process.env.ACCION || 'proceso';
const WORK_MS = Number(process.env.WORK_MS || 500);
const PUBLICA = process.env.PUBLICA;
const yo = `${NOMBRE} ${os.hostname().slice(0, 6)}`;
const log = (...a) => console.log(`[${yo}]`, ...a);
let enCurso = 0;
let procesados = 0;

conectar(yo).then(async ({ ch }) => {
  const cola = NOMBRE.toLowerCase();
  await ch.assertQueue(cola, { durable: true });
  for (const evento of ESCUCHA) await ch.bindQueue(cola, EXCHANGE, evento);
  await ch.prefetch(1);

  await ch.consume(cola, async (msg) => {
    const evento = msg.fields.routingKey;
    const { id } = JSON.parse(msg.content.toString());
    enCurso = 1;
    await dormir(WORK_MS);
    ch.ack(msg);
    enCurso = 0;
    procesados++;
    log(`${evento} #${id} → ${ACCION}`);
    if (PUBLICA && evento === 'OrdenCreada') {
      publicar(ch, PUBLICA, { id });
      log(`  publiqué ${PUBLICA} #${id}`);
    }
  });
  log(`suscripto a ${ESCUCHA.join(', ')} (cola "${cola}", ${WORK_MS} ms por evento)`);
});

// Para la versión sin broker: Órdenes llama a POST /procesar y espera la respuesta.
// GET /estado lo consulta Órdenes para mostrar qué tan al día está cada servicio.
http.createServer(async (req, res) => {
  if (req.url === '/estado') return res.end(JSON.stringify({ enCurso, procesados }));
  if (req.method === 'POST' && req.url.startsWith('/procesar')) {
    const id = new URL(req.url, 'http://x').searchParams.get('orden');
    await dormir(WORK_MS);
    log(`llamada directa de Órdenes: orden #${id} → ${ACCION}`);
    return res.end(`${NOMBRE} ok\n`);
  }
  res.writeHead(404).end();
}).listen(3000);

process.on('SIGTERM', () => process.exit(0));
