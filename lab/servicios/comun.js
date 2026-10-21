// Conexión a RabbitMQ y declaración del exchange de eventos, compartida por todos los servicios.
const amqp = require('amqplib');

const URL = process.env.RABBIT_URL || 'amqp://tienda:tienda@rabbit';
const EXCHANGE = 'tienda.eventos'; // tipo topic: cada evento se copia a todas las colas suscriptas

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function conectar(quien) {
  for (;;) {
    try {
      const conn = await amqp.connect(URL);
      conn.on('close', () => { console.log(`[${quien}] se cortó la conexión con RabbitMQ, me reinicio`); process.exit(1); });
      conn.on('error', () => {});
      const ch = await conn.createChannel();
      await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
      console.log(`[${quien}] conectado a RabbitMQ`);
      return { conn, ch };
    } catch {
      console.log(`[${quien}] RabbitMQ no responde, reintento en 2 s`);
      await dormir(2000);
    }
  }
}

function publicar(ch, evento, datos) {
  ch.publish(EXCHANGE, evento, Buffer.from(JSON.stringify(datos)), { persistent: true, type: evento });
}

module.exports = { conectar, publicar, dormir, EXCHANGE };
