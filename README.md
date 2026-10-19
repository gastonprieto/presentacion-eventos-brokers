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
