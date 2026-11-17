(() => {
  'use strict';

  /* ------------------------------ helpers ------------------------------ */
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const eq = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  const COLOR_NAME = { w: 'Blancas', b: 'Negras' };
  const REASONS = {
    'sin fichas': 'Se quedó sin fichas',
    bloqueado: 'Se quedó sin movimientos',
    abandono: 'El rival abandonó la partida',
    rendicion: 'El rival se rindió',
    tablas: '40 jugadas sin capturas',
  };

  const REACTIONS = {
    mala: { emoji: '😂', text: '¡Qué mala jugada!' },
    comer: { emoji: '👀', text: '¡Te van a comer!' },
    tortuga: { emoji: '🐢', text: '¡Apúrate tortuga!' },
    suerte: { emoji: '🍀', text: '¡Suerte de principiante!' },
    aplauso: { emoji: '👏', text: '¡Bravo!' },
    fuego: { emoji: '🔥', text: '¡Jugadón!' },
    shock: { emoji: '😱', text: '¡No puede ser!' },
    payaso: { emoji: '🤡', text: '¡Eso fue un chiste!' },
  };

  /* ------------------------------ estado ------------------------------ */
  const socket = io();
  let myId = sessionStorage.getItem('damas.cid');
  if (!myId) {
    myId =
      window.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('damas.cid', myId);
  }
  let session = null; // { code, name } cuando estamos dentro de una sala
  let state = null;
  let selected = null;
  let dismissedGameId = null;
  let muted = localStorage.getItem('damas.mute') === '1';
  let lastReactionAt = 0;

  /* ------------------------------ sonido ------------------------------ */
  let actx = null;
  function audio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  function tone(freq, start, dur, type = 'sine', vol = 0.14) {
    if (muted) return;
    const a = audio();
    if (!a) return;
    const t = a.currentTime + start;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  }
  function seq(notes, type, vol) {
    let t = 0;
    for (const [f, d] of notes) {
      if (f > 0) tone(f, t, d, type, vol);
      t += d;
    }
  }
  const clap = [];
  for (let i = 0; i < 7; i++) clap.push([1700 + (i % 3) * 200, 0.03], [0, 0.05]);
  const REACTION_SND = {
    mala: ['sawtooth', [[400, 0.12], [330, 0.12], [260, 0.12], [170, 0.35]]],
    comer: ['square', [[300, 0.12], [0, 0.05], [300, 0.12], [420, 0.25]]],
    tortuga: ['triangle', [[220, 0.3], [196, 0.3], [165, 0.5]]],
    suerte: ['sine', [[880, 0.1], [1175, 0.1], [1568, 0.25]]],
    aplauso: ['triangle', clap],
    fuego: ['sawtooth', [[300, 0.08], [400, 0.08], [500, 0.08], [700, 0.22]]],
    shock: ['square', [[900, 0.1], [450, 0.3]]],
    payaso: ['square', [[500, 0.1], [700, 0.1], [500, 0.1], [700, 0.1], [350, 0.3]]],
  };
  const SFX = {
    move: () => tone(520, 0, 0.08, 'triangle'),
    capture: () => {
      tone(220, 0, 0.12, 'square', 0.1);
      tone(150, 0.07, 0.16, 'square', 0.1);
    },
    turn: () => seq([[660, 0.1], [880, 0.16]], 'sine', 0.12),
    win: () => seq([[523, 0.12], [659, 0.12], [784, 0.12], [1047, 0.3]], 'triangle'),
    lose: () => seq([[392, 0.18], [311, 0.18], [233, 0.4]], 'sawtooth', 0.1),
  };
  document.addEventListener('pointerdown', audio, { once: true });

  /* ------------------------------- toast ------------------------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  /* ------------------------------ pantallas ------------------------------ */
  function showLobby(error) {
    $('#game').classList.add('hidden');
    $('#lobby').classList.remove('hidden');
    $('#lobbyError').textContent = error || '';
    document.title = 'Damas con amigos';
  }
  function showGame(code) {
    $('#lobby').classList.add('hidden');
    $('#game').classList.remove('hidden');
    $('#roomCode').textContent = code;
  }

  /* ------------------------------ entrar ------------------------------ */
  function join(create, code) {
    const name = $('#name').value.trim();
    if (!name) {
      $('#lobbyError').textContent = 'Escribe tu apodo primero.';
      $('#name').focus();
      return;
    }
    if (!create && !code) {
      $('#lobbyError').textContent = 'Escribe el código de la sala.';
      $('#code').focus();
      return;
    }
    localStorage.setItem('damas.name', name);
    $('#lobbyError').textContent = '';
    socket.emit('join', { create, code, name, clientId: myId }, (res) => {
      if (!res || !res.ok) {
        session = null;
        showLobby((res && res.error) || 'No se pudo entrar a la sala.');
        return;
      }
      session = { code: res.code, name };
      history.replaceState(null, '', '?sala=' + res.code);
      showGame(res.code);
    });
  }

  $('#btnCreate').addEventListener('click', () => join(true));
  $('#btnJoin').addEventListener('click', () => join(false, $('#code').value.trim().toUpperCase()));
  $('#code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btnJoin').click();
  });
  $('#name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if ($('#code').value.trim()) $('#btnJoin').click();
      else $('#btnCreate').click();
    }
  });

  $('#btnLeave').addEventListener('click', () => {
    socket.emit('leave');
    session = null;
    state = null;
    selected = null;
    history.replaceState(null, '', location.pathname);
    $('#messages').innerHTML = '';
    showLobby();
  });

  $('#btnMute').addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('damas.mute', muted ? '1' : '0');
    $('#btnMute').textContent = muted ? '🔇' : '🔊';
  });
  $('#btnMute').textContent = muted ? '🔇' : '🔊';

  $('#btnShare').addEventListener('click', async () => {
    if (!session) return;
    const url = location.origin + '/?sala=' + session.code;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Damas con amigos', text: `Únete a mi sala (${session.code})`, url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Enlace copiado ✅');
    } catch (e) {
      const ta = el('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        toast('Enlace copiado ✅');
      } catch (e2) {
        window.prompt('Copia este enlace:', url);
      }
      ta.remove();
    }
  });

  /* ----------------------------- reconexión ----------------------------- */
  socket.on('connect', () => {
    $('#netBanner').classList.add('hidden');
    if (session) {
      socket.emit('join', { create: false, code: session.code, name: session.name, clientId: myId }, (res) => {
        if (!res || !res.ok) {
          session = null;
          state = null;
          showLobby('La sala ya no existe.');
        }
      });
    }
  });
  socket.on('disconnect', () => {
    if (session) $('#netBanner').classList.remove('hidden');
  });

  /* ------------------------------ derivados ------------------------------ */
  function me() {
    return state ? state.users.find((u) => u.id === myId) : null;
  }
  function myColor() {
    const m = me();
    return m && m.role !== 'spec' ? m.role : null;
  }
  const bottomColor = () => (myColor() === 'b' ? 'b' : 'w');
  function activeMoves() {
    if (!state) return [];
    const g = state.game;
    return g.status === 'playing' && myColor() === g.turn ? g.legal : [];
  }
  function playerOf(color) {
    return state.users.find((u) => u.role === color) || null;
  }
  function count(board, color) {
    let n = 0;
    for (const row of board) for (const p of row) if (p && p.c === color) n++;
    return n;
  }

  /* ------------------------------ recibir estado ------------------------------ */
  socket.on('state', (s) => {
    const old = state;
    state = s;
    const g = s.game;

    if (old && old.game.id === g.id) {
      const og = old.game;
      const wasMine = og.status === 'playing' && myColorIn(old) === og.turn;
      const isMine = g.status === 'playing' && myColor() === g.turn;
      if (count(g.board, 'w') + count(g.board, 'b') < count(og.board, 'w') + count(og.board, 'b')) SFX.capture();
      else if (JSON.stringify(g.lastMove) !== JSON.stringify(og.lastMove)) SFX.move();
      if (isMine && !wasMine) setTimeout(SFX.turn, 180);
      if (og.status === 'playing' && g.status === 'over') {
        const mc = myColor();
        setTimeout(() => {
          if (mc && g.winner === mc) SFX.win();
          else if (mc && g.winner) SFX.lose();
          else SFX.win();
        }, 250);
      }
    }

    // Selección: mantener solo si sigue siendo válida; auto-seleccionar en cadena de capturas
    const moves = activeMoves();
    if (selected && !moves.some((m) => eq(m.from, selected))) selected = null;
    if (g.chain && moves.length) selected = g.chain.slice();

    render();
  });

  function myColorIn(st) {
    const m = st.users.find((u) => u.id === myId);
    return m && m.role !== 'spec' ? m.role : null;
  }

  /* ------------------------------ render ------------------------------ */
  function render() {
    if (!state) return;
    renderCounts();
    renderBoard();
    renderBars();
    renderStatus();
    renderActions();
    renderOverlay();
    renderPeople();
  }

  function renderCounts() {
    const players = state.users.filter((u) => u.role !== 'spec').length;
    const specs = state.users.length - players;
    $('#counts').textContent = `🎮 ${players} jugando · 👁 ${specs} mirando`;
  }

  function renderBoard() {
    const g = state.game;
    const boardEl = $('#board');
    boardEl.innerHTML = '';
    const flip = bottomColor() === 'b';
    const moves = activeMoves();
    const fromSet = new Set(moves.map((m) => m.from.join(',')));
    const mustCapture = moves.some((m) => m.cap);
    const dests = selected ? moves.filter((m) => eq(m.from, selected)) : [];

    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        const r = flip ? 7 - i : i;
        const c = flip ? 7 - j : j;
        const dark = (r + c) % 2 === 1;
        const sq = el('div', 'sq ' + (dark ? 'dark' : 'light'));
        sq.dataset.r = r;
        sq.dataset.c = c;

        if (g.lastMove && (eq(g.lastMove.from, [r, c]) || eq(g.lastMove.to, [r, c]))) sq.classList.add('last');
        if (selected && eq(selected, [r, c])) sq.classList.add('sel');
        const d = dests.find((m) => eq(m.to, [r, c]));
        if (d) {
          sq.classList.add('dest');
          if (d.cap) sq.classList.add('cap');
        }

        const p = g.board[r][c];
        if (p) {
          const pc = el('div', 'piece ' + (p.c === 'w' ? 'white' : 'black') + (p.k ? ' king' : ''));
          if (fromSet.has(r + ',' + c)) {
            pc.classList.add('movable');
            if (mustCapture) pc.classList.add('must');
          }
          if (selected && eq(selected, [r, c])) pc.classList.add('selected');
          sq.appendChild(pc);
        }
        boardEl.appendChild(sq);
      }
    }
  }

  $('#board').addEventListener('click', (e) => {
    const sq = e.target.closest('.sq');
    if (!sq || !state) return;
    onCell(+sq.dataset.r, +sq.dataset.c);
  });

  function onCell(r, c) {
    const moves = activeMoves();
    if (!moves.length) return;
    const g = state.game;

    if (selected) {
      const mv = moves.find((m) => eq(m.from, selected) && eq(m.to, [r, c]));
      if (mv) {
        socket.emit('move', { from: mv.from, to: mv.to });
        if (!(g.chain)) selected = null;
        return;
      }
    }
    if (g.chain) return; // en cadena solo se puede seguir con la misma ficha
    const p = g.board[r][c];
    if (p && p.c === myColor() && moves.some((m) => eq(m.from, [r, c]))) {
      selected = selected && eq(selected, [r, c]) ? null : [r, c];
    } else {
      selected = null;
    }
    renderBoard();
  }

  function renderBar(container, color) {
    const g = state.game;
    container.innerHTML = '';
    const u = playerOf(color);
    const active = g.status === 'playing' && g.turn === color;
    container.classList.toggle('active', active);

    container.appendChild(el('span', 'chip ' + color));
    const nm = el('div', 'pname');
    if (u) {
      nm.textContent = u.name;
      const extra = [];
      if (u.id === myId) extra.push('tú');
      if (!u.connected) extra.push('reconectando…');
      if (extra.length) nm.appendChild(el('small', '', ' (' + extra.join(', ') + ')'));
    } else {
      nm.textContent = 'Esperando jugador…';
      nm.classList.add('dim');
    }
    container.appendChild(nm);
    container.appendChild(el('span', 'pcount', `${COLOR_NAME[color]} · ${count(g.board, color)} 🔘`));
    if (active) container.appendChild(el('span', 'turnTag', 'TURNO'));
  }

  function renderBars() {
    const bottom = bottomColor();
    renderBar($('#playerBottom'), bottom);
    renderBar($('#playerTop'), bottom === 'w' ? 'b' : 'w');
  }

  function renderStatus() {
    const g = state.game;
    const s = $('#status');
    s.className = 'status';
    const mc = myColor();
    const moves = activeMoves();

    if (g.status === 'waiting') {
      s.textContent = '⏳ Esperando al segundo jugador… comparte el código ' + state.code;
      document.title = 'Esperando rival · Damas';
    } else if (g.status === 'over') {
      s.textContent = resultTitle();
      document.title = 'Fin de partida · Damas';
    } else if (mc && g.turn === mc) {
      const cap = moves.some((m) => m.cap);
      s.textContent = g.chain
        ? '🟢 ¡Sigue capturando con la misma ficha!'
        : cap
        ? '🟢 Tu turno — ¡captura obligatoria!'
        : '🟢 ¡Es tu turno!';
      s.classList.add('mine');
      if (cap) s.classList.add('warn');
      document.title = '🟢 Tu turno · Damas';
    } else {
      const u = playerOf(g.turn);
      s.textContent = `Turno de ${u ? u.name : '…'} (${COLOR_NAME[g.turn]})`;
      document.title = 'Damas con amigos';
    }
  }

  function resultTitle() {
    const g = state.game;
    const mc = myColor();
    if (!g.winner) return '🤝 Tablas';
    if (mc) return g.winner === mc ? '🎉 ¡Ganaste!' : '😅 Perdiste';
    return `🏆 ¡Ganó ${g.names[g.winner] || COLOR_NAME[g.winner]}!`;
  }

  function actionButtons(container) {
    const g = state.game;
    const mc = myColor();
    if (!mc) return;
    if (g.status === 'playing') {
      const b = el('button', 'btn small danger', '🏳 Rendirse');
      b.addEventListener('click', () => {
        if (confirm('¿Seguro que quieres rendirte?')) socket.emit('resign');
      });
      container.appendChild(b);
    } else if (g.status === 'over') {
      const both = !!(playerOf('w') && playerOf('b'));
      const voted = state.rematch.includes(myId);
      const rb = el(
        'button',
        'btn primary',
        !both ? '⏳ Esperando rival…' : voted ? `✔ Esperando al rival (${state.rematch.length}/2)` : '🔁 Revancha'
      );
      rb.disabled = !both || voted;
      rb.addEventListener('click', () => socket.emit('rematch'));
      container.appendChild(rb);

      const specs = state.users.filter((u) => u.role === 'spec' && u.connected).length;
      if (specs > 0) {
        const ro = el('button', 'btn', '🔄 Rotar jugadores');
        ro.title = 'El que perdió pasa a mirar y entra el primer espectador';
        ro.addEventListener('click', () => socket.emit('rotate'));
        container.appendChild(ro);
      }
    }
  }

  function renderActions() {
    const a = $('#actions');
    a.innerHTML = '';
    actionButtons(a);
  }

  function renderOverlay() {
    const g = state.game;
    const ov = $('#overlay');
    if (g.status !== 'over' || dismissedGameId === g.id) {
      ov.classList.add('hidden');
      ov.innerHTML = '';
      return;
    }
    ov.classList.remove('hidden');
    ov.innerHTML = '';
    const box = el('div', 'box');
    box.appendChild(el('h2', '', resultTitle()));
    box.appendChild(el('p', '', REASONS[g.reason] || ''));
    const stack = el('div', 'stack');
    if (myColor()) {
      actionButtons(stack);
    } else {
      stack.appendChild(el('p', '', 'Esperando a que los jugadores decidan…'));
    }
    const close = el('button', 'btn small', 'Ver tablero');
    close.addEventListener('click', () => {
      dismissedGameId = g.id;
      renderOverlay();
    });
    stack.appendChild(close);
    box.appendChild(stack);
    ov.appendChild(box);
  }

  function renderPeople() {
    const box = $('#people');
    box.innerHTML = '';
    const players = state.users.filter((u) => u.role !== 'spec');
    const specs = state.users.filter((u) => u.role === 'spec');

    const mk = (title, list, iconOf) => {
      box.appendChild(el('h4', '', title));
      const ul = el('ul');
      if (!list.length) ul.appendChild(el('li', 'dim', '—'));
      for (const u of list) {
        const li = el('li');
        if (!u.connected) li.classList.add('dim');
        li.appendChild(el('span', '', iconOf(u)));
        li.appendChild(el('span', '', u.name + (u.id === myId ? ' (tú)' : '') + (u.connected ? '' : ' · reconectando…')));
        ul.appendChild(li);
      }
      box.appendChild(ul);
    };
    mk(`Jugando (${players.length}/2)`, players, (u) => (u.role === 'w' ? '⚪' : '⚫'));
    mk(`Mirando (${specs.length})`, specs, () => '👁');
  }

  /* ------------------------------- chat ------------------------------- */
  function addMessage(m) {
    const box = $('#messages');
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const div = el('div', 'msg' + (m.sys ? ' sys' : ''));
    if (m.sys) {
      div.textContent = m.text;
    } else {
      const icon = m.role === 'w' ? '⚪' : m.role === 'b' ? '⚫' : '👁';
      div.appendChild(el('span', 'who ' + m.role, icon + ' ' + m.name + ': '));
      div.appendChild(document.createTextNode(m.text));
    }
    box.appendChild(div);
    while (box.children.length > 120) box.removeChild(box.firstChild);
    if (near) box.scrollTop = box.scrollHeight;
  }
  socket.on('chatHistory', (list) => {
    $('#messages').innerHTML = '';
    list.forEach(addMessage);
    const box = $('#messages');
    box.scrollTop = box.scrollHeight;
  });
  socket.on('chat', addMessage);

  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat', { text });
    input.value = '';
  });

  /* ---------------------------- reacciones ---------------------------- */
  const reactionsBox = $('#reactions');
  for (const key of Object.keys(REACTIONS)) {
    const r = REACTIONS[key];
    const b = el('button');
    b.appendChild(el('span', 'e', r.emoji));
    b.appendChild(el('span', '', r.text));
    b.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastReactionAt < 800) return;
      lastReactionAt = now;
      socket.emit('reaction', { key });
    });
    reactionsBox.appendChild(b);
  }

  socket.on('reaction', ({ key, name }) => {
    const r = REACTIONS[key];
    if (!r) return;
    const f = el('div', 'floater');
    f.style.left = 15 + Math.random() * 70 + '%';
    f.appendChild(el('div', 'big', r.emoji));
    f.appendChild(el('div', 'txt', r.text));
    f.appendChild(el('span', 'who', name));
    $('#floaters').appendChild(f);
    setTimeout(() => f.remove(), 3300);
    const snd = REACTION_SND[key];
    if (snd) seq(snd[1], snd[0], 0.12);
  });

  socket.on('toast', toast);

  /* ------------------------------- inicio ------------------------------- */
  $('#name').value = localStorage.getItem('damas.name') || '';
  const urlCode = (new URLSearchParams(location.search).get('sala') || '').trim().toUpperCase();
  if (urlCode) {
    $('#code').value = urlCode;
    if ($('#name').value) join(false, urlCode); // entra directo si ya conocemos tu apodo
    else $('#name').focus();
  }
})();
