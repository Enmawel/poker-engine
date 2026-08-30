require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function crearTablas() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partidas (
      id TEXT PRIMARY KEY,
      estado JSONB NOT NULL,
      tokens JSONB NOT NULL,
      actualizado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS historial_manos (
      id SERIAL PRIMARY KEY,
      partida_id TEXT NOT NULL,
      numero_mano INTEGER,
      resultado JSONB NOT NULL,
      jugado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('Tablas listas');
}

crearTablas().catch(error => console.error('Error creando tablas:', error.message));

const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const servidor = http.createServer(app);
const io = new Server(servidor, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// --- SISTEMA DE LOGS ---
const logs = [];

// --- ESTADO DE PARTIDAS EN MEMORIA ---
const partidas = {};

// --- TOKENS SECRETOS POR JUGADOR ---
// Separados por completo de "partidas" para que nunca se transmitan por accidente
// junto con el estado del juego (eso se emite entero por WebSocket a todos).
const tokensPorPartida = {}; // tokensPorPartida[idPartida] = { [token]: idJugador }

const TIEMPO_LIMITE_TURNO = 30000; // 30 segundos para actuar
const temporizadoresPorPartida = {}; // temporizadoresPorPartida[idPartida] = el setTimeout activo

function generarToken() {
  return crypto.randomBytes(24).toString('hex');
}

function jugadorPorToken(idPartida, token) {
  const tokens = tokensPorPartida[idPartida];
  if (!tokens) return null;
  return tokens[token] || null;
}

// Devuelve una copia del estado de la partida, ocultando las cartas de los
// demás jugadores (excepto en showdown, donde todos se revelan).
function filtrarEstadoParaJugador(partida, idJugador) {
  const esShowdown = partida.fase === 'showdown';

  const jugadoresFiltrados = partida.jugadores.map(j => {
    if (j.id === idJugador || esShowdown) {
      return j;
    }
    return {
      ...j,
      cartas: j.cartas.map(() => ({ oculta: true }))
    };
  });

  return {
    ...partida,
    jugadores: jugadoresFiltrados,
    tuJugadorId: idJugador
  };
}

// Manda a cada socket conectado a la partida su propia versión del estado,
// con las cartas ajenas ocultas.
function emitirEstadoPersonalizado(idPartida) {
  const partida = partidas[idPartida];
  if (!partida) return;

  const room = io.sockets.adapter.rooms.get(idPartida);
  if (!room) return;

  room.forEach(socketId => {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket || !socket.data || !socket.data.jugadorId) return;

    const estadoFiltrado = filtrarEstadoParaJugador(partida, socket.data.jugadorId);
    socket.emit('estadoActualizado', estadoFiltrado);
  });

  guardarPartida(idPartida);
}

async function guardarPartida(idPartida) {
  const partida = partidas[idPartida];
  const tokens = tokensPorPartida[idPartida];
  if (!partida || !tokens) return;

  try {
    await pool.query(
      `INSERT INTO partidas (id, estado, tokens, actualizado_en)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (id) DO UPDATE
       SET estado = $2, tokens = $3, actualizado_en = NOW()`,
      [idPartida, JSON.stringify(partida), JSON.stringify(tokens)]
    );
  } catch (error) {
    console.error('Error guardando partida en la BD:', error.message);
  }
}

async function cargarPartidasGuardadas() {
  const resultado = await pool.query('SELECT id, estado, tokens FROM partidas');

  resultado.rows.forEach(fila => {
    partidas[fila.id] = fila.estado;
    tokensPorPartida[fila.id] = fila.tokens;
  });

  console.log(`Partidas recuperadas de la base de datos: ${resultado.rows.length}`);
}

async function guardarHistorialMano(idPartida, resultado) {
  try {
    await pool.query(
      `INSERT INTO historial_manos (partida_id, resultado) VALUES ($1, $2)`,
      [idPartida, JSON.stringify(resultado)]
    );
  } catch (error) {
    console.error('Error guardando historial de mano:', error.message);
  }
}

function generarId() {
  return Math.random().toString(36).substring(2, 9);
}

function registrarLog(cliente, ruta, estado) {
  const ahora = new Date();
  const entrada = {
    fecha: ahora.toISOString(),
    cliente,
    ruta,
    estado
  };

  logs.push(entrada);
  console.log(`[${entrada.fecha}] | Cliente: ${cliente} | Ruta: ${ruta} | Estado: ${estado}`);
}

// --- API KEYS (simuladas por ahora) ---
const apiKeys = {
  'pk_facilitobet_x7k2m9q3': 'FacilitoBet',
  'pk_betvenezuela_a1b2c3d4': 'BetVenezuela',
  'pk_ganamax_z9y8x7w6':     'GanaMax'
};

// --- MIDDLEWARE DE AUTENTICACIÓN ---
function autenticar(req, res, next) {
  const key = req.headers['x-api-key'];

  if (!key || !apiKeys[key]) {
    return res.status(401).json({
      error: 'API Key inválida o ausente',
      mensaje: 'Incluye tu API Key en el header x-api-key'
    });
  }

  req.cliente = apiKeys[key];
  next();
}

// --- WEBHOOKS DE PAGO POR CLIENTE ---
// Cuando un jugador sale de una mesa con fichas, avisamos a este endpoint
// para que la casa de apuestas le acredite el saldo real. Por ahora,
// FacilitoBet apunta a nuestro propio endpoint de prueba.
const webhooksPorCliente = {
  'FacilitoBet': 'http://localhost:3000/webhook-test/recibir-pago',
  'BetVenezuela': null,
  'GanaMax': null
};

async function notificarPago(mesa, jugador) {
  const cliente = mesa.cliente;
  const webhookUrl = webhooksPorCliente[cliente];
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mesaId: mesa.id,
        jugadorId: jugador.id,
        idUsuarioExterno: jugador.idUsuarioExterno || null,
        nombre: jugador.nombre,
        fichasFinales: jugador.fichas
      })
    });
  } catch (error) {
    console.error(`Error notificando pago a ${cliente}:`, error.message);
  }
}

// Proteger todas las rutas excepto / y /admin/logs
app.use('/partida', autenticar);
app.use('/mano', autenticar);
app.use('/mazo', autenticar);
app.use('/mesa', autenticar);

const { crearMazo, barajar, repartir, repartirTablero, determinarGanador, evaluarMano, valorNumerico } = require('./motor');

// --- Helpers de rotación de ciegas y siguiente mano ---

function siguienteEnJuego(partida, desdeIndice) {
  let i = desdeIndice;
  let vueltas = 0;
  do {
    i = (i + 1) % partida.jugadores.length;
    vueltas++;
    if (vueltas > partida.jugadores.length) return null; // nadie más en juego
  } while (!partida.jugadores[i].enJuego);
  return i;
}

function eliminarSinFichas(partida) {
  partida.jugadores.forEach(j => {
    if (j.enJuego && j.fichas <= 0) {
      j.enJuego = false;
    }
  });
}

function nuevaMano(partida) {
  const jugadoresEnJuego = partida.jugadores.filter(j => j.enJuego);

  if (jugadoresEnJuego.length < 2) {
    partida.fase = 'terminado';
    partida.estado = 'terminado';
    jugadoresEnJuego.forEach(j => notificarPago(partida, j));
    notificarLobbyActualizado();
    return;
  }

  // Rotamos el dealer al siguiente jugador en juego
  partida.indiceDealer = siguienteEnJuego(partida, partida.indiceDealer);

  const idxCiegaChica = siguienteEnJuego(partida, partida.indiceDealer);
  const idxCiegaGrande = siguienteEnJuego(partida, idxCiegaChica);

  // Barajamos y repartimos cartas nuevas solo a quienes siguen en juego
  const mazo = barajar(crearMazo());
  let cursor = 0;

  partida.jugadores.forEach(j => {
    if (j.enJuego) {
      j.cartas = [mazo[cursor], mazo[cursor + 1]];
      cursor += 2;
      j.activo = true;
      j.apuestaActual = 0;
      j.totalApostado = 0;
    } else {
      j.cartas = [];
      j.activo = false;
      j.apuestaActual = 0;
      j.totalApostado = 0;
    }
  });

  const mazoRestante = mazo.slice(cursor);
  partida.tablero = repartirTablero(mazoRestante);

  // Ciegas
  const apuestaMinima = partida.apuestaMinima;
  const jChica = partida.jugadores[idxCiegaChica];
  const jGrande = partida.jugadores[idxCiegaGrande];

  const pagoChica = Math.min(apuestaMinima / 2, jChica.fichas);
  jChica.fichas -= pagoChica;
  jChica.apuestaActual = pagoChica;
  jChica.totalApostado = pagoChica;

  const pagoGrande = Math.min(apuestaMinima, jGrande.fichas);
  jGrande.fichas -= pagoGrande;
  jGrande.apuestaActual = pagoGrande;
  jGrande.totalApostado = pagoGrande;

  partida.pozo = pagoChica + pagoGrande;
  partida.apuestaRonda = pagoGrande;
  partida.accionesDesdeSubida = 0;
  partida.ultimoAgresor = null;
  partida.ganador = null;
  partida.fase = 'preflop';
  partida.turnoActual = siguienteEnJuego(partida, idxCiegaGrande);
  partida.subidasEnRonda = 0;
}

function programarSiguienteMano(id) {
  setTimeout(() => {
    const partida = partidas[id];
    if (!partida) return;

    eliminarSinFichas(partida);
    nuevaMano(partida);

    procesarTurnosBot(id);

    emitirEstadoPersonalizado(id);
  }, 15000);
}

// Arma los botes (principal + laterales) según cuánto apostó cada jugador en la mano
// y quién sigue activo (no se retiró). Devuelve un array de { monto, elegibles }.
function calcularBotes(partida) {
  const contribuyentes = partida.jugadores.filter(j => (j.totalApostado || 0) > 0);
  if (contribuyentes.length === 0) return [];

  const niveles = [...new Set(contribuyentes.map(j => j.totalApostado))].sort((a, b) => a - b);

  const botes = [];
  let nivelAnterior = 0;

  niveles.forEach(nivel => {
    const enEsteNivel = contribuyentes.filter(j => j.totalApostado >= nivel);
    const monto = (nivel - nivelAnterior) * enEsteNivel.length;

    if (monto > 0) {
      let elegibles = enEsteNivel.filter(j => j.activo).map(j => j.id);

      // Salvaguarda: si nadie activo llega a este nivel (no debería pasar),
      // repartimos entre todos los activos para no perder fichas.
      if (elegibles.length === 0) {
        elegibles = partida.jugadores.filter(j => j.activo).map(j => j.id);
      }

      botes.push({ monto, elegibles });
    }

    nivelAnterior = nivel;
  });

  return botes;
}

// --- LÓGICA DE ACCIÓN (reusable por jugadores humanos y bots) ---
// Aplica una acción (fold/check/bet) sobre el jugador que tiene el turno actual.
// Muta "partida" directamente. Si la acción es inválida, devuelve { error, ... } sin tocar el estado.
function procesarAccion(partida, accion, monto) {
  const jugadorActual = partida.jugadores[partida.turnoActual];

  if (accion === 'fold') {
    jugadorActual.activo = false;

  } else if (accion === 'check') {
    const faltante = partida.apuestaRonda - jugadorActual.apuestaActual;
    if (faltante > 0) {
      const aPagar = Math.min(faltante, jugadorActual.fichas);
      jugadorActual.fichas -= aPagar;
      jugadorActual.apuestaActual += aPagar;
      jugadorActual.totalApostado = (jugadorActual.totalApostado || 0) + aPagar;
      partida.pozo += aPagar;
    }
    partida.accionesDesdeSubida = (partida.accionesDesdeSubida || 0) + 1;

  } else if (accion === 'bet') {
    const incremento = monto || partida.apuestaMinima;
    const nuevoTotal = partida.apuestaRonda + incremento;

    if (partida.apuestaMaxima && nuevoTotal > partida.apuestaMaxima) {
      return {
        error: 'La apuesta supera el límite permitido',
        apuestaMaxima: partida.apuestaMaxima,
        intentado: nuevoTotal
      };
    }

    let aPagar = nuevoTotal - jugadorActual.apuestaActual;

    // Table stakes: nadie puede apostar más fichas de las que tiene
    if (aPagar >= jugadorActual.fichas) {
      aPagar = jugadorActual.fichas;
    }

    jugadorActual.fichas -= aPagar;
    jugadorActual.apuestaActual += aPagar;
    jugadorActual.totalApostado = (jugadorActual.totalApostado || 0) + aPagar;
    partida.pozo += aPagar;

    const esSubidaReal = jugadorActual.apuestaActual > partida.apuestaRonda;
    partida.apuestaRonda = Math.max(partida.apuestaRonda, jugadorActual.apuestaActual);

    if (esSubidaReal) {
      partida.ultimoAgresor = partida.turnoActual;
      partida.accionesDesdeSubida = 1;
      partida.subidasEnRonda = (partida.subidasEnRonda || 0) + 1;
    } else {
      // No alcanzó a subir de verdad (ej: ya estaba all-in) — cuenta como un pago más, no reinicia la ronda
      partida.accionesDesdeSubida = (partida.accionesDesdeSubida || 0) + 1;
    }
  }

  const jugadoresActivos = partida.jugadores.filter(j => j.activo);

  if (jugadoresActivos.length === 1) {
    // Solo queda un jugador — gana automáticamente
    partida.fase = 'showdown';
    const ganador = jugadoresActivos[0];
    const montoGanado = partida.pozo;
    partida.ganador = {
      jugador: ganador.id,
      evaluacion: { rango: 0, nombre: 'Los demás se retiraron', cartas: ganador.cartas }
    };
    ganador.fichas += partida.pozo;
    partida.pozo = 0;

    guardarHistorialMano(partida.id, {
      tipo: 'retiro',
      ganador: partida.ganador,
      monto: montoGanado
    });

    programarSiguienteMano(partida.id);

  } else {
    let siguiente = (partida.turnoActual + 1) % partida.jugadores.length;
    while (!partida.jugadores[siguiente].activo) {
      siguiente = (siguiente + 1) % partida.jugadores.length;
    }
    partida.turnoActual = siguiente;

    const todosIgualaron = jugadoresActivos.every(
      j => j.apuestaActual === partida.apuestaRonda || j.fichas === 0
    );
    const accionesCompletas =
      (partida.accionesDesdeSubida || 0) >= jugadoresActivos.length;

    if (todosIgualaron && accionesCompletas) {
      if (partida.fase === 'preflop') partida.fase = 'flop';
      else if (partida.fase === 'flop') partida.fase = 'turn';
      else if (partida.fase === 'turn') partida.fase = 'river';
      else if (partida.fase === 'river') partida.fase = 'showdown';
      
      

      if (partida.fase === 'showdown') {
        console.log('BOTES:', JSON.stringify(calcularBotes(partida)));
      }

      if (partida.fase === 'showdown') {
        const cartasTablero = [
          ...partida.tablero.flop,
          partida.tablero.turn,
          partida.tablero.river
        ];

        const botes = calcularBotes(partida);
        const resultadosPorBote = [];

        botes.forEach(bote => {
          const jugadoresElegibles = bote.elegibles.map(id =>
            partida.jugadores.find(j => j.id === id)
          );
          const manosElegibles = jugadoresElegibles.map(j => j.cartas);
          const ranking = determinarGanador(manosElegibles, cartasTablero);

          const mejorEvaluacion = ranking[0].evaluacion;
          const ganadoresDeEsteBote = ranking.filter(r =>
            r.evaluacion.rango === mejorEvaluacion.rango &&
            r.evaluacion.cartas.every((c, i) =>
              valorNumerico(c) === valorNumerico(mejorEvaluacion.cartas[i])
            )
          );

          const idsGanadores = ganadoresDeEsteBote.map(r => jugadoresElegibles[r.jugador - 1].id);
          const parteBase = Math.floor(bote.monto / idsGanadores.length);
          let resto = bote.monto - parteBase * idsGanadores.length;

          idsGanadores.forEach(id => {
            const jugador = partida.jugadores.find(j => j.id === id);
            let parte = parteBase;
            if (resto > 0) { parte += 1; resto -= 1; }
            jugador.fichas += parte;
          });

          resultadosPorBote.push({
            monto: bote.monto,
            evaluacion: mejorEvaluacion,
            ganadores: idsGanadores
          });
        });

        partida.pozo = 0;
        partida.ganadores = resultadosPorBote;

        guardarHistorialMano(partida.id, {
          tipo: 'showdown',
          ganadores: resultadosPorBote,
          cartasTablero
        });

        // Compatibilidad temporal con el frontend actual (se actualiza en el próximo paso)
        const boteFinal = resultadosPorBote[resultadosPorBote.length - 1];
        partida.ganador = {
          jugador: boteFinal.ganadores[0],
          evaluacion: boteFinal.evaluacion
        };

        programarSiguienteMano(partida.id);
      }

      partida.jugadores.forEach(j => j.apuestaActual = 0);
      partida.apuestaRonda = 0;
      partida.accionesDesdeSubida = 0;
      partida.subidasEnRonda = 0;
      partida.ultimoAgresor = null;
    }
  }

  return null; // sin error
}

// --- BOTS: decisión y disparo automático de turno ---

// Puntúa una mano de preflop (solo 2 cartas, sin tablero) entre 0 y 1
function calcularFuerzaPreflop(cartas) {
  const [c1, c2] = cartas;
  const v1 = valorNumerico(c1);
  const v2 = valorNumerico(c2);
  const esPar = v1 === v2;
  const esDelMismoPalo = c1.palo === c2.palo;
  const promedio = (v1 + v2) / 2; // entre 2 y 14

  let fuerza = (promedio - 2) / 12; // normaliza 2-14 a 0-1
  if (esPar) fuerza += 0.35;
  if (esDelMismoPalo) fuerza += 0.1;
  return Math.min(1, fuerza);
}

// Puntúa la mano del jugador en cualquier fase, entre 0 y 1
function calcularFuerzaMano(partida, jugador) {
  if (partida.fase === 'preflop') {
    return calcularFuerzaPreflop(jugador.cartas);
  }

  const cartasTablero = [
    ...partida.tablero.flop,
    ...(partida.tablero.turn ? [partida.tablero.turn] : []),
    ...(partida.tablero.river ? [partida.tablero.river] : [])
  ];

  const evaluacion = evaluarMano(jugador.cartas, cartasTablero);
  return evaluacion.rango / 10;
}

// Decide qué acción toma un bot según la fuerza de su mano, con algo de azar
function decidirAccionBot(partida, jugador) {
  if (jugador.fichas <= 0) {
    // Ya está all-in: no tiene nada que arriesgar, se queda a ver gratis (nunca se retira sin motivo)
    return { accion: 'check' };
  }

  const faltante = partida.apuestaRonda - jugador.apuestaActual;
  const fuerza = calcularFuerzaMano(partida, jugador);
  const puedeSubir = (partida.subidasEnRonda || 0) < 4; // tope de 4 subidas por ronda para bots

  if (faltante <= 0) {
    if (puedeSubir && fuerza > 0.6 && Math.random() < 0.6) {
      return { accion: 'bet', monto: partida.apuestaMinima * (1 + Math.floor(Math.random() * 2)) };
    }
    return { accion: 'check' };
  }

  if (fuerza < 0.25) {
    return Math.random() < 0.15 ? { accion: 'check' } : { accion: 'fold' };
  }

  if (fuerza < 0.6) {
    return (puedeSubir && Math.random() >= 0.85) ? { accion: 'bet', monto: partida.apuestaMinima } : { accion: 'check' };
  }

  return (puedeSubir && Math.random() < 0.5)
    ? { accion: 'bet', monto: partida.apuestaMinima * (1 + Math.floor(Math.random() * 3)) }
    : { accion: 'check' };
}

function cancelarTemporizadorTurno(id) {
  if (temporizadoresPorPartida[id]) {
    clearTimeout(temporizadoresPorPartida[id]);
    delete temporizadoresPorPartida[id];
  }
}

function iniciarTemporizadorTurno(id) {
  cancelarTemporizadorTurno(id);

  const partida = partidas[id];
  if (!partida) return;
  if (partida.fase === 'showdown' || partida.fase === 'terminado') return;

  const jugador = partida.jugadores[partida.turnoActual];
  if (!jugador || jugador.esBot) return;

  partida.turnoEmpiezaEn = Date.now();
  partida.turnoDuracionMs = TIEMPO_LIMITE_TURNO;

  temporizadoresPorPartida[id] = setTimeout(() => {
    const partidaActual = partidas[id];
    if (!partidaActual) return;
    if (partidaActual.fase === 'showdown' || partidaActual.fase === 'terminado') return;

    const jugadorQueDebiaActuar = partidaActual.jugadores[partidaActual.turnoActual];
    if (!jugadorQueDebiaActuar || jugadorQueDebiaActuar.esBot) return;

    const faltante = partidaActual.apuestaRonda - jugadorQueDebiaActuar.apuestaActual;
    const accionAutomatica = faltante > 0 ? 'fold' : 'check';

    console.log(`Tiempo agotado para jugador ${jugadorQueDebiaActuar.id} en partida ${id}: ${accionAutomatica}`);

    procesarAccion(partidaActual, accionAutomatica);
    procesarTurnosBot(id);

    emitirEstadoPersonalizado(id);
  }, TIEMPO_LIMITE_TURNO);
}

// Si le toca el turno a un bot, espera un momento y actúa solo. Se encadena
// automáticamente si el siguiente turno también es de otro bot.
function procesarTurnosBot(id) {
  const partida = partidas[id];
  if (!partida) return;
  if (partida.fase === 'showdown' || partida.fase === 'terminado') return;

  const jugadorActual = partida.jugadores[partida.turnoActual];
  if (!jugadorActual || !jugadorActual.esBot) {
    iniciarTemporizadorTurno(id);
    return;
  }

  setTimeout(() => {
    const partidaActual = partidas[id];
    if (!partidaActual) return;
    if (partidaActual.fase === 'showdown' || partidaActual.fase === 'terminado') return;

    const jugadorQueActua = partidaActual.jugadores[partidaActual.turnoActual];
    if (!jugadorQueActua || !jugadorQueActua.esBot) return;

    const { accion, monto } = decidirAccionBot(partidaActual, jugadorQueActua);
    let resultado = procesarAccion(partidaActual, accion, monto);

    if (resultado && resultado.error) {
      // Salvavidas: si la decisión del bot quedó inválida por algún motivo,
      // que pase o se retire en vez de dejar la partida trabada.
      const faltanteAhora = partidaActual.apuestaRonda - jugadorQueActua.apuestaActual;
      procesarAccion(partidaActual, faltanteAhora > 0 ? 'fold' : 'check');
    }

    procesarTurnosBot(id);

    emitirEstadoPersonalizado(id);
  }, 1500);
}

// Ruta: verificar que el servidor vive
app.get('/', (req, res) => {
  res.json({ mensaje: 'Motor de Poker funcionando 🃏' });
});

// Ruta: obtener el estado de una partida existente
app.get('/partida/:id', (req, res) => {
  const { id } = req.params;
  const { token } = req.query;
  const partida = partidas[id];

  if (!partida) {
    return res.status(404).json({ error: 'Partida no encontrada' });
  }

  const idJugadorDelToken = jugadorPorToken(id, token);

  if (!idJugadorDelToken) {
    registrarLog(req.cliente, `/partida/${id}`, 401);
    return res.status(401).json({ error: 'Token inválido o ausente' });
  }

  registrarLog(req.cliente, `/partida/${id}`, 200);
  res.json({ id, estado: filtrarEstadoParaJugador(partida, idJugadorDelToken) });
});

function notificarLobbyActualizado() {
  io.emit('mesasActualizadas');
}

// Ruta: crear una mesa vacía que espera jugadores reales (para el lobby)
app.post('/mesa/crear', (req, res) => {
  let asientosMax = Number(req.body.asientosMax) || 6;
  let apuestaMinima = Number(req.body.apuestaMinima) || 50;
  let fichasIniciales = Number(req.body.fichasIniciales) || 1000;
  let bots = Number(req.body.bots) || 0;
  const moneda = req.body.moneda === 'VES' ? 'VES' : 'USD';

  asientosMax = Math.min(9, Math.max(2, Math.round(asientosMax)));
  apuestaMinima = Math.min(10000, Math.max(1, Math.round(apuestaMinima)));
  fichasIniciales = Math.min(1000000, Math.max(apuestaMinima * 2, Math.round(fichasIniciales)));
  bots = Math.min(asientosMax - 1, Math.max(0, Math.round(bots)));

  const id = generarId();

  const nombresBots = nombresAleatorios(bots);
  const jugadoresBots = [];
  let proximoIdJugador = 0;
  for (let i = 0; i < bots; i++) {
    proximoIdJugador++;
    jugadoresBots.push({
      id: proximoIdJugador,
      asiento: i,
      nombre: nombresBots[i],
      idUsuarioExterno: null,
      cartas: [],
      fichas: fichasIniciales,
      apuestaActual: 0,
      totalApostado: 0,
      activo: true,
      enJuego: true,
      esBot: true
    });
  }

  partidas[id] = {
    id,
    cliente: req.cliente,
    moneda,
    estado: 'esperando',
    asientosMax,
    apuestaMinima,
    apuestaMaxima: null,
    fichasIniciales,
    jugadores: jugadoresBots,
    proximoIdJugador,
    fase: null
  };
  tokensPorPartida[id] = {};

  guardarPartida(id);
  notificarLobbyActualizado();

  registrarLog(req.cliente, '/mesa/crear', 200);
  res.json({ id, estado: partidas[id] });
});

// Ruta: unirse a una mesa que está esperando jugadores. Si con este jugador
// se llena el último asiento, la mesa arranca sola.
app.post('/mesa/:id/unirse', (req, res) => {
  const { id } = req.params;
  const { nombreUsuario, idUsuarioExterno } = req.body;

  const mesa = partidas[id];
  if (!mesa) {
    return res.status(404).json({ error: 'Mesa no encontrada' });
  }
  if (mesa.estado !== 'esperando') {
    return res.status(400).json({ error: 'Esta mesa ya está en juego o no acepta más jugadores' });
  }
  if (mesa.jugadores.length >= mesa.asientosMax) {
    return res.status(400).json({ error: 'La mesa ya está llena' });
  }
  if (!nombreUsuario) {
    return res.status(400).json({ error: 'Falta el nombre de usuario' });
  }

  const asientosOcupados = mesa.jugadores.map(j => j.asiento);
  let asiento = 0;
  while (asientosOcupados.includes(asiento)) asiento++;

  mesa.proximoIdJugador = (mesa.proximoIdJugador || 0) + 1;

  const jugador = {
    id: mesa.proximoIdJugador,
    asiento,
    nombre: nombreUsuario,
    idUsuarioExterno: idUsuarioExterno || null,
    cartas: [],
    fichas: mesa.fichasIniciales,
    apuestaActual: 0,
    totalApostado: 0,
    activo: true,
    enJuego: true,
    esBot: false
  };
  mesa.jugadores.push(jugador);

  const token = generarToken();
  tokensPorPartida[id][token] = jugador.id;

  let mesaLlena = false;

  if (mesa.jugadores.length === mesa.asientosMax) {
    mesaLlena = true;
    mesa.indiceDealer = mesa.jugadores.length - 1;
    mesa.estado = 'jugando';
    nuevaMano(mesa);
    procesarTurnosBot(id);
  }

  guardarPartida(id);
  notificarLobbyActualizado();
  registrarLog(req.cliente, `/mesa/${id}/unirse`, 200);

  res.json({
    id,
    jugadorId: jugador.id,
    asiento,
    token,
    mesaLlena,
    asientosOcupados: mesa.jugadores.length,
    asientosMax: mesa.asientosMax
  });

  if (mesaLlena) {
    emitirEstadoPersonalizado(id);
  }
});

// Ruta admin: arrancar una mesa manualmente sin esperar a que se llene
app.post('/mesa/:id/iniciar', autenticar, (req, res) => {
  const { id } = req.params;
  const mesa = partidas[id];
  if (!mesa) {
    return res.status(404).json({ error: 'Mesa no encontrada' });
  }
  if (mesa.estado !== 'esperando') {
    return res.status(400).json({ error: 'Esta mesa ya está en juego o terminada' });
  }
  if (mesa.jugadores.length < 2) {
    return res.status(400).json({ error: 'Se necesitan al menos 2 jugadores para arrancar' });
  }

  mesa.indiceDealer = mesa.jugadores.length - 1;
  mesa.estado = 'jugando';
  nuevaMano(mesa);
  procesarTurnosBot(id);

  guardarPartida(id);
  notificarLobbyActualizado();
  registrarLog(req.cliente, `/mesa/${id}/iniciar`, 200);
  res.json({ ok: true });

  emitirEstadoPersonalizado(id);
});

// Ruta: abandonar una mesa (se levanta si está esperando, o se retira de la mano si ya está en curso)
app.post('/mesa/:id/salir', (req, res) => {
  const { id } = req.params;
  const { token } = req.body;

  const mesa = partidas[id];
  if (!mesa) {
    return res.status(404).json({ error: 'Mesa no encontrada' });
  }

  const idJugador = jugadorPorToken(id, token);
  if (!idJugador) {
    return res.status(401).json({ error: 'Token inválido o ausente' });
  }

  const jugador = mesa.jugadores.find(j => j.id === idJugador);
  if (!jugador) {
    return res.status(404).json({ error: 'Jugador no encontrado en esta mesa' });
  }

  if (mesa.estado === 'esperando') {
    mesa.jugadores = mesa.jugadores.filter(j => j.id !== idJugador);
    notificarPago(mesa, { ...jugador, fichas: mesa.fichasIniciales });

    if (mesa.jugadores.length === 0) {
      delete partidas[id];
      delete tokensPorPartida[id];
      notificarLobbyActualizado();
      registrarLog(req.cliente, `/mesa/${id}/salir`, 200);
      return res.json({ ok: true, mesaEliminada: true });
    }

  } else {
    const faseDeApuestas = ['preflop', 'flop', 'turn', 'river'].includes(mesa.fase);

    if (faseDeApuestas && jugador.activo) {
      const esSuTurno = mesa.jugadores[mesa.turnoActual] &&
                         mesa.jugadores[mesa.turnoActual].id === idJugador;

      if (esSuTurno) {
        cancelarTemporizadorTurno(id);
        procesarAccion(mesa, 'fold');
        procesarTurnosBot(id);
      } else {
        jugador.activo = false;

        const activos = mesa.jugadores.filter(j => j.activo);
        if (activos.length === 1) {
          mesa.fase = 'showdown';
          const ganador = activos[0];
          const montoGanado = mesa.pozo;
          mesa.ganador = {
            jugador: ganador.id,
            evaluacion: { rango: 0, nombre: 'Los demás se retiraron', cartas: ganador.cartas }
          };
          ganador.fichas += mesa.pozo;
          mesa.pozo = 0;

          guardarHistorialMano(mesa.id, {
            tipo: 'retiro',
            ganador: mesa.ganador,
            monto: montoGanado
          });

          programarSiguienteMano(mesa.id);
        }
      }
    }

   jugador.enJuego = false;
    notificarPago(mesa, jugador);
  }

  delete tokensPorPartida[id][token];
  guardarPartida(id);
  notificarLobbyActualizado();

  registrarLog(req.cliente, `/mesa/${id}/salir`, 200);
  res.json({ ok: true });

  emitirEstadoPersonalizado(id);
});

const NOMBRES_BOTS = [
  'Carlos', 'Miguel', 'Jose', 'Luis', 'Pedro', 'Diego', 'Andres', 'Fernando',
  'Ricardo', 'Sergio', 'Manuel', 'Alejandro', 'Rafael', 'Eduardo', 'Gabriel', 'Antonio'
];

function nombresAleatorios(cantidad) {
  const copia = [...NOMBRES_BOTS];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia.slice(0, cantidad);
}

// Ruta: crear una nueva partida con estado persistente
app.post('/partida/nueva', (req, res) => {
  const numJugadores = req.body.jugadores || 3;
  const soloParaTesting = req.body.soloParaTesting || false;
  const apuestaMinima = 50;

  const mazo = barajar(crearMazo());
  const manos = repartir(mazo, numJugadores, 2);
  const mazoRestante = mazo.slice(numJugadores * 2);
  const tablero = repartirTablero(mazoRestante);

  const nombresBots = nombresAleatorios(numJugadores - 1);
  let indiceNombreBot = 0;

  const jugadores = manos.map((cartas, index) => ({
    id: index + 1,
    nombre: (soloParaTesting && index !== 0) ? nombresBots[indiceNombreBot++] : undefined,
    cartas: cartas,
    fichas: 1000,
    apuestaActual: 0,
    totalApostado: 0,
    activo: true,
    enJuego: true,
    esBot: soloParaTesting && index !== 0
  }));

  // Ciega pequeña y ciega grande automáticas (jugadores 0 y 1 al arrancar)
  jugadores[0].fichas -= apuestaMinima / 2;
  jugadores[0].apuestaActual = apuestaMinima / 2;
  jugadores[0].totalApostado = apuestaMinima / 2;
  jugadores[1].fichas -= apuestaMinima;
  jugadores[1].apuestaActual = apuestaMinima;
  jugadores[1].totalApostado = apuestaMinima;

  const id = generarId();

  const tokens = {};
  const tokensPorJugador = {};
  jugadores.forEach(j => {
    const token = generarToken();
    tokens[token] = j.id;
    tokensPorJugador[j.id] = token;
  });
  tokensPorPartida[id] = tokens;

  partidas[id] = {
    id,
    jugadores,
    tablero,
    pozo: apuestaMinima + apuestaMinima / 2,
    turnoActual: 2 % numJugadores,
    fase: 'preflop',
    apuestaMinima,
    apuestaMaxima: null, // null = No Limit. Poner un número acá activaría el tope (Limit/Pot-Limit) por mesa.
    apuestaRonda: apuestaMinima,
    accionesDesdeSubida: 0,
    ultimoAgresor: null,
    // El dealer "inicial" es el último jugador, así la próxima rotación
    // empieza limpia desde el jugador 0
    indiceDealer: numJugadores - 1
  };
  guardarPartida(id);

  registrarLog(req.cliente, '/partida/nueva', 200);
  res.json({
    id,
    estado: partidas[id],
    tokens: tokensPorJugador // el operador le entrega a cada usuario real solo el suyo
  });

  procesarTurnosBot(id);
});

// Ruta: ejecutar una acción en una partida existente
app.post('/partida/:id/accion', (req, res) => {
  const { id } = req.params;
  const { accion, monto, token } = req.body;

  const partida = partidas[id];

  if (!partida) {
    return res.status(404).json({ error: 'Partida no encontrada' });
  }

  const idJugadorDelToken = jugadorPorToken(id, token);

  if (!idJugadorDelToken) {
    registrarLog(req.cliente, `/partida/${id}/accion`, 401);
    return res.status(401).json({ error: 'Token inválido o ausente' });
  }

  const jugadorDeTurno = partida.jugadores[partida.turnoActual];

  if (jugadorDeTurno.id !== idJugadorDelToken) {
    registrarLog(req.cliente, `/partida/${id}/accion`, 403);
    return res.status(403).json({ error: 'No es tu turno' });
  }

  const resultado = procesarAccion(partida, accion, monto);

  if (resultado && resultado.error) {
    registrarLog(req.cliente, `/partida/${id}/accion`, 400);
    return res.status(400).json(resultado);
  }

  cancelarTemporizadorTurno(id);
  procesarTurnosBot(id);

  registrarLog(req.cliente, `/partida/${id}/accion`, 200);
  emitirEstadoPersonalizado(id);
  res.json({ id, estado: filtrarEstadoParaJugador(partida, idJugadorDelToken) });
});

// Ruta: jugar una partida completa
app.post('/partida', (req, res) => {
  const numJugadores = req.body.jugadores || 3;

  const mazo          = barajar(crearMazo());
  const manos         = repartir(mazo, numJugadores, 2);
  const mazoRestante  = mazo.slice(numJugadores * 2);
  const tablero       = repartirTablero(mazoRestante);
  const cartasTablero = [...tablero.flop, tablero.turn, tablero.river];
  const resultado     = determinarGanador(manos, cartasTablero);

  const jugadores = manos.map((cartas, index) => ({
    jugador: index + 1,
    cartas: cartas,
    fichas: 1000
  }));

  registrarLog(req.cliente, '/partida', 200);
  res.json({ tablero, resultado, jugadores });
});

// Ruta: evaluar una mano específica
app.post('/mano', (req, res) => {
  const { cartasJugador, cartasTablero } = req.body;

  if (!cartasJugador || !cartasTablero) {
    return res.status(400).json({
      error: 'Se requieren cartasJugador y cartasTablero'
    });
  }

  const resultado = evaluarMano(cartasJugador, cartasTablero);

  registrarLog(req.cliente, '/mano', 200);
  res.json({ resultado });
});

// Ruta: obtener un mazo barajado
app.get('/mazo', (req, res) => {
  const mazo = barajar(crearMazo());

  registrarLog(req.cliente, '/mazo', 200);
  res.json({ mazo, total: mazo.length });
});

// Ruta: ver todos los logs (para el panel admin)
app.get('/admin/logs', (req, res) => {
  res.json({ total: logs.length, logs });
});

app.get('/admin/estadisticas', autenticar, async (req, res) => {
  try {
    const totalManos = await pool.query('SELECT COUNT(*) FROM historial_manos');
    const totalPartidas = await pool.query('SELECT COUNT(*) FROM partidas');
    const resultados = await pool.query('SELECT resultado FROM historial_manos');

    let dineroTotal = 0;
    resultados.rows.forEach(fila => {
      const r = fila.resultado;
      if (r.tipo === 'retiro') {
        dineroTotal += r.monto || 0;
      } else if (r.tipo === 'showdown' && Array.isArray(r.ganadores)) {
        r.ganadores.forEach(bote => {
          dineroTotal += bote.monto || 0;
        });
      }
    });

    res.json({
      manosJugadas: Number(totalManos.rows[0].count),
      partidasRegistradas: Number(totalPartidas.rows[0].count),
      dineroTotalMovido: dineroTotal
    });
  } catch (error) {
    console.error('Error en /admin/estadisticas:', error.message);
    res.status(500).json({ error: 'Error calculando estadísticas' });
  }
});

app.get('/admin/historial', autenticar, async (req, res) => {
  try {
    const limite = Math.min(Number(req.query.limite) || 50, 200);

    const resultado = await pool.query(
      'SELECT id, partida_id, resultado, jugado_en FROM historial_manos ORDER BY jugado_en DESC LIMIT $1',
      [limite]
    );

    const manos = resultado.rows.map(fila => {
      const r = fila.resultado;
      let monto = 0;
      let ganadores = [];

      if (r.tipo === 'retiro') {
        monto = r.monto || 0;
        ganadores = [r.ganador?.jugador];
      } else if (r.tipo === 'showdown' && Array.isArray(r.ganadores)) {
        r.ganadores.forEach(bote => {
          monto += bote.monto || 0;
          ganadores.push(...bote.ganadores);
        });
      }

      return {
        id: fila.id,
        partidaId: fila.partida_id,
        tipo: r.tipo,
        ganadores,
        monto,
        fecha: fila.jugado_en
      };
    });

    res.json({ total: manos.length, manos });
  } catch (error) {
    console.error('Error en /admin/historial:', error.message);
    res.status(500).json({ error: 'Error obteniendo historial' });
  }
});

// Ruta: listar las mesas activas para el lobby
app.get('/mesas', autenticar, (req, res) => {
  const mesas = Object.values(partidas)
    .filter(p => p.estado === 'esperando' || p.estado === 'jugando')
    .map(p => ({
      id: p.id,
      estado: p.estado,
      asientosOcupados: p.jugadores.filter(j => j.enJuego !== false).length,
      moneda: p.moneda || 'USD',
      asientosMax: p.asientosMax,
      apuestaMinima: p.apuestaMinima,
      nombresJugadores: p.jugadores.filter(j => j.enJuego !== false).map(j => j.nombre)
    }));

  registrarLog(req.cliente, '/mesas', 200);
  res.json({ mesas });
});

app.get('/plataforma', autenticar, (req, res) => {
  res.json({ nombre: `${req.cliente} Poker` });
});

// Ruta admin: ver los jugadores de una mesa con sus fichas (incluye bots)
app.get('/admin/mesa/:id/jugadores', autenticar, (req, res) => {
  const mesa = partidas[req.params.id];
  if (!mesa) {
    return res.status(404).json({ error: 'Mesa no encontrada' });
  }
  const jugadores = mesa.jugadores.map(j => ({
    id: j.id,
    nombre: j.nombre,
    fichas: j.fichas,
    esBot: j.esBot,
    enJuego: j.enJuego !== false
  }));
  res.json({ jugadores });
});

// Ruta admin: ajustar manualmente las fichas de un jugador
app.post('/admin/mesa/:id/jugador/:jugadorId/fichas', autenticar, (req, res) => {
  const mesa = partidas[req.params.id];
  if (!mesa) {
    return res.status(404).json({ error: 'Mesa no encontrada' });
  }
  const jugadorId = Number(req.params.jugadorId);
  const jugador = mesa.jugadores.find(j => j.id === jugadorId);
  if (!jugador) {
    return res.status(404).json({ error: 'Jugador no encontrado' });
  }
  const nuevoMonto = Number(req.body.fichas);
  if (!Number.isFinite(nuevoMonto) || nuevoMonto < 0) {
    return res.status(400).json({ error: 'Monto inválido' });
  }
  jugador.fichas = nuevoMonto;
  guardarPartida(req.params.id);
  notificarLobbyActualizado();
  emitirEstadoPersonalizado(req.params.id);
  registrarLog(req.cliente, `/admin/mesa/${req.params.id}/jugador/${jugadorId}/fichas`, 200);
  res.json({ ok: true, jugador: { id: jugador.id, fichas: jugador.fichas } });
});

// Ruta admin: borrar una mesa por completo (memoria y base de datos)
app.post('/admin/mesa/:id/eliminar', autenticar, async (req, res) => {
  const { id } = req.params;
  if (!partidas[id]) {
    return res.status(404).json({ error: 'Mesa no encontrada' });
  }
  delete partidas[id];
  delete tokensPorPartida[id];

  try {
    await pool.query('DELETE FROM partidas WHERE id = $1', [id]);
  } catch (error) {
    console.error('Error eliminando mesa de la BD:', error.message);
  }

  notificarLobbyActualizado();
  registrarLog(req.cliente, `/admin/mesa/${id}/eliminar`, 200);
  res.json({ ok: true });
});

// Ruta de PRUEBA: simula el endpoint que la casa de apuestas usaría para
// recibir el aviso de cuántas fichas le quedaron a un jugador al salir.
app.post('/webhook-test/recibir-pago', (req, res) => {
  console.log('💰 Webhook de pago recibido:', JSON.stringify(req.body));
  res.json({ recibido: true });
});

const PORT = process.env.PORT || 3000;

io.on('connection', (socket) => {
  console.log('Cliente conectado por WebSocket:', socket.id);

  socket.on('unirse', (partidaId, token) => {
    const idJugador = jugadorPorToken(partidaId, token);

    if (!idJugador) {
      console.log(`Socket ${socket.id} intentó unirse a ${partidaId} con token inválido`);
      socket.emit('errorUnirse', { error: 'Token inválido o ausente' });
      return;
    }

    socket.join(partidaId);
    socket.data.partidaId = partidaId;
    socket.data.jugadorId = idJugador;
    console.log(`Socket ${socket.id} se unió a partida ${partidaId} como jugador ${idJugador}`);

    const partida = partidas[partidaId];
    if (partida) {
      socket.emit('estadoActualizado', filtrarEstadoParaJugador(partida, idJugador));
    }
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
  });
});

cargarPartidasGuardadas()
  .then(() => {
    servidor.listen(PORT, () => {
      console.log(`Servidor corriendo en el puerto ${PORT}`);
    });
  })
  .catch(error => {
    console.error('Error cargando partidas guardadas:', error.message);
    servidor.listen(PORT, () => {
      console.log(`Servidor corriendo en el puerto ${PORT} (sin recuperar partidas)`);
    });
  });