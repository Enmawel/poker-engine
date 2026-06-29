const palos = ['♠', '♥', '♦', '♣'];

const valores = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

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

const mazo = barajar(crearMazo());
console.log('Total de cartas:', mazo.length);
console.log('Primera carta:', mazo[0]);
console.log('Última carta:', mazo[mazo.length - 1]);

function repartir(mazo, numJugadores, cartasPorJugador) {
  const m = [...mazo];        // copiamos el mazo para no modificar el original
  const jugadores = [];       // aquí guardaremos las manos de cada jugador

  for (let i = 0; i < numJugadores; i++) {
    const mano = [];          // la mano de este jugador

    for (let j = 0; j < cartasPorJugador; j++) {
      mano.push(m.shift());   // toma la primera carta del mazo y la pone en la mano
    }

    jugadores.push(mano);     // agrega la mano completa al array de jugadores
  }

  return jugadores;
}

// Probamos con 3 jugadores, 2 cartas cada uno
const manos = repartir(mazo, 3, 2);
console.log('Manos repartidas:', manos);

function repartirTablero(mazo) {
  const m = [...mazo];

  return {
    flop: [ m.shift(), m.shift(), m.shift() ],
    turn: m.shift(),
    river: m.shift()
  };
}

// Probamos
const tablero = repartirTablero(mazo);
console.log('Tablero:', tablero);
  
