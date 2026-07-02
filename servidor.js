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
    turnoActual: 2 % numJugadores,
    apuestaMinima,
    apuestaMaxima: apuestaMinima * 4
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
  const { accion, monto } = req.body; // accion: 'fold' | 'check' | 'bet'

  const partida = partidas[id];

  if (!partida) {
    return res.status(404).json({ error: 'Partida no encontrada' });
  }

  const jugadorActual = partida.jugadores[partida.turnoActual];

  // Procesamos la acción
  if (accion === 'fold') {
    jugadorActual.activo = false;

  } else if (accion === 'check') {
    // No hace nada, solo pasa el turno

  } else if (accion === 'bet') {
    const apuesta = monto || partida.apuestaMinima;
    jugadorActual.fichas -= apuesta;
    jugadorActual.apuestaActual += apuesta;
    partida.pozo += apuesta;
  }

  // Pasamos al siguiente jugador activo
  const jugadoresActivos = partida.jugadores.filter(j => j.activo);

  if (jugadoresActivos.length === 1) {
    // Solo queda un jugador — gana automáticamente
    partida.fase = 'showdown';
  } else {
    // Buscamos el próximo jugador activo
    let siguiente = (partida.turnoActual + 1) % partida.jugadores.length;
    while (!partida.jugadores[siguiente].activo) {
      siguiente = (siguiente + 1) % partida.jugadores.length;
    }
    partida.turnoActual = siguiente;

    // Avanzamos de fase si todos los activos ya apostaron igual
    const apuestaMax = Math.max(...partida.jugadores.map(j => j.apuestaActual));
    const todosIgualaron = jugadoresActivos.every(j => j.apuestaActual === apuestaMax);

    if (todosIgualaron) {
      if (partida.fase === 'preflop') partida.fase = 'flop';
      else if (partida.fase === 'flop') partida.fase = 'turn';
      else if (partida.fase === 'turn') partida.fase = 'river';
      else if (partida.fase === 'river') partida.fase = 'showdown';

      // Reiniciamos apuestas de la ronda
      partida.jugadores.forEach(j => j.apuestaActual = 0);
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