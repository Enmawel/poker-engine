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

// Proteger todas las rutas excepto / y /admin/logs
app.use('/partida', autenticar);
app.use('/mano', autenticar);
app.use('/mazo', autenticar);

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

    io.to(id).emit('estadoActualizado', partida);

    procesarTurnosBot(id);
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
    partida.ganador = {
      jugador: ganador.id,
      evaluacion: { rango: 0, nombre: 'Los demás se retiraron', cartas: ganador.cartas }
    };
    ganador.fichas += partida.pozo;
    partida.pozo = 0;

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

// Si le toca el turno a un bot, espera un momento y actúa solo. Se encadena
// automáticamente si el siguiente turno también es de otro bot.
function procesarTurnosBot(id) {
  const partida = partidas[id];
  if (!partida) return;
  if (partida.fase === 'showdown' || partida.fase === 'terminado') return;

  const jugadorActual = partida.jugadores[partida.turnoActual];
  if (!jugadorActual || !jugadorActual.esBot) return;

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

    io.to(id).emit('estadoActualizado', partidaActual);

    procesarTurnosBot(id);
  }, 1500);
}

// Ruta: verificar que el servidor vive
app.get('/', (req, res) => {
  res.json({ mensaje: 'Motor de Poker funcionando 🃏' });
});

// Ruta: obtener el estado de una partida existente
app.get('/partida/:id', (req, res) => {
  const { id } = req.params;
  const partida = partidas[id];

  if (!partida) {
    return res.status(404).json({ error: 'Partida no encontrada' });
  }

  registrarLog(req.cliente, `/partida/${id}`, 200);
  res.json({ id, estado: partida });
});

// Ruta: crear una nueva partida con estado persistente
app.post('/partida/nueva', (req, res) => {
  const numJugadores = req.body.jugadores || 3;
  const soloParaTesting = req.body.soloParaTesting || false;
  const apuestaMinima = 50;

  const mazo = barajar(crearMazo());
  const manos = repartir(mazo, numJugadores, 2);
  const mazoRestante = mazo.slice(numJugadores * 2);
  const tablero = repartirTablero(mazoRestante);

  const jugadores = manos.map((cartas, index) => ({
    id: index + 1,
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

  registrarLog(req.cliente, '/partida/nueva', 200);
  res.json({
    id,
    estado: partidas[id]
  });

  procesarTurnosBot(id);
});

// Ruta: ejecutar una acción en una partida existente
app.post('/partida/:id/accion', (req, res) => {
  const { id } = req.params;
  const { accion, monto } = req.body;

  const partida = partidas[id];

  if (!partida) {
    return res.status(404).json({ error: 'Partida no encontrada' });
  }

  const resultado = procesarAccion(partida, accion, monto);

  if (resultado && resultado.error) {
    registrarLog(req.cliente, `/partida/${id}/accion`, 400);
    return res.status(400).json(resultado);
  }

  registrarLog(req.cliente, `/partida/${id}/accion`, 200);
  io.to(id).emit('estadoActualizado', partida);
  res.json({ id, estado: partida });

  procesarTurnosBot(id);
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

const PORT = process.env.PORT || 3000;

io.on('connection', (socket) => {
  console.log('Cliente conectado por WebSocket:', socket.id);

  socket.on('unirse', (partidaId) => {
    socket.join(partidaId);
    console.log(`Socket ${socket.id} se unió a partida ${partidaId}`);
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
  });
});

servidor.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});