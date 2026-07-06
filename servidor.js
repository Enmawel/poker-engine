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
  return Math.random().toString(36).substring(2, 9); // ej: "x7k2m9q"
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

const { crearMazo, barajar, repartir, repartirTablero, determinarGanador, evaluarMano } = require('./motor');

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
    activo: true  // false cuando hace fold
  }));

  // Ciega pequeña y ciega grande automáticas
  jugadores[0].fichas -= apuestaMinima / 2;
  jugadores[0].apuestaActual = apuestaMinima / 2;
  jugadores[1].fichas -= apuestaMinima;
  jugadores[1].apuestaActual = apuestaMinima;

  const id = generarId();

  partidas[id] = {
    id,
    jugadores,
    tablero,
    pozo: apuestaMinima + apuestaMinima / 2,
    turnoActual: 0 % numJugadores,
    fase: 'preflop',
    apuestaMinima,
    apuestaMaxima: apuestaMinima * 4,
    apuestaRonda: apuestaMinima,
    accionesDesdeSubida: 0,
    ultimoAgresor: null
  };

  registrarLog(req.cliente, '/partida/nueva', 200);
  res.json({
    id,
    estado: partidas[id]
  });
});

// Ruta: ejecutar una acción en una partida existente
app.post('/partida/:id/accion', (req, res) => {
  const { id } = req.params;
  const { accion, monto } = req.body;

  const partida = partidas[id];

  if (!partida) {
    return res.status(404).json({ error: 'Partida no encontrada' });
  }

  const jugadorActual = partida.jugadores[partida.turnoActual];

  if (accion === 'fold') {
    jugadorActual.activo = false;

  } else if (accion === 'check') {
    const faltante = partida.apuestaRonda - jugadorActual.apuestaActual;
    if (faltante > 0) {
      const aPagar = Math.min(faltante, jugadorActual.fichas);
      jugadorActual.fichas -= aPagar;
      jugadorActual.apuestaActual += aPagar;
      partida.pozo += aPagar;
    }
    partida.accionesDesdeSubida = (partida.accionesDesdeSubida || 0) + 1;

  } else if (accion === 'bet') {
    const incremento = monto || partida.apuestaMinima;
    const nuevoTotal = partida.apuestaRonda + incremento;
    const aPagar = nuevoTotal - jugadorActual.apuestaActual;

    jugadorActual.fichas -= aPagar;
    jugadorActual.apuestaActual = nuevoTotal;
    partida.pozo += aPagar;

    partida.apuestaRonda = nuevoTotal;
    partida.ultimoAgresor = partida.turnoActual;
    partida.accionesDesdeSubida = 1;
  }

  const jugadoresActivos = partida.jugadores.filter(j => j.activo);

  if (jugadoresActivos.length === 1) {
    // Solo queda un jugador — gana automáticamente, sin mostrar cartas
    partida.fase = 'showdown';
    const ganador = jugadoresActivos[0];
    partida.ganador = {
      jugador: ganador.id,
      evaluacion: { rango: 0, nombre: 'Los demás se retiraron', cartas: ganador.cartas }
    };
    ganador.fichas += partida.pozo;
    partida.pozo = 0;

  } else {
    let siguiente = (partida.turnoActual + 1) % partida.jugadores.length;
    while (!partida.jugadores[siguiente].activo) {
      siguiente = (siguiente + 1) % partida.jugadores.length;
    }
    partida.turnoActual = siguiente;

    const todosIgualaron = jugadoresActivos.every(
      j => j.apuestaActual === partida.apuestaRonda
    );
    const accionesCompletas =
      (partida.accionesDesdeSubida || 0) >= jugadoresActivos.length;

    if (todosIgualaron && accionesCompletas) {
      if (partida.fase === 'preflop') partida.fase = 'flop';
      else if (partida.fase === 'flop') partida.fase = 'turn';
      else if (partida.fase === 'turn') partida.fase = 'river';
      else if (partida.fase === 'river') partida.fase = 'showdown';

      if (partida.fase === 'showdown') {
        const cartasTablero = [
          ...partida.tablero.flop,
          partida.tablero.turn,
          partida.tablero.river
        ];

        // Mapeamos por ID real, no por posición, para evitar pagarle al jugador equivocado
        const idsActivos = jugadoresActivos.map(j => j.id);
        const manosActivas = jugadoresActivos.map(j => j.cartas);
        const resultado = determinarGanador(manosActivas, cartasTablero)[0];
        const idGanadorReal = idsActivos[resultado.jugador - 1];

        partida.ganador = { ...resultado, jugador: idGanadorReal };

        const jugadorGanador = partida.jugadores.find(j => j.id === idGanadorReal);
        jugadorGanador.fichas += partida.pozo;
        partida.pozo = 0;
      }

      partida.jugadores.forEach(j => j.apuestaActual = 0);
      partida.apuestaRonda = 0;
      partida.accionesDesdeSubida = 0;
      partida.ultimoAgresor = null;
    }
  }

  registrarLog(req.cliente, `/partida/${id}/accion`, 200);
  io.to(id).emit('estadoActualizado', partida);
  res.json({ id, estado: partida });
});

// Ruta: jugar una partida completa
app.post('/partida', (req, res) => {
  const numJugadores = req.body.jugadores || 3;

  const mazo          = barajar(crearMazo());
  const manos         = repartir(mazo, numJugadores, 2);
  const mazoRestante  = mazo.slice(numJugadores * 2); // saltamos las cartas ya repartidas
  const tablero       = repartirTablero(mazoRestante);
  const cartasTablero = [...tablero.flop, tablero.turn, tablero.river];
  const resultado     = determinarGanador(manos, cartasTablero);

  // Construimos jugadores con sus cartas y datos básicos
  const jugadores = manos.map((cartas, index) => ({
    jugador: index + 1,
    cartas: cartas,
    fichas: 1000  // fichas iniciales por defecto
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