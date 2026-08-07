# Hoja de ruta — Motor de Póker (B2B)

Última actualización: 6 de agosto de 2026

Progreso general estimado: **~50%** hacia un producto en producción con dinero real.

---

## Fase 1 — Motor de póker (completada, ~90%)

- [x] Reglas de Texas Hold'em: rondas de apuesta, ciegas, all-in
- [x] Botes laterales (side pots) con empates
- [x] Evaluación de manos
- [x] Temporizador de turno (30s) con auto-fold / auto-check y reloj visible
- [x] Bots de prueba
- [x] Autenticación por token secreto por jugador

Pendiente menor: pruebas automatizadas (todo se ha probado manualmente hasta ahora).

---

## Fase 2 — Mesas y lobby (completada, ~80%)

- [x] Crear mesa vacía que espera jugadores reales
- [x] Unirse a un asiento libre (asignación automática, sin choques al reutilizar asientos)
- [x] Arranque automático de la mano al llenarse la mesa
- [x] Listado de mesas activas para el lobby (`GET /mesas`)
- [x] `lobby.html`: interfaz para elegir y unirse a una mesa
- [x] Sala de espera en `mesa.html` (antes se rompía si la mesa no estaba llena)
- [x] Botón "Salir" con confirmación: se retira de la mano o libera el asiento
- [x] Nombres reales de jugadores (ya no "Usuario X")
- [x] Diseño responsivo: versión de escritorio y versión vertical para móvil (probado en iPhone SE y 14 Pro Max)
- [x] Panel de administración (`admin.html`): estadísticas y historial de manos

Pendiente menor:
- Mostrar quién ya está sentado en una mesa antes de unirte
- Mensaje visible si `/mesas` falla en cargar (hoy falla en silencio)
- Mover el refresco del lobby de "cada 3 segundos" a WebSocket
- Revisar que las sillas no se reacomoden visualmente cuando alguien sale de una mesa con 3+ jugadores

---

## Fase 3 — Seguridad y pagos (en progreso, ~35%)

- [x] Ninguna clave ni fichas inventables desde el lobby público (mesa creation movida a `admin-mesas.html`, con límites de asientos/ciega/fichas)
- [x] Webhook de pago: avisa fichas finales cuando un jugador sale o la mesa termina (endpoint de prueba propio construido y probado)
- [ ] **Depende de FacilitoBet:** backend real que reciba el webhook y acredite el saldo real del jugador
- [ ] **Depende de FacilitoBet:** integración de identidad real (que el nombre de usuario venga autenticado desde su sistema, no escrito a mano)

Este es el bloque con más riesgo del proyecto: la mitad que depende de nosotros ya está lista, pero avanzar más depende de que el equipo de tu hermano construya su lado.

---

## Fase 4 — Estar en producción de verdad (~10%, bloqueada)

- [ ] **Depende de pago de Railway:** el servidor y la base de datos están caídos (prueba gratis vencida, tarjeta venezolana rechazada, esperando verificación de Zinli)
- [ ] Persistencia en Postgres funcionando de forma estable (el código ya existe, pero la conexión falla mientras Railway esté caído)
- [ ] Monitoreo / manejo de errores en producción
- [ ] Al menos un cliente real (FacilitoBet) usándolo en un entorno estable

Sin resolver Railway, nadie fuera de tu computadora puede usar el sistema hoy — este es el cuello de botella más grande para pasar de prototipo a producto real.

---

## Fase 5 — Marca y pulido final (~5%, sin empezar)

- [ ] Nombre del producto (pausado — descartamos "Infinity Poker" por choque de marca, sigues pensando)
- [ ] Logo e identidad visual
- [ ] Fotos de perfil de jugadores (deprioritizado deliberadamente)
- [ ] Evaluar Canvas/PixiJS en vez de HTML/CSS (solo si aparecen problemas reales de rendimiento — no es prioridad)

---

## Resumen: qué depende de quién

**Depende de ti / de este proyecto:**
Pulido del lobby, marca, fotos de perfil, pruebas automatizadas.

**Depende de tu hermano / equipo de FacilitoBet:**
Backend receptor del webhook de pago, integración de identidad/login real.

**Depende de resolver el pago de Railway:**
Que el sistema esté accesible fuera de tu computadora, y que la persistencia en base de datos funcione de forma estable.
