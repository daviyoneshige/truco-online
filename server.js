// ══════════════════════════════════════════════════════════════════
// SERVIDOR DO TRUCO PAULISTA ONLINE
// Node.js + Socket.io
//
// Como funciona: este servidor fica rodando na internet 24h por dia.
// Quando dois jogadores abrem o jogo no navegador, os dois se conectam
// a este servidor. Quando um joga uma carta, o servidor recebe e
// repassa para o outro em tempo real — como um carteiro instantâneo.
// ══════════════════════════════════════════════════════════════════

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' } // permite conexões de qualquer origem
});

// Serve os arquivos estáticos da pasta public/ (o HTML do jogo)
app.use(express.static(path.join(__dirname, 'public')));

// ── CONSTANTES DO JOGO ──────────────────────────────────────────

const VALS   = ['4','5','6','7','Q','J','K','A','2','3'];
const NAIPES = ['O','E','C','P']; // Ouros < Espadas < Copas < Paus

// ── ESTADO GLOBAL: todas as salas ativas ────────────────────────
// Cada sala é um objeto com dois jogadores e o estado completo da partida.
// Usamos um Map para poder buscar salas rapidamente pelo ID.
const salas = new Map();

// ── FILA DE ESPERA ───────────────────────────────────────────────
// Jogadores que ainda não encontraram adversário ficam aqui.
// Quando chega o segundo, criamos uma sala e começamos.
const filaEspera = [];

// ══════════════════════════════════════════════════════════════════
// EVENTOS DE CONEXÃO
// ══════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log('Jogador conectou:', socket.id);

  // ── Jogador quer entrar em uma partida ──
  socket.on('entrar_fila', ({ nome }) => {
    socket.nomeJogador = nome;

    if (filaEspera.length > 0) {
      // Já tem alguém esperando — cria a sala e começa!
      const adversario = filaEspera.shift();
      const salaId = 'sala_' + Date.now();

      // Cada socket entra no "room" da sala (grupo privado do Socket.io)
      socket.join(salaId);
      adversario.join(salaId);

      // Guarda a referência da sala em cada socket para achar depois
      socket.salaId     = salaId;
      adversario.salaId = salaId;
      socket.time       = 't2'; // segundo a chegar é o vermelho
      adversario.time   = 't1'; // primeiro a chegar é o azul

      // Cria o estado inicial da partida
      const estado = criarEstadoInicial(adversario.nomeJogador, socket.nomeJogador);
      salas.set(salaId, estado);

      // Avisa os dois jogadores que a partida começou
      io.to(salaId).emit('partida_iniciada', {
        salaId,
        nomeT1: adversario.nomeJogador,
        nomeT2: socket.nomeJogador
      });

      // Manda o estado inicial do jogo para os dois
      enviarEstado(salaId);

    } else {
      // Ninguém na fila — este jogador espera
      filaEspera.push(socket);
      socket.emit('aguardando_adversario');
      console.log(nome, 'entrou na fila de espera');
    }
  });

  // ── Jogador jogou uma carta ──
  socket.on('jogar_carta', ({ idx }) => {
    const sala = salas.get(socket.salaId);
    if (!sala) return;

    // Verifica se é a vez deste jogador
    if (sala.turno !== socket.time) return;
    if (sala.aguardandoTruco) return;

    const mao = sala.maos[socket.time];
    if (idx < 0 || idx >= mao.length) return;

    // Remove a carta da mão e coloca na mesa
    const carta = mao.splice(idx, 1)[0];
    sala.mesa.push({ time: socket.time, carta });
    sala.turno = socket.time === 't1' ? 't2' : 't1';

    // Se os dois já jogaram, resolve a rodada
    if (sala.mesa.length === 2) {
      resolverRodada(socket.salaId);
    } else {
      enviarEstado(socket.salaId);
    }
  });

  // ── Jogador pediu Truco ──
  socket.on('pedir_truco', () => {
    const sala = salas.get(socket.salaId);
    if (!sala || sala.aguardandoTruco) return;

    const SEQ  = ['nenhum','truco','seis','nove','doze'];
    const VALS_T = { nenhum:1, truco:3, seis:6, nove:9, doze:12 };
    const idx  = SEQ.indexOf(sala.estadoTruco);
    if (idx >= SEQ.length - 1) return;

    const prox = SEQ[idx + 1];
    sala.estadoTruco    = prox;
    sala.valMao         = VALS_T[prox];
    sala.aguardandoTruco = true;
    sala.quemPediuTruco  = socket.time;

    enviarEstado(socket.salaId);
  });

  // ── Adversário aceitou o truco ──
  socket.on('aceitar_truco', () => {
    const sala = salas.get(socket.salaId);
    if (!sala || !sala.aguardandoTruco) return;
    sala.aguardandoTruco = false;
    enviarEstado(socket.salaId);
  });

  // ── Adversário correu do truco ──
  socket.on('correr_truco', () => {
    const sala = salas.get(socket.salaId);
    if (!sala || !sala.aguardandoTruco) return;

    const SEQ    = ['nenhum','truco','seis','nove','doze'];
    const VALS_T = { nenhum:1, truco:3, seis:6, nove:9, doze:12 };
    sala.aguardandoTruco = false;
    const valAnterior = VALS_T[SEQ[SEQ.indexOf(sala.estadoTruco) - 1]];
    sala.pontos[sala.quemPediuTruco] += valAnterior;

    if (!verificarFimJogo(socket.salaId)) {
      setTimeout(() => { novaMao(socket.salaId); enviarEstado(socket.salaId); }, 1500);
    }
    enviarEstado(socket.salaId);
  });

  // ── Mão de onze: jogador respondeu ──
  socket.on('resposta_mao_onze', ({ aceita }) => {
    const sala = salas.get(socket.salaId);
    if (!sala) return;
    const timeOnze = sala.pontos.t1 === 11 ? 't1' : 't2';
    if (!aceita) {
      sala.pontos[timeOnze] += 1;
      if (!verificarFimJogo(socket.salaId)) {
        setTimeout(() => { novaMao(socket.salaId); enviarEstado(socket.salaId); }, 1500);
      }
    }
    sala.aguardandoMaoOnze = false;
    enviarEstado(socket.salaId);
  });

  // ── Jogador desconectou ──
  socket.on('disconnect', () => {
    console.log('Jogador desconectou:', socket.id);

    // Remove da fila de espera se ainda estiver lá
    const idxFila = filaEspera.indexOf(socket);
    if (idxFila !== -1) filaEspera.splice(idxFila, 1);

    // Avisa o adversário que o outro saiu
    if (socket.salaId) {
      io.to(socket.salaId).emit('adversario_desconectou');
      salas.delete(socket.salaId);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// LÓGICA DO JOGO (espelho do front-end, mas rodando no servidor)
// ══════════════════════════════════════════════════════════════════

function criarBaralho() {
  const deck = [];
  for (const v of VALS)
    for (const n of NAIPES)
      deck.push({ valor: v, naipe: n });
  // Embaralha com Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function definirManilha(vira) {
  return VALS[(VALS.indexOf(vira.valor) + 1) % VALS.length];
}

function forca(carta, manilhaVal) {
  if (carta.valor === manilhaVal) return 100 + NAIPES.indexOf(carta.naipe);
  return VALS.indexOf(carta.valor);
}

function criarEstadoInicial(nomeT1, nomeT2) {
  return {
    nomes:    { t1: nomeT1, t2: nomeT2 },
    pontos:   { t1: 0, t2: 0 },
    maos:     { t1: [], t2: [] },
    mesa:     [],
    vira:     null,
    manilha:  '',
    turno:    't1',
    rodGanhas:{ t1: 0, t2: 0 },
    valMao:   1,
    estadoTruco:     'nenhum',
    aguardandoTruco:  false,
    quemPediuTruco:   '',
    vencPrimeiraRod:  '',
    numRodada:        1,
    aguardandoMaoOnze: false,
    fim:      false,
    log:      'Partida iniciada! Boa sorte!'
  };
}

function novaMao(salaId) {
  const sala = salas.get(salaId);
  if (!sala) return;

  const deck = criarBaralho();
  sala.maos.t1 = deck.splice(0, 3);
  sala.maos.t2 = deck.splice(0, 3);
  sala.vira    = deck[0];
  sala.manilha = definirManilha(sala.vira);

  sala.mesa            = [];
  sala.turno           = 't1';
  sala.rodGanhas       = { t1: 0, t2: 0 };
  sala.valMao          = 1;
  sala.estadoTruco     = 'nenhum';
  sala.aguardandoTruco  = false;
  sala.quemPediuTruco   = '';
  sala.vencPrimeiraRod  = '';
  sala.numRodada        = 1;
  sala.aguardandoMaoOnze = false;
}

function resolverRodada(salaId) {
  const sala = salas.get(salaId);
  const p1   = sala.mesa.find(m => m.time === 't1');
  const p2   = sala.mesa.find(m => m.time === 't2');
  const f1   = forca(p1.carta, sala.manilha);
  const f2   = forca(p2.carta, sala.manilha);

  let venc = '';
  if (f1 > f2)      venc = 't1';
  else if (f2 > f1) venc = 't2';

  if (venc) sala.rodGanhas[venc]++;
  if (sala.numRodada === 1) sala.vencPrimeiraRod = venc;

  sala.numRodada++;
  sala.mesa = [];

  if (venc) sala.turno = venc;

  // Verifica se a mão terminou
  const fimMaoResult = checarFimMao(sala);
  if (fimMaoResult !== null) {
    // fimMaoResult é o time vencedor ('t1', 't2') ou '' (empate)
    if (fimMaoResult) {
      sala.pontos[fimMaoResult] += sala.valMao;
      sala.log = (fimMaoResult === 't1' ? sala.nomes.t1 : sala.nomes.t2) + ' venceu a mão! +' + sala.valMao + ' pt(s)';
    } else {
      sala.log = 'Empate total — ninguém pontua.';
    }

    enviarEstado(salaId);
    if (verificarFimJogo(salaId)) return;

    // Verifica mão de onze antes de começar a próxima
    setTimeout(() => {
      if ((sala.pontos.t1 === 11 || sala.pontos.t2 === 11) && sala.pontos.t1 !== sala.pontos.t2) {
        novaMao(salaId);
        sala.valMao = 3;
        sala.aguardandoMaoOnze = true;
        enviarEstado(salaId);
      } else {
        novaMao(salaId);
        enviarEstado(salaId);
      }
    }, 1800);
  } else {
    sala.log = venc ? (sala.nomes[venc] + ' venceu a rodada!') : 'Empate na rodada!';
    enviarEstado(salaId);
  }
}

function checarFimMao(sala) {
  // Retorna o time vencedor, '' para empate, ou null se a mão continua
  if (sala.rodGanhas.t1 >= 2) return 't1';
  if (sala.rodGanhas.t2 >= 2) return 't2';
  if (sala.numRodada > 3) {
    if (sala.rodGanhas.t1 > sala.rodGanhas.t2) return 't1';
    if (sala.rodGanhas.t2 > sala.rodGanhas.t1) return 't2';
    return sala.vencPrimeiraRod || '';
  }
  if (sala.numRodada === 3 && sala.vencPrimeiraRod === '') {
    if (sala.rodGanhas.t1 === 1) return 't1';
    if (sala.rodGanhas.t2 === 1) return 't2';
  }
  return null; // mão continua
}

function verificarFimJogo(salaId) {
  const sala = salas.get(salaId);
  if (sala.pontos.t1 >= 12) { sala.fim = true; sala.vencedor = 't1'; enviarEstado(salaId); return true; }
  if (sala.pontos.t2 >= 12) { sala.fim = true; sala.vencedor = 't2'; enviarEstado(salaId); return true; }
  return false;
}

// Envia o estado atual do jogo para os dois jogadores da sala.
// Cada jogador recebe uma versão "filtrada": ele vê as próprias cartas,
// mas as cartas do adversário chegam como lista de quantidade (não os valores).
function enviarEstado(salaId) {
  const sala = salas.get(salaId);
  if (!sala) return;

  // Para o t1: vê suas cartas, adversário vem como contagem
  io.to(salaId).emit('estado_atualizado', {
    // Mandamos o estado completo; o front-end filtra o que mostrar
    pontos:           sala.pontos,
    nomes:            sala.nomes,
    mesa:             sala.mesa,
    vira:             sala.vira,
    manilha:          sala.manilha,
    turno:            sala.turno,
    rodGanhas:        sala.rodGanhas,
    valMao:           sala.valMao,
    estadoTruco:      sala.estadoTruco,
    aguardandoTruco:  sala.aguardandoTruco,
    quemPediuTruco:   sala.quemPediuTruco,
    aguardandoMaoOnze: sala.aguardandoMaoOnze,
    fim:              sala.fim,
    vencedor:         sala.vencedor || '',
    log:              sala.log,
    // Cada jogador recebe suas próprias cartas completas
    // e apenas a QUANTIDADE de cartas do adversário
    maoT1: sala.maos.t1,
    maoT2: sala.maos.t2,
    qtdAdvT1: sala.maos.t2.length, // quantas cartas o adversário do t1 tem
    qtdAdvT2: sala.maos.t1.length  // quantas cartas o adversário do t2 tem
  });
}

// Inicia o servidor
const PORTA = process.env.PORT || 3000;
server.listen(PORTA, () => {
  console.log('Servidor do Truco rodando na porta', PORTA);
  console.log('Acesse: http://localhost:' + PORTA);
});
