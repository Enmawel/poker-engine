const express = require('express');
const cors = require('cors');
const app     = express();

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// --- SISTEMA DE LOGS ---
const logs = [];

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

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});