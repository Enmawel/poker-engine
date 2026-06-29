// ============================================
// MOTOR DE POKER - Poker Engine
// ============================================

// --- DATOS BASE ---
const palos  = ['♠', '♥', '♦', '♣'];
const valores = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

// --- FUNCIONES ---
function crearMazo() {
  const mazo = [];
  for (const palo of palos) {
    for (const valor of valores) {
      mazo.push({ valor, palo });
    }
  }
  return mazo;
}

function barajar(mazo) {
  const m = [...mazo];
  for (let i = m.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [m[i], m[j]] = [m[j], m[i]];
  }
  return m;
}

function repartir(mazo, numJugadores, cartasPorJugador) {
  const m = [...mazo];
  const jugadores = [];
  for (let i = 0; i < numJugadores; i++) {
    const mano = [];
    for (let j = 0; j < cartasPorJugador; j++) {
      mano.push(m.shift());
    }
    jugadores.push(mano);
  }
  return jugadores;
}

function repartirTablero(mazo) {
  const m = [...mazo];
  return {
    flop:  [ m.shift(), m.shift(), m.shift() ],
    turn:  m.shift(),
    river: m.shift()
  };
}

function valorNumerico(carta) {
  const tabla = { 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
  if (tabla[carta.valor]) return tabla[carta.valor];
  return parseInt(carta.valor);
}

function ordenarCartas(cartas) {
  return [...cartas].sort((a, b) => valorNumerico(b) - valorNumerico(a));
}

function tieneColor(cartas) {
  const porPalo = {};
  for (const carta of cartas) {
    if (!porPalo[carta.palo]) porPalo[carta.palo] = [];
    porPalo[carta.palo].push(carta);
  }
  for (const palo in porPalo) {
    if (porPalo[palo].length >= 5) {
      return ordenarCartas(porPalo[palo]).slice(0, 5);
    }
  }
  return null;
}

function tieneEscalera(cartas) {
  const ordenadas = ordenarCartas(cartas);
  const sinDuplicados = ordenadas.filter((carta, index, arr) =>
    index === 0 || valorNumerico(carta) !== valorNumerico(arr[index - 1])
  );
  for (let i = 0; i <= sinDuplicados.length - 5; i++) {
    const cinco = sinDuplicados.slice(i, i + 5);
    const esConsecutiva = cinco.every((carta, j) =>
      j === 0 || valorNumerico(cinco[j - 1]) - valorNumerico(carta) === 1
    );
    if (esConsecutiva) return cinco;
  }
  const vals = sinDuplicados.map(c => valorNumerico(c));
  if (vals.includes(14) && vals.includes(2) &&
      vals.includes(3) && vals.includes(4) && vals.includes(5)) {
    return sinDuplicados.filter(c => [14,2,3,4,5].includes(valorNumerico(c))).slice(0, 5);
  }
  return null;
}

function contarGrupos(cartas) {
  const conteo = {};
  for (const carta of cartas) {
    const v = valorNumerico(carta);
    if (!conteo[v]) conteo[v] = [];
    conteo[v].push(carta);
  }
  return Object.values(conteo).sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return valorNumerico(b[0]) - valorNumerico(a[0]);
  });
}

function evaluarMano(cartasJugador, cartasTablero) {
  const todas = [...cartasJugador, ...cartasTablero];
  const grupos = contarGrupos(todas);
  const g  = grupos[0].length;
  const g2 = grupos[1] ? grupos[1].length : 0;

  const color = tieneColor(todas);
  if (color) {
    const escColor = tieneEscalera(color);
    if (escColor) {
      const esReal = valorNumerico(escColor[0]) === 14 && valorNumerico(escColor[4]) === 10;
      return {
        rango: esReal ? 10 : 9,
        nombre: esReal ? 'Escalera Real' : 'Escalera de Color',
        cartas: escColor
      };
    }
  }

  if (g === 4) return { rango: 8, nombre: 'Póker',      cartas: grupos.flat().slice(0, 5) };
  if (g === 3 && g2 === 2) return { rango: 7, nombre: 'Full House', cartas: grupos.flat().slice(0, 5) };
  if (color)   return { rango: 6, nombre: 'Color',      cartas: color };

  const escalera = tieneEscalera(todas);
  if (escalera) return { rango: 5, nombre: 'Escalera',  cartas: escalera };

  if (g === 3) return { rango: 4, nombre: 'Trío',       cartas: grupos.flat().slice(0, 5) };
  if (g === 2 && g2 === 2) return { rango: 3, nombre: 'Doble Par', cartas: grupos.flat().slice(0, 5) };
  if (g === 2) return { rango: 2, nombre: 'Par',        cartas: grupos.flat().slice(0, 5) };

  return { rango: 1, nombre: 'Carta Alta', cartas: ordenarCartas(todas).slice(0, 5) };
}

function determinarGanador(manos, cartasTablero) {
  const resultados = manos.map((mano, index) => ({
    jugador: index + 1,
    evaluacion: evaluarMano(mano, cartasTablero)
  }));

  resultados.sort((a, b) => {
    if (b.evaluacion.rango !== a.evaluacion.rango) {
      return b.evaluacion.rango - a.evaluacion.rango;
    }
    for (let i = 0; i < 5; i++) {
      const valA = valorNumerico(a.evaluacion.cartas[i]);
      const valB = valorNumerico(b.evaluacion.cartas[i]);
      if (valB !== valA) return valB - valA;
    }
    return 0;
  });

  return resultados;
}

// --- EXPORTAR FUNCIONES ---
module.exports = {
  crearMazo, barajar, repartir,
  repartirTablero, determinarGanador, evaluarMano
};