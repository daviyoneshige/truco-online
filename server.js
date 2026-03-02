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

MongoClient.connect(MONGO_URI)
  .then(client => { db = client.db('truco'); console.log('✅ MongoDB conectado!'); })
  .catch(err => console.error('❌ Erro MongoDB:', err));

async function getPerfil(nome) {
  let p = await db.collection('perfis').findOne({ nome });
  if (!p) {
    p = { nome, moedas: 1000, vitorias: 0, derrotas: 0, itens: [], backAtual: 'padrao', avatarAtual: '🃏' };
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

// ── ROTAS HTTP ───────────────────────────────────────────────────

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

app.get('/api/admin/jogadores', async (req, res) => {
  try {
    if (req.query.admin !== 'davi7') return res.json({ ok: false });
    res.json({ ok: true, perfis: await db.collection('perfis').find({}).toArray() });
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
const filaEspera = [];

io.on('connection', (socket) => {
  console.log('Conectou:', socket.id);

  socket.on('entrar_fila', ({ nome, backId }) => {
    socket.nomeJogador = nome;
    socket.backId = backId || 'padrao';
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
    if (!sala || sala.turno !== socket.time || sala.aguardandoTruco) return;
    const mao = sala.maos[socket.time];
    if (idx < 0 || idx >= mao.length) return;
    sala.mesa.push({ time: socket.time, carta: mao.splice(idx, 1)[0] });
    sala.turno = socket.time === 't1' ? 't2' : 't1';
    if (sala.mesa.length === 2) resolverRodada(socket.salaId);
    else enviarEstado(socket.salaId);
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
    sala.log = sala.nomes[socket.time] + ' pediu ' + prox.toUpperCase() + '!';
    enviarEstado(socket.salaId);
  });

  socket.on('aceitar_truco', () => {
    const sala = salas.get(socket.salaId);
    if (!sala || !sala.aguardandoTruco || socket.time === sala.quemPediuTruco) return;
    sala.aguardandoTruco = false;
    sala.log = 'Truco aceito! Mão vale ' + sala.valMao + ' pt(s).';
    enviarEstado(socket.salaId);
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
    enviarEstado(socket.salaId);
    if (!verificarFimJogo(socket.salaId))
      setTimeout(() => { novaMao(socket.salaId); enviarEstado(socket.salaId); }, 1500);
  });

  socket.on('resposta_mao_onze', ({ aceita }) => {
    const sala = salas.get(socket.salaId);
    if (!sala) return;
    const tOnze = sala.pontos.t1 === 11 ? 't1' : 't2';
    sala.aguardandoMaoOnze = false;
    if (!aceita) {
      sala.pontos[tOnze] += 1;
      sala.log = sala.nomes[tOnze] + ' ganha 1 ponto (adversário recusou).';
      enviarEstado(socket.salaId);
      if (!verificarFimJogo(socket.salaId))
        setTimeout(() => { novaMao(socket.salaId); enviarEstado(socket.salaId); }, 1500);
    } else {
      sala.log = 'Mão de Onze aceita! Mão vale 3 pontos.';
      enviarEstado(socket.salaId);
    }
  });

  socket.on('disconnect', () => {
    const idx = filaEspera.indexOf(socket);
    if (idx !== -1) filaEspera.splice(idx, 1);
    if (socket.salaId) { io.to(socket.salaId).emit('adversario_desconectou'); salas.delete(socket.salaId); }
  });
});

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
  if (sala.pontos.t1>=12) { sala.fim=true; sala.vencedor='t1'; enviarEstado(salaId); return true; }
  if (sala.pontos.t2>=12) { sala.fim=true; sala.vencedor='t2'; enviarEstado(salaId); return true; }
  return false;
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

const PORTA = process.env.PORT || 3000;
server.listen(PORTA, () => console.log('Servidor rodando na porta', PORTA));
