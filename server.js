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
const filaEspera = [];

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
    if (!sala || sala.turno !== socket.time || sala.aguardandoTruco) return;
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
    sala.log = sala.nomes[socket.time] + ' pediu ' + prox.toUpperCase() + '!';
    if (sala.botTime) {
      enviarEstadoBot(socket.salaId, socket);
      setTimeout(() => tickBot(socket.salaId, socket), 1200);
    } else enviarEstado(socket.salaId);
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

  // ── SALA PRIVADA ──
  socket.on('enviar_convite', ({ para, de }) => {
    socket.nomeJogador = de;
    const alvo = [...io.sockets.sockets.values()].find(s => s.nomeJogador === para);
    if(alvo) {
      socket.convitePara = para;
      alvo.emit('convite_recebido', { de });
    }
  });

  socket.on('aceitar_convite', ({ de, para }) => {
    socket.nomeJogador = para;
    const quemConvidou = [...io.sockets.sockets.values()].find(s => s.nomeJogador === de);
    if(!quemConvidou) return;

    const salaId = 'priv_' + Date.now();
    socket.join(salaId); quemConvidou.join(salaId);
    socket.salaId = salaId; quemConvidou.salaId = salaId;
    socket.time = 't2'; quemConvidou.time = 't1';

    const estado = criarEstadoInicial(de, para);
    estado.backT1 = quemConvidou.backId || 'padrao';
    estado.backT2 = socket.backId || 'padrao';
    salas.set(salaId, estado);

    io.to(salaId).emit('partida_iniciada', { salaId, nomeT1: de, nomeT2: para });
    enviarEstado(salaId);
  });

  socket.on('recusar_convite', ({ de }) => {
    const quemConvidou = [...io.sockets.sockets.values()].find(s => s.nomeJogador === de);
    if(quemConvidou) quemConvidou.emit('convite_recusado');
  });

  socket.on('cancelar_convite', ({ de }) => {
    if(socket.convitePara) {
      const alvo = [...io.sockets.sockets.values()].find(s => s.nomeJogador === socket.convitePara);
      if(alvo) alvo.emit('convite_cancelado');
      socket.convitePara = null;
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

function enviarEstadoJogador(salaId, socket) {
  const sala = salas.get(salaId);
  if (!sala) return;
  const meuTime = socket.time;
  const advTime = meuTime === 't1' ? 't2' : 't1';
  socket.emit('estado_atualizado', {
    pontos: sala.pontos, nomes: sala.nomes, mesa: sala.mesa, vira: sala.vira,
    manilha: sala.manilha, turno: sala.turno, rodGanhas: sala.rodGanhas, valMao: sala.valMao,
    estadoTruco: sala.estadoTruco, aguardandoTruco: sala.aguardandoTruco,
    quemPediuTruco: sala.quemPediuTruco, aguardandoMaoOnze: sala.aguardandoMaoOnze,
    fim: sala.fim, vencedor: sala.vencedor, log: sala.log,
    meuTime, minhasCartas: sala.maos[meuTime],
    qtdAdversario: sala.maos[advTime].length,
    backAdversario: 'padrao',
  });
}

function tickBot(salaId) {
  const sala = salas.get(salaId);
  if (!sala || sala.fim) return;

  const botTime = sala.botTime;
  const jogTime = botTime === 't1' ? 't2' : 't1';

  // Achar socket do jogador
  const socketJog = [...io.sockets.sockets.values()].find(s => s.salaId === salaId);

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
    if (socketJog) enviarEstadoJogador(salaId, socketJog);
    if (!verificarFimJogoBot(salaId, socketJog)) setTimeout(() => tickBot(salaId), 1500);
    return;
  }

  // Bot responde mão de onze
  if (sala.aguardandoMaoOnze) {
    sala.aguardandoMaoOnze = false;
    sala.log = 'Mão de Onze aceita pelo bot!';
    if (socketJog) enviarEstadoJogador(salaId, socketJog);
    setTimeout(() => tickBot(salaId), 1000);
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
      if (socketJog) enviarEstadoJogador(salaId, socketJog);
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
    if (socketJog) enviarEstadoJogador(salaId, socketJog);
    if (verificarFimJogoBot(salaId, socketJog)) return;
    setTimeout(() => {
      if ((sala.pontos.t1 === 11 || sala.pontos.t2 === 11) && sala.pontos.t1 !== sala.pontos.t2) {
        novaMao(salaId); sala.valMao = 3; sala.aguardandoMaoOnze = true; sala.log = 'Mão de Onze!';
      } else { novaMao(salaId); sala.log = 'Nova mão!'; }
      if (socketJog) enviarEstadoJogador(salaId, socketJog);
      // Se bot começa a nova mão
      if (sala.turno === sala.botTime) setTimeout(() => tickBot(salaId), 1200);
    }, 1800);
  } else {
    if (socketJog) enviarEstadoJogador(salaId, socketJog);
    if (sala.turno === sala.botTime) setTimeout(() => tickBot(salaId), 1200);
  }
}

function verificarFimJogoBot(salaId, socketJog) {
  const sala = salas.get(salaId);
  if (!sala) return true;
  if (sala.pontos.t1 >= 12 || sala.pontos.t2 >= 12) {
    sala.fim = true;
    sala.vencedor = sala.pontos.t1 >= 12 ? 't1' : 't2';
    sala.log = sala.nomes[sala.vencedor] + ' venceu a partida!';
    if (socketJog) enviarEstadoJogador(salaId, socketJog);
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
