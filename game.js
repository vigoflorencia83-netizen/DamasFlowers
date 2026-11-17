'use strict';

/**
 * Lógica pura de Damas clásicas (estilo inglés/americano) en tablero 8x8.
 *
 * - Casillas oscuras: (fila + columna) impar.
 * - Negras arriba (filas 0-2), Blancas abajo (filas 5-7). Blancas mueven primero.
 * - Fichas normales: mueven y capturan solo hacia adelante, en diagonal.
 * - Damas (reinas): mueven y capturan en diagonal hacia adelante y atrás, de a una casilla.
 * - Captura obligatoria. Si tras capturar se puede seguir capturando con la misma
 *   ficha, el turno continúa (cadena). Si una ficha se corona durante una captura,
 *   el turno termina.
 * - Pierde quien no tiene fichas o no puede mover.
 * - Tablas tras 80 medias jugadas (40 por bando) sin captura ni movimiento de ficha normal.
 */

const other = (c) => (c === 'w' ? 'b' : 'w');
const inBounds = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

function newBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        if (r < 3) b[r][c] = { c: 'b', k: false };
        else if (r > 4) b[r][c] = { c: 'w', k: false };
      }
    }
  }
  return b;
}

function dirsFor(p) {
  if (p.k) return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  return p.c === 'w' ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]];
}

function jumpsFrom(board, r, c) {
  const p = board[r][c];
  const out = [];
  for (const [dr, dc] of dirsFor(p)) {
    const mr = r + dr, mc = c + dc;
    const tr = r + 2 * dr, tc = c + 2 * dc;
    if (!inBounds(tr, tc)) continue;
    const mid = board[mr][mc];
    if (mid && mid.c !== p.c && !board[tr][tc]) {
      out.push({ from: [r, c], to: [tr, tc], cap: [mr, mc] });
    }
  }
  return out;
}

function stepsFrom(board, r, c) {
  const p = board[r][c];
  const out = [];
  for (const [dr, dc] of dirsFor(p)) {
    const tr = r + dr, tc = c + dc;
    if (inBounds(tr, tc) && !board[tr][tc]) {
      out.push({ from: [r, c], to: [tr, tc], cap: null });
    }
  }
  return out;
}

/** Movimientos legales de `color`. Si hay `chain` ([r,c]) solo esa ficha puede seguir capturando. */
function legalMoves(board, color, chain) {
  if (chain) return jumpsFrom(board, chain[0], chain[1]);
  const jumps = [];
  const steps = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.c === color) {
        jumps.push(...jumpsFrom(board, r, c));
        steps.push(...stepsFrom(board, r, c));
      }
    }
  }
  return jumps.length ? jumps : steps; // captura obligatoria
}

function countPieces(board, color) {
  let n = 0;
  for (const row of board) for (const p of row) if (p && p.c === color) n++;
  return n;
}

let nextId = 1;

function baseGame(status) {
  const board = newBoard();
  return {
    id: nextId++,
    board,
    turn: 'w',
    chain: null,
    legal: status === 'playing' ? legalMoves(board, 'w', null) : [],
    status, // 'waiting' | 'playing' | 'over'
    winner: null, // 'w' | 'b' | null (tablas)
    reason: null,
    lastMove: null,
    quiet: 0,
    names: { w: '', b: '' },
  };
}

const createGame = () => baseGame('playing');
const waitingGame = () => baseGame('waiting');

function finish(game, winner, reason) {
  game.status = 'over';
  game.winner = winner;
  game.reason = reason;
  game.legal = [];
  game.chain = null;
}

/** Aplica un paso (from -> to). Devuelve { ok, captured, crowned, continues }. */
function playMove(game, from, to) {
  if (game.status !== 'playing') return { ok: false };
  const mv = game.legal.find(
    (m) => m.from[0] === from[0] && m.from[1] === from[1] && m.to[0] === to[0] && m.to[1] === to[1]
  );
  if (!mv) return { ok: false };

  const b = game.board;
  const mover = game.turn;
  const piece = b[mv.from[0]][mv.from[1]];
  const wasKing = piece.k;

  b[mv.from[0]][mv.from[1]] = null;
  b[mv.to[0]][mv.to[1]] = piece;
  if (mv.cap) b[mv.cap[0]][mv.cap[1]] = null;

  let crowned = false;
  if (!piece.k && ((mover === 'w' && mv.to[0] === 0) || (mover === 'b' && mv.to[0] === 7))) {
    piece.k = true;
    crowned = true;
  }

  game.lastMove = { from: mv.from, to: mv.to };
  if (mv.cap || !wasKing) game.quiet = 0;
  else game.quiet++;

  // ¿Puede seguir capturando con la misma ficha?
  if (mv.cap && !crowned) {
    const more = jumpsFrom(b, mv.to[0], mv.to[1]);
    if (more.length) {
      game.chain = [mv.to[0], mv.to[1]];
      game.legal = more;
      return { ok: true, captured: true, crowned: false, continues: true };
    }
  }

  game.chain = null;
  game.turn = other(mover);
  game.legal = legalMoves(b, game.turn, null);

  if (countPieces(b, game.turn) === 0) finish(game, mover, 'sin fichas');
  else if (!game.legal.length) finish(game, mover, 'bloqueado');
  else if (game.quiet >= 80) finish(game, null, 'tablas');

  return { ok: true, captured: !!mv.cap, crowned, continues: false };
}

function resign(game, color) {
  if (game.status !== 'playing') return false;
  finish(game, other(color), 'rendicion');
  return true;
}

module.exports = {
  other,
  newBoard,
  legalMoves,
  jumpsFrom,
  countPieces,
  createGame,
  waitingGame,
  playMove,
  resign,
  finish,
};
