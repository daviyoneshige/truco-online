const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const { MongoClient } = require('mongodb');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = process.env.MONGO_URI;
let db;

const PORTA = process.env.PORT || 3000;

// Sobe o servidor IMEDIATAMENTE — não espera o banco
server.listen(PORTA, () => console.log('Servidor rodando na porta', PORTA));

// Conecta ao banco em paralelo
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida! Configure a variável de ambiente no Railway.');
} else {
  MongoClient.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
    .then(client => { db = client.db('truco'); console.log('✅ MongoDB conectado!'); })
    .catch(err => console.error('❌ Erro MongoDB:', err.message));
}

async function getPerfil(nome) {
  let p = await db.collection('perfis').findOne({ nome });
  if (!p) {
    p = { nome, moedas: 1000, vitorias: 0, derrotas: 0, itens: [], backAtual: 'padrao', avatarAtual: '🃏', sequencia: 0, vitoriasMes: 0, mesAtual: '' };
    await db.collection('perfis').insertOne(p);
  }
  return p;
}
async function salvarPerfil(nome, dados) {
  const { _id, ...rest } = dados;
  await db.collection('perfis').updateOne({ nome }, { $set: rest }, { upsert: true });
}
async function getUsuario(nome) { return db.collection('usuarios').findOne({ nome }); }
async function salvarUsuario(nome, senha) {
  await db.collection('usuarios').updateOne({ nome }, { $set: { nome, senha } }, { upsert: true });
}

// ── FILTRO DE CHAT ───────────────────────────────────────────────
const PALAVROES = [
  'puta','viado','cú','cu','buceta','porra','merda','caralho','fodase','foda-se',
  'foder','fuder','otario','otário','idiota','imbecil','cretino','arrombado',
  'babaca','vsf','vtf','vtnc','fdp','filho da puta','vai se foder','desgraça',
  'desgraca','inferno','burro','idiota','estupido','estúpido','lixo','lixão',
  'prostituta','puta merda','kct','kcт','p0rra','m3rda','c4ralho','cu','cú',
  'anum','anun','anu','corno','corna','vadia','safado','safada','nojento','nojenta',
];

function filtrarMensagem(msg) {
  let resultado = msg;
  PALAVROES.forEach(p => {
    const regex = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi');
    resultado = resultado.replace(regex, '*'.repeat(p.length));
  });
  return resultado;
}

// ── ROTAS HTTP ───────────────────────────────────────────────────

// Middleware: verifica se o banco está conectado
app.use('/api', (req, res, next) => {
  if (!db) return res.json({ ok: false, msg: 'Banco de dados ainda conectando, tente em instantes.' });
  next();
});

app.post('/api/cadastrar', async (req, res) => {
  try {
    const { nome, senha } = req.body;
    if (!nome || !senha)  return res.json({ ok: false, msg: 'Preencha todos os campos.' });
    if (senha.length < 4) return res.json({ ok: false, msg: 'Senha muito curta.' });
    if (await getUsuario(nome)) return res.json({ ok: false, msg: 'Usuário já existe!' });
    await salvarUsuario(nome, senha);
    const perfil = await getPerfil(nome);
    res.json({ ok: true, perfil });
  } catch(e) { console.error(e); res.json({ ok: false, msg: 'Erro no servidor.' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { nome, senha } = req.body;
    if (!nome || !senha) return res.json({ ok: false, msg: 'Preencha todos os campos.' });
    const u = await getUsuario(nome);
    if (!u || u.senha !== senha) return res.json({ ok: false, msg: 'Nome ou senha incorretos.' });
    const perfil = await getPerfil(nome);
    res.json({ ok: true, perfil });
  } catch(e) { console.error(e); res.json({ ok: false, msg: 'Erro no servidor.' }); }
});

app.get('/api/perfil/:nome', async (req, res) => {
  try { res.json({ ok: true, perfil: await getPerfil(req.params.nome) }); }
  catch(e) { res.json({ ok: false }); }
});

app.post('/api/perfil/:nome', async (req, res) => {
  try { await salvarPerfil(req.params.nome, req.body); res.json({ ok: true }); }
  catch(e) { res.json({ ok: false }); }
});

app.post('/api/admin/dar-moedas', async (req, res) => {
  try {
    const { adminNome, jogador, qtd } = req.body;
    if (adminNome !== 'davi7') return res.json({ ok: false, msg: 'Sem permissão.' });
    const perfil = await db.collection('perfis').findOne({ nome: jogador });
    if (!perfil) return res.json({ ok: false, msg: 'Jogador "' + jogador + '" não encontrado.' });
    const novoSaldo = perfil.moedas + Number(qtd);
    await db.collection('perfis').updateOne({ nome: jogador }, { $set: { moedas: novoSaldo } });
    res.json({ ok: true, novoSaldo });
  } catch(e) { console.error(e); res.json({ ok: false, msg: 'Erro no servidor.' }); }
});

app.post('/api/admin/dar-item', async (req, res) => {
  try {
    const { adminNome, jogador, itemId } = req.body;
    if (adminNome !== 'davi7') return res.json({ ok: false, msg: 'Sem permissão.' });
    const perfil = await db.collection('perfis').findOne({ nome: jogador });
    if (!perfil) return res.json({ ok: false, msg: 'Jogador "' + jogador + '" não encontrado.' });
    const itens = perfil.itens || [];
    if (itens.includes(itemId)) return res.json({ ok: false, msg: 'Jogador já possui este item.' });
    itens.push(itemId);
    await db.collection('perfis').updateOne({ nome: jogador }, { $set: { itens } });
    res.json({ ok: true });
  } catch(e) { console.error(e); res.json({ ok: false, msg: 'Erro no servidor.' }); }
});

app.get('/api/admin/jogadores', async (req, res) => {
  try {
    if (req.query.admin !== 'davi7') return res.json({ ok: false });
    res.json({ ok: true, perfis: await db.collection('perfis').find({}).toArray() });
  } catch(e) { res.json({ ok: false }); }
});

// Ranking global
app.get('/api/ranking', async (req, res) => {
  try {
    const { nome } = req.query;
    const top10 = await db.collection('perfis')
      .find({}).sort({ vitorias: -1 }).limit(10).toArray();

    let minhaPosicao = null, minhasVitorias = 0;
    if(nome) {
      const todos = await db.collection('perfis').find({}).sort({ vitorias: -1 }).toArray();
      const idx = todos.findIndex(p => p.nome === nome);
      if(idx !== -1) { minhaPosicao = idx + 1; minhasVitorias = todos[idx].vitorias; }
    }
    res.json({ ok: true, top10, minhaPosicao, minhasVitorias });
  } catch(e) { res.json({ ok: false }); }
});

app.get('/api/amigos/:nome', async (req, res) => {
  try {
    const dados = await db.collection('amigos').findOne({ nome: req.params.nome });
    res.json({ ok: true, dados: dados || { nome: req.params.nome, amigos: [], pendentes: [] } });
  } catch(e) { res.json({ ok: false }); }
});

app.post('/api/amigos/:nome', async (req, res) => {
  try {
    const { nome } = req.params;
    const { amigos, pendentes } = req.body;
    await db.collection('amigos').updateOne({ nome }, { $set: { nome, amigos, pendentes } }, { upsert: true });
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

// ── JOGO ─────────────────────────────────────────────────────────

const VALS = ['4','5','6','7','Q','J','K','A','2','3'];
const NAIPES = ['O','E','C','P'];
const salas = new Map();
const filaEspera = [];      // fila 1v1
const fila2v2 = [];         // fila 2v2: [{socketA, socketB}]
const salaLobby2v2 = new Map(); // salaLobbyId -> {lider, parceiro, sockets:[]}

io.on('connection', (socket) => {
  console.log('Conectou:', socket.id);

  // ─── CONVITES ────────────────────────────────────────────
  socket.on('enviar_convite', ({ para }) => {
    const alvo = [...io.sockets.sockets.values()].find(s => s.nomeJogador === para);
    if (alvo) alvo.emit('convite_recebido', { de: socket.nomeJogador });
    else socket.emit('convite_recusado', { por: para + ' (offline)' });
  });

  socket.on('aceitar_convite', ({ de }) => {
    const quemConvidou = [...io.sockets.sockets.values()].find(s => s.nomeJogador === de);
    if (!quemConvidou) return;
    // Cria sala privada entre os dois
    const salaId = 'sala_' + Date.now();
    socket.join(salaId); quemConvidou.join(salaId);
    socket.salaId = salaId; quemConvidou.salaId = salaId;
    socket.time = 't2'; quemConvidou.time = 't1';
    socket.nomeJogador = socket.nomeJogador;
    const estado = criarEstadoInicial(quemConvidou.nomeJogador, socket.nomeJogador);
    estado.backT1 = quemConvidou.backId || 'padrao';
    estado.backT2 = socket.backId || 'padrao';
    salas.set(salaId, estado);
    io.to(salaId).emit('partida_iniciada', {
      salaId, nomeT1: quemConvidou.nomeJogador, nomeT2: socket.nomeJogador
    });
    enviarEstado(salaId);
  });

  socket.on('recusar_convite', ({ de }) => {
    const quemConvidou = [...io.sockets.sockets.values()].find(s => s.nomeJogador === de);
    if (quemConvidou) quemConvidou.emit('convite_recusado', { por: socket.nomeJogador });
  });

  // ─── FILA ────────────────────────────────────────────────
  socket.on('entrar_fila', ({ nome, backId, comBot }) => {
    socket.nomeJogador = nome;
    socket.backId = backId || 'padrao';

    // Modo bot: cria sala direto sem fila
    if (comBot && CONTAS_BOT.includes(nome)) {
      const salaId = 'bot_' + Date.now();
      const botNome = nome + '_BOT';
      socket.join(salaId);
      socket.salaId = salaId;
      socket.time = 't1';
      const estado = criarEstadoInicial(nome, botNome);
      estado.botTime = 't2';
      salas.set(salaId, estado);
      socket.emit('partida_iniciada', { salaId, nomeT1: nome, nomeT2: botNome });
      enviarEstadoBot(salaId, socket);
      return;
    }

    if (filaEspera.length > 0) {
      const adv = filaEspera.shift();
      const salaId = 'sala_' + Date.now();
      socket.join(salaId); adv.join(salaId);
      socket.salaId = salaId; adv.salaId = salaId;
      socket.time = 't2'; adv.time = 't1';
      const estado = criarEstadoInicial(adv.nomeJogador, socket.nomeJogador);
      estado.backT1 = adv.backId || 'padrao';
      estado.backT2 = socket.backId || 'padrao';
      salas.set(salaId, estado);
      io.to(salaId).emit('partida_iniciada', { salaId, nomeT1: adv.nomeJogador, nomeT2: socket.nomeJogador });
      enviarEstado(salaId);
    } else {
      filaEspera.push(socket);
      socket.emit('aguardando_adversario');
    }
  });

  socket.on('jogar_carta', ({ idx }) => {
    const sala = salas.get(socket.salaId);
    if (!sala || sala.aguardandoTruco) return;

    // ─── 2v2 ───
    if (sala.modo === '2v2') {
      const turnoAtual = sala.ordemTurno[sala.turnoIdx];
      if (turnoAtual !== socket.slot) return;
      const mao = sala.maos[socket.slot];
      if (!mao || idx < 0 || idx >= mao.length) return;
      sala.mesa.push({ slot: socket.slot, time: socket.time, carta: mao.splice(idx, 1)[0], nome: socket.nomeJogador });
      sala.turnoIdx = (sala.turnoIdx + 1) % 4;
      if (sala.mesa.length === 4) resolverRodada2v2(socket.salaId);
      else enviarEstado2v2(socket.salaId);
      return;
    }

    // ─── 1v1 ───
    if (sala.turno !== socket.time) return;
    const mao = sala.maos[socket.time];
    if (idx < 0 || idx >= mao.length) return;
    sala.mesa.push({ time: socket.time, carta: mao.splice(idx, 1)[0] });
    sala.turno = socket.time === 't1' ? 't2' : 't1';
    if (sala.mesa.length === 2) {
      if (sala.botTime) resolverRodadaBot(socket.salaId, socket);
      else resolverRodada(socket.salaId);
    } else {
      if (sala.botTime) {
        enviarEstadoBot(socket.salaId, socket);
        setTimeout(() => tickBot(socket.salaId, socket), 1200);
      } else enviarEstado(socket.salaId);
    }
  });

  socket.on('pedir_truco', () => {
    const sala = salas.get(socket.salaId);
    if (!sala || sala.aguardandoTruco) return;
    const SEQ = ['nenhum','truco','seis','nove','doze'];
    const VALS_T = { nenhum:1, truco:3, seis:6, nove:9, doze:12 };
    const idx = SEQ.indexOf(sala.estadoTruco);
    if (idx >= SEQ.length - 1) return;
    const prox = SEQ[idx + 1];
    sala.estadoTruco = prox; sala.valMao = VALS_T[prox];
    sala.aguardandoTruco = true; sala.quemPediuTruco = socket.time;
    sala.log = (socket.nomeJogador || sala.nomes[socket.time]) + ' pediu ' + prox.toUpperCase() + '!';
    if (sala.modo === '2v2') enviarEstado2v2(socket.salaId);
    else if (sala.botTime) { enviarEstadoBot(socket.salaId, socket); setTimeout(() => tickBot(socket.salaId, socket), 1200); }
    else enviarEstado(socket.salaId);
  });

  socket.on('aceitar_truco', () => {
    const sala = salas.get(socket.salaId);
    if (!sala || !sala.aguardandoTruco || socket.time === sala.quemPediuTruco) return;
    sala.aguardandoTruco = false;
    sala.log = 'Truco aceito! Mão vale ' + sala.valMao + ' pt(s).';
    if (sala.modo === '2v2') enviarEstado2v2(socket.salaId);
    else if (sala.botTime) enviarEstadoBot(socket.salaId, socket);
    else enviarEstado(socket.salaId);
  });

  socket.on('correr_truco', () => {
    const sala = salas.get(socket.salaId);
    if (!sala || !sala.aguardandoTruco || socket.time === sala.quemPediuTruco) return;
    const SEQ = ['nenhum','truco','seis','nove','doze'];
    const VALS_T = { nenhum:1, truco:3, seis:6, nove:9, doze:12 };
    sala.aguardandoTruco = false;
    const valAnt = VALS_T[SEQ[SEQ.indexOf(sala.estadoTruco) - 1]];
    sala.pontos[sala.quemPediuTruco] += valAnt;
    sala.log = 'Alguém correu! ' + sala.nomes[sala.quemPediuTruco] + ' ganha ' + valAnt + ' pt(s).';
    if (sala.modo === '2v2') {
      enviarEstado2v2(socket.salaId);
      if (!verificarFimJogo2v2(socket.salaId)) setTimeout(() => { novaMao2v2(socket.salaId); enviarEstado2v2(socket.salaId); }, 1500);
    } else if (sala.botTime) {
      enviarEstadoBot(socket.salaId, socket);
      if (!verificarFimJogoBot(socket.salaId, socket)) setTimeout(() => { novaMao(socket.salaId); enviarEstadoBot(socket.salaId, socket); }, 1500);
    } else {
      enviarEstado(socket.salaId);
      if (!verificarFimJogo(socket.salaId)) setTimeout(() => { novaMao(socket.salaId); enviarEstado(socket.salaId); }, 1500);
    }
  });

  socket.on('resposta_mao_onze', ({ aceita }) => {
    const sala = salas.get(socket.salaId);
    if (!sala) return;
    const tOnze = sala.pontos.t1 === 11 ? 't1' : 't2';
    sala.aguardandoMaoOnze = false;
    const is2v2 = sala.modo === '2v2';
    const isBot = !!sala.botTime;
    const enviar = () => is2v2 ? enviarEstado2v2(socket.salaId) : isBot ? enviarEstadoBot(socket.salaId, socket) : enviarEstado(socket.salaId);
    const novaMaoFn = () => is2v2 ? novaMao2v2(socket.salaId) : novaMao(socket.salaId);
    const fimFn = () => is2v2 ? verificarFimJogo2v2(socket.salaId) : isBot ? verificarFimJogoBot(socket.salaId, socket) : verificarFimJogo(socket.salaId);
    if (!aceita) {
      sala.pontos[tOnze] += 1;
      sala.log = sala.nomes[tOnze] + ' ganha 1 ponto (adversário recusou).';
      enviar();
      if (!fimFn()) setTimeout(() => { novaMaoFn(); enviar(); }, 1500);
    } else {
      sala.log = 'Mão de Onze aceita! Mão vale 3 pontos.';
      enviar();
      if (isBot && sala.turno === sala.botTime) setTimeout(() => tickBot(socket.salaId, socket), 1200);
    }
  });



  socket.on('cancelar_fila', () => {
    const idx = filaEspera.indexOf(socket);
    if (idx !== -1) filaEspera.splice(idx, 1);
    // remove da fila 2v2 também
    const idx2 = fila2v2.findIndex(d => d.sockets.includes(socket));
    if (idx2 !== -1) fila2v2.splice(idx2, 1);
  });

  // ─── 2v2: LÍDER CONVIDA PARCEIRO ─────────────────────────
  socket.on('2v2_convidar_parceiro', ({ para }) => {
    socket.lobbyId = 'lobby_' + Date.now();
    salaLobby2v2.set(socket.lobbyId, { lider: socket, parceiro: null, sockets: [socket] });
    const alvo = [...io.sockets.sockets.values()].find(s => s.nomeJogador === para);
    if (!alvo) { socket.emit('2v2_erro', { msg: para + ' está offline.' }); return; }
    alvo.emit('2v2_convite_parceiro', { de: socket.nomeJogador, lobbyId: socket.lobbyId });
  });

  socket.on('2v2_aceitar_parceiro', ({ lobbyId }) => {
    const lobby = salaLobby2v2.get(lobbyId);
    if (!lobby) return;
    lobby.parceiro = socket;
    lobby.sockets.push(socket);
    socket.lobbyId = lobbyId;
    // Avisa líder que parceiro aceitou
    lobby.lider.emit('2v2_parceiro_aceitou', { nome: socket.nomeJogador });
    socket.emit('2v2_aguardando_adversarios');
    // Entra na fila 2v2
    const dupla = { lobbyId, sockets: lobby.sockets, nomes: [lobby.lider.nomeJogador, socket.nomeJogador] };
    if (fila2v2.length > 0) {
      const adv = fila2v2.shift();
      iniciar2v2(dupla, adv);
    } else {
      fila2v2.push(dupla);
    }
  });

  socket.on('2v2_recusar_parceiro', ({ lobbyId }) => {
    const lobby = salaLobby2v2.get(lobbyId);
    if (lobby) { lobby.lider.emit('2v2_parceiro_recusou', { nome: socket.nomeJogador }); salaLobby2v2.delete(lobbyId); }
  });

  socket.on('2v2_cancelar_lobby', () => {
    if (!socket.lobbyId) return;
    const lobby = salaLobby2v2.get(socket.lobbyId);
    if (lobby) {
      lobby.sockets.forEach(s => s.emit('2v2_lobby_cancelado'));
      salaLobby2v2.delete(socket.lobbyId);
    }
    const idx = fila2v2.findIndex(d => d.lobbyId === socket.lobbyId);
    if (idx !== -1) fila2v2.splice(idx, 1);
    socket.lobbyId = null;
  });

  // ─── CHAT NA PARTIDA ──────────────────────────────────────
  socket.on('chat_partida', ({ salaId, msg }) => {
    if (!salaId || !msg || msg.length > 200) return;
    const sala = salas.get(salaId);
    if (!sala) return;
    const autor = socket.nomeJogador;
    if (!autor) return;
    io.to(salaId).emit('chat_partida', { autor, msg: filtrarMensagem(msg.trim()) });
  });

  // ─── CHAT PRIVADO ─────────────────────────────────────────
  socket.on('msg_privada', ({ para, msg }) => {
    if (!para || !msg || msg.length > 500) return;
    const destino = [...io.sockets.sockets.values()].find(s => s.nomeJogador === para);
    if (destino) {
      destino.emit('msg_privada', { de: socket.nomeJogador, msg: filtrarMensagem(msg.trim()) });
    }
  });

  socket.on('disconnect', () => {
    const idx = filaEspera.indexOf(socket);
    if (idx !== -1) filaEspera.splice(idx, 1);
    if (socket.salaId) { io.to(socket.salaId).emit('adversario_desconectou'); salas.delete(socket.salaId); }
  });
});

function iniciar2v2(duplaA, duplaB) {
  // duplaA = time t1, duplaB = time t2
  // Cada time tem 2 jogadores, cartas são POR TIME (6 cada)
  // Ordem de jogada: t1a, t2a, t1b, t2b (alternado por posição)
  const salaId = '2v2_' + Date.now();
  const [s1a, s1b] = duplaA.sockets; // t1: jogador a e b
  const [s2a, s2b] = duplaB.sockets; // t2: jogador a e b
  const nT1 = duplaA.nomes;
  const nT2 = duplaB.nomes;

  const deck = criarBaralho();
  // 6 cartas por time, 3 pra cada jogador
  const maoT1a = deck.splice(0,3), maoT1b = deck.splice(0,3);
  const maoT2a = deck.splice(0,3), maoT2b = deck.splice(0,3);
  const vira = deck[0];
  const manilha = proximaManilha(vira);

  const estado = {
    modo: '2v2',
    nomes: { t1: nT1[0]+' & '+nT1[1], t2: nT2[0]+' & '+nT2[1] },
    jogadores: { t1a: nT1[0], t1b: nT1[1], t2a: nT2[0], t2b: nT2[1] },
    pontos: { t1: 0, t2: 0 },
    maos: { t1a: maoT1a, t1b: maoT1b, t2a: maoT2a, t2b: maoT2b },
    mesa: [], vira, manilha,
    // Ordem de turno: t1a -> t2a -> t1b -> t2b (rodada)
    ordemTurno: ['t1a','t2a','t1b','t2b'],
    turnoIdx: 0,
    rodGanhas: { t1: 0, t2: 0 },
    valMao: 1, estadoTruco: 'nenhum', aguardandoTruco: false,
    quemPediuTruco: '', vencPrimeiraRod: '', numRodada: 1,
    aguardandoMaoOnze: false, fim: false, vencedor: '', log: 'Partida 2v2 iniciada!',
  };
  salas.set(salaId, estado);

  [[s1a,'t1a'],[s1b,'t1b'],[s2a,'t2a'],[s2b,'t2b']].forEach(([s, slot]) => {
    if (!s) return;
    s.join(salaId); s.salaId = salaId; s.slot = slot;
    s.time = slot.startsWith('t1') ? 't1' : 't2';
  });

  io.to(salaId).emit('2v2_iniciada', {
    salaId,
    jogadores: estado.jogadores,
    nomes: estado.nomes,
  });
  enviarEstado2v2(salaId);
  // Limpa lobbies
  salaLobby2v2.delete(duplaA.lobbyId);
  salaLobby2v2.delete(duplaB.lobbyId);
}

function enviarEstado2v2(salaId) {
  const sala = salas.get(salaId); if (!sala) return;
  const base = {
    pontos: sala.pontos, nomes: sala.nomes, jogadores: sala.jogadores,
    mesa: sala.mesa, vira: sala.vira, manilha: sala.manilha,
    turno: sala.ordemTurno[sala.turnoIdx], rodGanhas: sala.rodGanhas,
    valMao: sala.valMao, estadoTruco: sala.estadoTruco,
    aguardandoTruco: sala.aguardandoTruco, quemPediuTruco: sala.quemPediuTruco,
    aguardandoMaoOnze: sala.aguardandoMaoOnze, fim: sala.fim, vencedor: sala.vencedor,
    log: sala.log,
  };
  io.in(salaId).fetchSockets().then(sockets => {
    sockets.forEach(s => {
      const slot = s.slot;
      const time = slot ? slot.slice(0,2) : 't1';
      const minhasCartas = slot ? sala.maos[slot] : [];
      const parcSlot = slot === 't1a' ? 't1b' : slot === 't1b' ? 't1a' : slot === 't2a' ? 't2b' : 't2a';
      s.emit('estado_atualizado', {
        ...base, meuSlot: slot, meuTime: time,
        minhasCartas,
        qtdParceiro: sala.maos[parcSlot] ? sala.maos[parcSlot].length : 0,
        qtdAdv1: sala.maos[time==='t1'?'t2a':'t1a'] ? sala.maos[time==='t1'?'t2a':'t1a'].length : 0,
        qtdAdv2: sala.maos[time==='t1'?'t2b':'t1b'] ? sala.maos[time==='t1'?'t2b':'t1b'].length : 0,
        backAdversario: 'padrao',
      });
    });
  });
}

function novaMao2v2(salaId) {
  const sala = salas.get(salaId); if (!sala) return;
  const deck = criarBaralho();
  sala.maos.t1a = deck.splice(0,3); sala.maos.t1b = deck.splice(0,3);
  sala.maos.t2a = deck.splice(0,3); sala.maos.t2b = deck.splice(0,3);
  sala.vira = deck[0]; sala.manilha = proximaManilha(sala.vira);
  sala.mesa = []; sala.turnoIdx = 0;
  sala.rodGanhas = {t1:0,t2:0}; sala.valMao = 1; sala.estadoTruco = 'nenhum';
  sala.aguardandoTruco = false; sala.quemPediuTruco = '';
  sala.vencPrimeiraRod = ''; sala.numRodada = 1; sala.aguardandoMaoOnze = false;
}

function resolverRodada2v2(salaId) {
  const sala = salas.get(salaId);
  // Rodada tem 4 cartas (uma de cada jogador)
  if (sala.mesa.length < 4) { enviarEstado2v2(salaId); return; }
  let melhorF = -1, vencSlot = '';
  sala.mesa.forEach(m => {
    const f = forca(m.carta, sala.manilha);
    if (f > melhorF) { melhorF = f; vencSlot = m.slot; }
    else if (f === melhorF) vencSlot = ''; // empate
  });
  const vencTime = vencSlot ? vencSlot.slice(0,2) : '';
  if (vencTime) sala.rodGanhas[vencTime]++;
  if (sala.numRodada === 1) sala.vencPrimeiraRod = vencTime;
  sala.numRodada++; sala.mesa = [];
  // Próxima rodada começa pelo vencedor (ou mantém ordem)
  if (vencSlot) {
    sala.turnoIdx = sala.ordemTurno.indexOf(vencSlot);
    if (sala.turnoIdx === -1) sala.turnoIdx = 0;
  }
  sala.log = vencTime ? (sala.nomes[vencTime] + ' venceu a rodada!') : 'Empate na rodada!';
  const fimRes = checarFimMao(sala);
  if (fimRes !== null) {
    if (fimRes) { sala.pontos[fimRes] += sala.valMao; sala.log = sala.nomes[fimRes] + ' venceu a mão! +' + sala.valMao + ' pt(s)'; }
    else sala.log = 'Empate — ninguém pontua.';
    enviarEstado2v2(salaId);
    if (verificarFimJogo2v2(salaId)) return;
    setTimeout(() => {
      if ((sala.pontos.t1===11||sala.pontos.t2===11)&&sala.pontos.t1!==sala.pontos.t2) {
        novaMao2v2(salaId); sala.valMao=3; sala.aguardandoMaoOnze=true; sala.log='Mão de Onze!';
      } else { novaMao2v2(salaId); sala.log='Nova mão!'; }
      enviarEstado2v2(salaId);
    }, 1800);
  } else enviarEstado2v2(salaId);
}

function verificarFimJogo2v2(salaId) {
  const sala = salas.get(salaId);
  if (sala.pontos.t1 >= 12 || sala.pontos.t2 >= 12) {
    sala.fim = true;
    sala.vencedor = sala.pontos.t1 >= 12 ? 't1' : 't2';
    sala.log = sala.nomes[sala.vencedor] + ' venceu a partida!';
    enviarEstado2v2(salaId);
    verificarConquistas(salaId, sala.vencedor);
    return true;
  }
  return false;
}

function criarBaralho() {
  const deck = [];
  for (const v of VALS) for (const n of NAIPES) deck.push({ valor: v, naipe: n });
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; }
  return deck;
}
function proximaManilha(vira) { return VALS[(VALS.indexOf(vira.valor)+1)%VALS.length]; }
function forca(carta, manilha) { return carta.valor===manilha ? 100+NAIPES.indexOf(carta.naipe) : VALS.indexOf(carta.valor); }

function criarEstadoInicial(nomeT1, nomeT2) {
  const deck = criarBaralho(), maoT1 = deck.splice(0,3), maoT2 = deck.splice(0,3), vira = deck[0];
  return {
    nomes:{t1:nomeT1,t2:nomeT2}, pontos:{t1:0,t2:0}, maos:{t1:maoT1,t2:maoT2},
    mesa:[], vira, manilha:proximaManilha(vira), turno:'t1', rodGanhas:{t1:0,t2:0},
    valMao:1, estadoTruco:'nenhum', aguardandoTruco:false, quemPediuTruco:'',
    vencPrimeiraRod:'', numRodada:1, aguardandoMaoOnze:false, fim:false, vencedor:'',
    log:'Partida iniciada! Boa sorte!'
  };
}

function novaMao(salaId) {
  const sala = salas.get(salaId); if (!sala) return;
  const deck = criarBaralho();
  sala.maos.t1=deck.splice(0,3); sala.maos.t2=deck.splice(0,3); sala.vira=deck[0];
  sala.manilha=proximaManilha(sala.vira); sala.mesa=[]; sala.turno='t1';
  sala.rodGanhas={t1:0,t2:0}; sala.valMao=1; sala.estadoTruco='nenhum';
  sala.aguardandoTruco=false; sala.quemPediuTruco=''; sala.vencPrimeiraRod='';
  sala.numRodada=1; sala.aguardandoMaoOnze=false;
}

function resolverRodada(salaId) {
  const sala = salas.get(salaId);
  const p1=sala.mesa.find(m=>m.time==='t1'), p2=sala.mesa.find(m=>m.time==='t2');
  const f1=forca(p1.carta,sala.manilha), f2=forca(p2.carta,sala.manilha);
  let venc='';
  if (f1>f2) venc='t1'; else if (f2>f1) venc='t2';
  if (venc) sala.rodGanhas[venc]++;
  if (sala.numRodada===1) sala.vencPrimeiraRod=venc;
  sala.numRodada++; sala.mesa=[]; if (venc) sala.turno=venc;
  sala.log = venc ? (sala.nomes[venc]+' venceu a rodada!') : 'Empate na rodada!';
  const fimRes = checarFimMao(sala);
  if (fimRes !== null) {
    if (fimRes) { sala.pontos[fimRes]+=sala.valMao; sala.log=sala.nomes[fimRes]+' venceu a mão! +'+sala.valMao+' pt(s)'; }
    else sala.log='Empate total — ninguém pontua.';
    enviarEstado(salaId);
    if (verificarFimJogo(salaId)) return;
    setTimeout(() => {
      if ((sala.pontos.t1===11||sala.pontos.t2===11)&&sala.pontos.t1!==sala.pontos.t2) {
        novaMao(salaId); sala.valMao=3; sala.aguardandoMaoOnze=true; sala.log='Mão de Onze!';
      } else { novaMao(salaId); sala.log='Nova mão!'; }
      enviarEstado(salaId);
    }, 1800);
  } else enviarEstado(salaId);
}

function checarFimMao(sala) {
  if (sala.rodGanhas.t1>=2) return 't1'; if (sala.rodGanhas.t2>=2) return 't2';
  if (sala.numRodada>3) { if(sala.rodGanhas.t1>sala.rodGanhas.t2) return 't1'; if(sala.rodGanhas.t2>sala.rodGanhas.t1) return 't2'; return sala.vencPrimeiraRod||''; }
  if (sala.numRodada===3&&sala.vencPrimeiraRod==='') { if(sala.rodGanhas.t1===1) return 't1'; if(sala.rodGanhas.t2===1) return 't2'; }
  return null;
}

function verificarFimJogo(salaId) {
  const sala = salas.get(salaId);
  if (sala.pontos.t1>=12) { sala.fim=true; sala.vencedor='t1'; enviarEstado(salaId); verificarConquistas(salaId,'t1'); return true; }
  if (sala.pontos.t2>=12) { sala.fim=true; sala.vencedor='t2'; enviarEstado(salaId); verificarConquistas(salaId,'t2'); return true; }
  return false;
}

async function verificarConquistas(salaId, vencedor) {
  if (!db) return;
  const sala = salas.get(salaId);
  if (!sala) return;
  const perdedor = vencedor === 't1' ? 't2' : 't1';
  const nomeVencedor = sala.nomes[vencedor];
  const nomePerdedor = sala.nomes[perdedor];

  // ─── Título: Matei o Criador ───
  if (nomePerdedor === 'davi7') {
    const p = await db.collection('perfis').findOne({ nome: nomeVencedor });
    if (p && !(p.itens||[]).includes('excl_titulo_matador')) {
      await db.collection('perfis').updateOne({ nome: nomeVencedor }, { $push: { itens: 'excl_titulo_matador' } });
      console.log('💀 ' + nomeVencedor + ' ganhou "Matei o Criador"!');
    }
  }

  // ─── Título: Invicto (10 vitórias seguidas) ───
  const pVenc = await db.collection('perfis').findOne({ nome: nomeVencedor });
  const pPerd = await db.collection('perfis').findOne({ nome: nomePerdedor });

  if (pVenc) {
    const novaSeq = (pVenc.sequencia || 0) + 1;
    const updates = { sequencia: novaSeq };
    if (novaSeq >= 10 && !(pVenc.itens||[]).includes('excl_titulo_invicto')) {
      updates['$push'] = { itens: 'excl_titulo_invicto' };
      console.log('⚡ ' + nomeVencedor + ' ganhou "Invicto"!');
    }
    // Atualizar vitórias do mês
    const mesAtual = new Date().toISOString().slice(0,7); // "2026-03"
    const vitoriasMes = pVenc.mesAtual === mesAtual ? (pVenc.vitoriasMes || 0) + 1 : 1;
    updates.sequencia = novaSeq;
    updates.vitoriasMes = vitoriasMes;
    updates.mesAtual = mesAtual;
    if (updates['$push']) {
      const push = updates['$push'];
      delete updates['$push'];
      await db.collection('perfis').updateOne({ nome: nomeVencedor }, { $set: updates, $push: push });
    } else {
      await db.collection('perfis').updateOne({ nome: nomeVencedor }, { $set: updates });
    }
  }

  // Resetar sequência do perdedor
  if (pPerd) {
    await db.collection('perfis').updateOne({ nome: nomePerdedor }, { $set: { sequencia: 0 } });
  }
}



function enviarEstado(salaId) {
  const sala = salas.get(salaId); if (!sala) return;
  const base = {
    pontos:sala.pontos, nomes:sala.nomes, mesa:sala.mesa, vira:sala.vira,
    manilha:sala.manilha, turno:sala.turno, rodGanhas:sala.rodGanhas, valMao:sala.valMao,
    estadoTruco:sala.estadoTruco, aguardandoTruco:sala.aguardandoTruco,
    quemPediuTruco:sala.quemPediuTruco, aguardandoMaoOnze:sala.aguardandoMaoOnze,
    fim:sala.fim, vencedor:sala.vencedor, log:sala.log,
  };
  io.in(salaId).fetchSockets().then(sockets => {
    sockets.forEach(s => {
      const meuTime=s.time, advTime=meuTime==='t1'?'t2':'t1';
      s.emit('estado_atualizado', {
        ...base, meuTime,
        minhasCartas:  sala.maos[meuTime],
        qtdAdversario: sala.maos[advTime].length,
        backAdversario: meuTime==='t1' ? sala.backT2 : sala.backT1,
      });
    });
  });
}



// ── BOT ONLINE ───────────────────────────────────────────────────
const CONTAS_BOT = ['davi7', 'jogador2'];

// rota bot removida — bot criado via socket entrar_fila

function enviarEstadoBot(salaId, socket) {
  const sala = salas.get(salaId);
  if (!sala || !socket) return;
  const meuTime = socket.time;
  const advTime = meuTime === 't1' ? 't2' : 't1';
  socket.emit('estado_atualizado', {
    pontos: sala.pontos, nomes: sala.nomes, mesa: sala.mesa, vira: sala.vira,
    manilha: sala.manilha, turno: sala.turno, rodGanhas: sala.rodGanhas, valMao: sala.valMao,
    estadoTruco: sala.estadoTruco, aguardandoTruco: sala.aguardandoTruco,
    quemPediuTruco: sala.quemPediuTruco, aguardandoMaoOnze: sala.aguardandoMaoOnze,
    fim: sala.fim, vencedor: sala.vencedor, log: sala.log,
    meuTime,
    minhasCartas: sala.maos[meuTime],
    qtdAdversario: sala.maos[advTime].length,
    backAdversario: 'padrao',
  });
}

function tickBot(salaId, socketJog) {
  const sala = salas.get(salaId);
  if (!sala || sala.fim) return;

  const botTime = sala.botTime;
  const jogTime = botTime === 't1' ? 't2' : 't1';

  // Achar socket do jogador se não passado
  if (!socketJog) socketJog = [...io.sockets.sockets.values()].find(s => s.salaId === salaId);

  // Bot responde truco
  if (sala.aguardandoTruco && sala.quemPediuTruco === jogTime) {
    const mao = sala.maos[botTime];
    const fMax = Math.max(...mao.map(c => forca(c, sala.manilha)));
    if (fMax > 6) {
      sala.aguardandoTruco = false;
      sala.log = sala.nomes[botTime] + ' aceitou o truco!';
    } else {
      const SEQ = ['nenhum','truco','seis','nove','doze'];
      const VALS_T = { nenhum:1, truco:3, seis:6, nove:9, doze:12 };
      sala.aguardandoTruco = false;
      const valAnt = VALS_T[SEQ[Math.max(0, SEQ.indexOf(sala.estadoTruco)-1)]];
      sala.pontos[jogTime] += valAnt;
      sala.log = sala.nomes[botTime] + ' correu! ' + sala.nomes[jogTime] + ' ganha ' + valAnt + ' pt(s).';
    }
    if (socketJog) enviarEstadoBot(salaId, socketJog);
    if (!verificarFimJogoBot(salaId, socketJog)) setTimeout(() => tickBot(salaId, socketJog), 1500);
    return;
  }

  // Bot responde mão de onze
  if (sala.aguardandoMaoOnze) {
    sala.aguardandoMaoOnze = false;
    sala.log = 'Mão de Onze aceita pelo bot!';
    if (socketJog) enviarEstadoBot(salaId, socketJog);
    setTimeout(() => tickBot(salaId, socketJog), 1000);
    return;
  }

  // Vez do bot jogar
  if (sala.turno === botTime && !sala.aguardandoTruco) {
    const mao = sala.maos[botTime];
    if (!mao || mao.length === 0) return;
    // Joga carta mais fraca
    const idxCarta = mao.reduce((mi, c, i) => forca(c, sala.manilha) < forca(mao[mi], sala.manilha) ? i : mi, 0);
    sala.mesa.push({ time: botTime, carta: mao.splice(idxCarta, 1)[0] });
    sala.turno = jogTime;
    if (sala.mesa.length === 2) {
      resolverRodadaBot(salaId, socketJog);
    } else {
      if (socketJog) enviarEstadoBot(salaId, socketJog);
    }
  }
}

function resolverRodadaBot(salaId, socketJog) {
  const sala = salas.get(salaId);
  if (!sala) return;
  const p1 = sala.mesa.find(m => m.time === 't1'), p2 = sala.mesa.find(m => m.time === 't2');
  const f1 = forca(p1.carta, sala.manilha), f2 = forca(p2.carta, sala.manilha);
  let venc = f1 > f2 ? 't1' : f2 > f1 ? 't2' : '';
  if (venc) sala.rodGanhas[venc]++;
  if (sala.numRodada === 1) sala.vencPrimeiraRod = venc;
  sala.numRodada++; sala.mesa = [];
  if (venc) sala.turno = venc; 
  sala.log = venc ? (sala.nomes[venc] + ' venceu a rodada!') : 'Empate!';
  const fim = checarFimMao(sala);
  if (fim !== null) {
    if (fim) { sala.pontos[fim] += sala.valMao; sala.log = sala.nomes[fim] + ' venceu a mão! +' + sala.valMao + ' pt(s)'; }
    if (socketJog) enviarEstadoBot(salaId, socketJog);
    if (verificarFimJogoBot(salaId, socketJog)) return;
    setTimeout(() => {
      if ((sala.pontos.t1 === 11 || sala.pontos.t2 === 11) && sala.pontos.t1 !== sala.pontos.t2) {
        novaMao(salaId); sala.valMao = 3; sala.aguardandoMaoOnze = true; sala.log = 'Mão de Onze!';
      } else { novaMao(salaId); sala.log = 'Nova mão!'; }
      if (socketJog) enviarEstadoBot(salaId, socketJog);
      // Se bot começa a nova mão
      if (sala.turno === sala.botTime) setTimeout(() => tickBot(salaId, socketJog), 1200);
    }, 1800);
  } else {
    if (socketJog) enviarEstadoBot(salaId, socketJog);
    if (sala.turno === sala.botTime) setTimeout(() => tickBot(salaId, socketJog), 1200);
  }
}

function verificarFimJogoBot(salaId, socketJog) {
  const sala = salas.get(salaId);
  if (!sala) return true;
  if (sala.pontos.t1 >= 12 || sala.pontos.t2 >= 12) {
    sala.fim = true;
    sala.vencedor = sala.pontos.t1 >= 12 ? 't1' : 't2';
    sala.log = sala.nomes[sala.vencedor] + ' venceu a partida!';
    if (socketJog) enviarEstadoBot(salaId, socketJog);
    verificarConquistas(salaId, sala.vencedor);
    return true;
  }
  return false;
}

// ── CAMPEÃO DO MÊS ───────────────────────────────────────────────
async function verificarCampeaoMes() {
  if (!db) return;
  const agora = new Date();
  if (agora.getDate() !== 1) return; // só no dia 1

  const mesAnterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1).toISOString().slice(0,7);
  console.log('🏆 Verificando campeão do mês de ' + mesAnterior);

  // Busca jogador com mais vitórias no mês anterior
  const candidatos = await db.collection('perfis').find({ mesAtual: mesAnterior }).sort({ vitoriasMes: -1 }).limit(1).toArray();
  if (!candidatos.length) return;

  const campeao = candidatos[0];
  if (!(campeao.itens||[]).includes('excl_titulo_campeao')) {
    await db.collection('perfis').updateOne({ nome: campeao.nome }, { $push: { itens: 'excl_titulo_campeao' } });
    console.log('👑 ' + campeao.nome + ' é o Campeão do Mês de ' + mesAnterior + '!');
  }
}

// Verifica todo dia à meia-noite
setInterval(() => {
  const agora = new Date();
  if (agora.getHours() === 0 && agora.getMinutes() === 0) verificarCampeaoMes();
}, 60000); // checa a cada minuto

// ── TESTE CAMPEÃO DO MÊS (só davi7) ──────────────────────────────
app.post('/api/admin/testar-campeao', async (req, res) => {
  const { adminNome } = req.body;
  if (adminNome !== 'davi7') return res.json({ ok: false, msg: 'Sem permissão.' });
  if (!db) return res.json({ ok: false, msg: 'Banco não conectado.' });

  const mesAtual = new Date().toISOString().slice(0,7);
  const candidatos = await db.collection('perfis')
    .find({ mesAtual })
    .sort({ vitoriasMes: -1 })
    .limit(5)
    .toArray();

  res.json({ ok: true, mesAtual, candidatos: candidatos.map(p => ({ nome: p.nome, vitoriasMes: p.vitoriasMes })) });
});

// ── RANKING ──────────────────────────────────────────────────────
app.get('/api/ranking', async (req, res) => {
  try {
    const { nome } = req.query;
    const top10 = await db.collection('perfis')
      .find({})
      .sort({ vitorias: -1 })
      .limit(10)
      .toArray();

    let minhaPos = null, minhasVitorias = null;
    if (nome) {
      const todos = await db.collection('perfis').find({}).sort({ vitorias: -1 }).toArray();
      const idx = todos.findIndex(p => p.nome === nome);
      if (idx !== -1) { minhaPos = idx + 1; minhasVitorias = todos[idx].vitorias; }
    }
    res.json({ ok: true, top10, minhaPos, minhasVitorias });
  } catch(e) { res.json({ ok: false }); }
});
