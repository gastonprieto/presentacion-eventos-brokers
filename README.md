# Eventos con brokers

Presentación interactiva (reveal.js + simulaciones en SVG) sobre eventos con brokers: comando vs. evento, publicar y suscribirse, consumidores heterogéneos que van a su ritmo, consistencia eventual y reacciones en cadena.

**Verla:** https://gastonprieto.github.io/presentacion-eventos-brokers/ (en el celular se ve como documento vertical).

Teclas: `→` avanzar · `S` notas del orador · `F` pantalla completa · `O` vista general · `-` / `+` velocidad de las simulaciones.

## Probar

Desde `presentaciones-guideline/tools` (después de `npm i`):

```bash
node smoke.js ../../presentacion-eventos-brokers    # escritorio
node mobile.js ../../presentacion-eventos-brokers   # celular
```

Y desde esta carpeta: `node tests/interact.js` (motor de eventos y escenas).

Basada en [presentaciones-guideline](../presentaciones-guideline).

## Laboratorio con Docker

Lo mismo que muestran las simulaciones, con servicios reales: **Órdenes** publica `OrdenCreada` en **RabbitMQ** (exchange `tienda.eventos`, tipo topic) y **Facturación**, **Stock**, **Mails** y **Analytics** se suscriben, cada uno con su propia cola. Facturación, al terminar, publica `FacturaEmitida`, que escucha Mails. **Fraude** está listo para sumarse sin tocar a Órdenes. Hace falta Docker con Compose.

```bash
docker compose up -d --build                    # levanta todo
docker compose logs -f facturacion stock mails analytics ordenes   # en otra terminal: cómo le llega cada evento a cada uno
docker compose --profile fraude down -v         # al terminar (incluye a Fraude si lo sumaste)
```

| Dirección | Qué es |
|---|---|
| `localhost:8080` | Órdenes (rutas abajo) |
| `http://localhost:15672` | panel de RabbitMQ (usuario `tienda`, clave `tienda`). En **Exchanges → tienda.eventos** se ven las suscripciones (bindings) y en **Queues and Streams** la cola de cada servicio |

| Ruta de Órdenes | Qué hace |
|---|---|
| `POST /ordenes` | crea una orden y publica `OrdenCreada` (con `?n=5`, cinco órdenes). Responde **201** enseguida |
| `POST /ordenes/sync` | la versión **sin broker**: llama en serie a Facturación, Stock, Mails y Analytics y espera a todos |
| `GET /estado` | tablero: órdenes creadas y, por servicio, réplicas, eventos pendientes y procesados |

| Servicio | Escucha | Tarda | Publica |
|---|---|---|---|
| Facturación | `OrdenCreada` | 400 ms | `FacturaEmitida` |
| Stock | `OrdenCreada` | 500 ms | — |
| Mails | `OrdenCreada`, `FacturaEmitida` | 200 ms | — |
| Analytics | `OrdenCreada` | 1200 ms (el lento) | — |
| Fraude (perfil `fraude`) | `OrdenCreada` | 400 ms | — |

Todos los suscriptores son el mismo código (`lab/servicios/suscriptor.js`) con distinta configuración en `docker-compose.yml`; Órdenes está en `lab/servicios/ordenes.js`.

Para mirar el tablero en vivo, dejalo corriendo en una terminal:

```bash
while true; do clear; curl -s localhost:8080/estado; sleep 0.5; done
```

### Recorrido

**Sin broker: Órdenes llama a cada uno y espera.** La respuesta tarda la suma de los cuatro, y si uno se cae, falla la orden entera aunque lo caído no fuera urgente.

```bash
curl -XPOST localhost:8080/ordenes/sync     # 200 después de ~2,3 s
docker compose stop mails
curl -XPOST localhost:8080/ordenes/sync     # 503: la orden falló porque mails no respondió
docker compose start mails
```

Sumar Fraude a este flujo obliga a cambiar la lista `SERVICIOS` en `ordenes.js` y volver a desplegar Órdenes.

**Con broker: publicar una vez, que le llegue a cada uno.** Órdenes responde al instante y no sabe quién escucha; cada servicio recibe su copia.

```bash
curl -XPOST localhost:8080/ordenes          # 201 enseguida
docker compose logs --since 10s             # el mismo OrdenCreada #N llega a los cuatro
```

Sumar a Fraude no toca a Órdenes: sólo se suscribe (crea su cola y la ata al exchange).

```bash
docker compose --profile fraude up -d fraude
curl -XPOST localhost:8080/ordenes
curl localhost:8080/estado                  # aparece fraude con su evento procesado
```

**Cada suscriptor va a su ritmo.** Con 1,5 órdenes por segundo, Analytics (1,2 s por evento) se atrasa y los demás ni se enteran. Sus réplicas comparten la misma cola y se reparten los eventos, como los workers de colas.

```bash
for i in $(seq 30); do curl -s -XPOST localhost:8080/ordenes > /dev/null; sleep 0.66; done &
# en el tablero: analytics acumula pendientes; el resto, al día
docker compose up -d --scale analytics=3
# analytics se pone al día
```

**Consistencia eventual.** Creá varias órdenes de golpe y mirá el tablero: la orden ya existe, pero por un momento Stock (y los demás) todavía no la procesaron. Al rato, todos al día.

```bash
curl -XPOST 'localhost:8080/ordenes?n=5'; curl -s localhost:8080/estado
```

**Un evento dispara otro.** Facturación escucha `OrdenCreada` y publica `FacturaEmitida`; Mails escucha las dos. Si apagás Facturación, Mails deja de recibir facturas aunque Mails está perfecto: la dependencia existe, pero no está escrita en ningún lado.

```bash
docker compose stop facturacion
curl -XPOST 'localhost:8080/ordenes?n=3'
docker compose logs mails --since 10s       # sólo OrdenCreada, ningún FacturaEmitida
docker compose start facturacion            # procesa lo pendiente y salen las facturas atrasadas
```

### Romper cosas

| Qué romper | Comando | Qué se ve | Volver |
|---|---|---|---|
| Un suscriptor | `docker compose stop stock` | Órdenes sigue respondiendo 201; en el tablero Stock aparece `⏻ caído` y sus pendientes crecen en su cola. Los demás, al día | `docker compose start stock` (se pone al día solo) |
| Un suscriptor, en la versión sin broker | `docker compose stop mails` y `curl -XPOST localhost:8080/ordenes/sync` | **503**: la orden falla entera | `docker compose start mails` |
| El primero de una cadena | `docker compose stop facturacion` | Mails deja de mandar facturas; nadie ve un error | `docker compose start facturacion` |
| Una réplica de Analytics | `docker compose up -d --scale analytics=3` y después `--scale analytics=1` | Las que quedan siguen con la misma cola; no se pierde ningún evento | — |
| Un suscriptor lento | Cambiá `WORK_MS` de Stock a `3000` y `docker compose up -d stock` | Stock se atrasa cada vez más: la ventana de consistencia eventual crece | volver a `500` |
| El broker | `docker compose stop rabbit` | `POST /ordenes` falla (`Empty reply` / `Failed to connect`): si se cae el broker, nadie se entera de nada. Los servicios se reinician y reintentan cada 2 s | `docker compose start rabbit` |
| Eventos pendientes y el broker | Con Facturación apagada y eventos en su cola: `docker compose stop rabbit` y `docker compose start rabbit facturacion` | Los eventos pendientes siguen ahí: las colas guardan los mensajes en disco (volumen `rabbit`) | — |

Si RabbitMQ queda más de un minuto en `health: starting` (`docker compose ps`) después de un `start`, recrealo: `docker compose up -d --force-recreate rabbit`. Los mensajes están en el volumen y no se pierden.
