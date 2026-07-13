// ============================================================
//  storage.js  —  capa de datos compartida entre las páginas
// ============================================================

const STORAGE_KEY = '***';

// ---------- Migración de formatos legados (days/day → Temas/Tema) ----------

/**
 * Torneos creados antes de este cambio guardaban el contenido buffet como
 * `buffetData.days` (con `day` numérico) y las asignaciones como
 * `participantDays`. Esta función detecta ese formato viejo y lo convierte
 * al formato actual (`buffetData.Temas` con `Tema`, y `participantTemas`)
 * sin perder ningún dato. Se ejecuta automáticamente al cargar los torneos.
 * Devuelve true si modificó el objeto `t` (para saber si hay que re-guardar).
 */
function migrateLegacyFields(t) {
  let changed = false;

  if (t.buffetData && Array.isArray(t.buffetData.days) && !t.buffetData.Temas) {
    t.buffetData = {
      Temas: t.buffetData.days.map(d => ({ Tema: d.day, preguntas: d.preguntas || [] }))
    };
    changed = true;
  }

  if (t.participantDays && !t.participantTemas) {
    t.participantTemas = t.participantDays;
    delete t.participantDays;
    changed = true;
  }

  return changed;
}

export function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : [];
    let changed = false;
    data.forEach(t => { if (migrateLegacyFields(t)) changed = true; });
    if (changed) saveAll(data); // persistimos la migración para que sea de una sola vez
    return data;
  } catch {
    return [];
  }
}

export function saveAll(tournaments) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tournaments));
  } catch (e) {
    console.error('No se pudo guardar:', e);
  }
}

export function getTournament(id) {
  return loadAll().find(t => t.id === id) || null;
}

export function saveTournament(updated) {
  const all = loadAll();
  const idx = all.findIndex(t => t.id === updated.id);
  if (idx >= 0) all[idx] = updated;
  else all.push(updated);
  saveAll(all);
}

export function deleteTournament(id) {
  saveAll(loadAll().filter(t => t.id !== id));
}

// ---------- Round-robin (método del círculo) ----------
export function generateRounds(participants) {
  let list = [...participants];
  if (list.length % 2 !== 0) list.push(null); // null = bye
  const n = list.length;
  const rounds = [];
  let arr = [...list];

  for (let r = 0; r < n - 1; r++) {
    const matches = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a !== null && b !== null)
        matches.push({ home: a, away: b, result: null }); // result = null hasta que se evalúe
    }
    rounds.push(matches);
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr = [fixed, ...rest];
  }
  return rounds;
}

// ---------- Agregar participantes a un torneo ya creado ----------

// Invierte un `result` guardado cuando el par (A,B) aparece ahora como (B,A).
function flipResult(r) {
  if (!r) return null;
  const flipped = { ...r };
  if ('homeScore' in flipped || 'awayScore' in flipped) {
    [flipped.homeScore, flipped.awayScore] = [flipped.awayScore, flipped.homeScore];
  }
  if ('extraHome' in flipped || 'extraAway' in flipped) {
    [flipped.extraHome, flipped.extraAway] = [flipped.extraAway, flipped.extraHome];
  }
  if (flipped.absent && typeof flipped.absent === 'object') {
    flipped.absent = { home: !!flipped.absent.away, away: !!flipped.absent.home };
  } else if (flipped.absentSide === 'home') flipped.absentSide = 'away';
  else if (flipped.absentSide === 'away') flipped.absentSide = 'home';
  if (Array.isArray(flipped.questionScores)) {
    flipped.questionScores = flipped.questionScores.map(s => ({
      ...s, homeQ: s.awayQ, awayQ: s.homeQ, homeC: s.awayC, awayC: s.homeC
    }));
  }
  return flipped;
}

// Invierte un `progress` (evaluación a medias) guardado, igual criterio que flipResult.
function flipProgress(p) {
  if (!p) return null;
  const flipped = { ...p };
  if (flipped.extraScores) {
    flipped.extraScores = { home: flipped.extraScores.away, away: flipped.extraScores.home };
  }
  if (Array.isArray(flipped.turnData)) {
    flipped.turnData = flipped.turnData.map(td => ({ ...td, home: td.away, away: td.home }));
  }
  return flipped;
}

/**
 * Agrega participantes a un torneo ya creado y regenera el calendario
 * round-robin completo entre TODOS los participantes (los que ya estaban +
 * los nuevos). Esto hace que la cantidad de jornadas y enfrentamientos
 * aumente naturalmente en proporción a la gente agregada.
 *
 * Los enfrentamientos que ya se habían jugado (o quedaron a medias) entre dos
 * participantes que ya estaban en el torneo se vuelven a aplicar sobre el
 * nuevo calendario buscando el mismo par sin importar quién quedó de local o
 * visitante, así no se pierde nada de lo ya evaluado.
 *
 * Muta `t` directamente (participants, rounds, y — según el tipo de
 * contenido — participantTemas / participantContent / questionsByRound).
 * No guarda; hay que llamar a `saveTournament(t)` después.
 *
 * Devuelve { added: string[] } con los nombres realmente incorporados
 * (ignora duplicados ya existentes y strings vacíos).
 */
export function addParticipants(t, newNames) {
  const cleaned = (newNames || []).map(n => String(n).trim()).filter(Boolean);
  const toAdd = [];
  cleaned.forEach(n => {
    if (!t.participants.includes(n) && !toAdd.includes(n)) toAdd.push(n);
  });
  if (!toAdd.length) return { added: [] };

  // 1) Guardar todo lo ya jugado / en curso, indexado por par (sin importar orden).
  const pairKey = (a, b) => [a, b].sort().join('␟');
  const savedByPair = new Map();
  (t.rounds || []).forEach(round => {
    (round || []).forEach(m => {
      if (m.result || m.progress) {
        savedByPair.set(pairKey(m.home, m.away), {
          home: m.home, result: m.result || null, progress: m.progress || null
        });
      }
    });
  });

  // 2) Nueva lista de participantes + nuevo calendario completo.
  t.participants = [...t.participants, ...toAdd];
  const newRounds = generateRounds(t.participants);

  // 3) Reaplicar lo guardado donde el par coincida en el nuevo calendario.
  newRounds.forEach(round => {
    round.forEach(m => {
      const saved = savedByPair.get(pairKey(m.home, m.away));
      if (!saved) return;
      const swapped = saved.home !== m.home;
      m.result = swapped ? flipResult(saved.result) : saved.result;
      m.progress = swapped ? flipProgress(saved.progress) : saved.progress;
    });
  });
  t.rounds = newRounds;

  // 4) Buffet: asegurar que cada nuevo participante tenga al menos un tema (por defecto, el primero).
  if (t.contentType === 'buffet') {
    if (!t.participantTemas) t.participantTemas = {};
    const firstTema = t.buffetData?.Temas?.[0]?.Tema;
    toAdd.forEach(p => {
      if (!t.participantTemas[p] || !t.participantTemas[p].length) {
        t.participantTemas[p] = firstTema !== undefined ? [firstTema] : [];
      }
    });
  }

  // 5) Contenido individual: dejar el arreglo listo (vacío) para cargarlo después.
  if (t.contentType === 'individual') {
    if (!t.participantContent) t.participantContent = {};
    toAdd.forEach(p => { if (!t.participantContent[p]) t.participantContent[p] = []; });
  }

  // 6) Shared: si crecieron las jornadas, completar el contenido de las nuevas
  //    con el banco plano legado como respaldo (mismo criterio que ensureQuestionsByRound).
  if (t.contentType === 'shared') {
    t.questionsByRound = ensureQuestionsByRound(t);
  }

  return { added: toAdd };
}

// ---------- Reasignar rivales dentro de una misma jornada ----------

const SIDE_SCORE = { home: 'homeScore', away: 'awayScore' };
const SIDE_EXTRA = { home: 'extraHome', away: 'extraAway' };
const SIDE_Q     = { home: 'homeQ',     away: 'awayQ' };
const SIDE_C     = { home: 'homeC',     away: 'awayC' };

// Lee si un lado está marcado como ausente en un `result`, soportando el
// formato nuevo (`absent: {home, away}`) y el viejo (`absentSide`: string).
function readAbsentFlag(r, side) {
  if (!r) return false;
  if (r.absent && typeof r.absent === 'object') return !!r.absent[side];
  return r.absentSide === side;
}

// Extrae únicamente los datos que le pertenecen a UN lado (home o away) de un
// enfrentamiento: su puntaje, sus aciertos, y su progreso a medias si lo hay.
function extractSideData(m, side) {
  const r = m.result, p = m.progress;
  return {
    result: r ? {
      score: r[SIDE_SCORE[side]] || 0,
      extra: r[SIDE_EXTRA[side]] || 0,
      absent: readAbsentFlag(r, side),
      answers: (r.questionScores || []).map(qs => ({
        q: qs[SIDE_Q[side]] ?? null,
        c: qs[SIDE_C[side]] ?? null
      }))
    } : null,
    progress: p ? {
      extra: p.extraScores ? (p.extraScores[side] || 0) : 0,
      turns: (p.turnData || []).map(td => td[side] || null)
    } : null
  };
}

// Inyecta los datos extraídos con extractSideData() en el lado indicado de
// otro enfrentamiento (o del mismo), sin tocar el lado contrario.
function applySideData(m, side, data) {
  if (data.result) {
    if (!m.result) {
      m.result = { homeScore: 0, awayScore: 0, extraHome: 0, extraAway: 0, absent: { home: false, away: false }, questionScores: [] };
    }
    if (!m.result.absent || typeof m.result.absent !== 'object') {
      m.result.absent = { home: m.result.absentSide === 'home', away: m.result.absentSide === 'away' };
      delete m.result.absentSide;
    }
    m.result[SIDE_SCORE[side]] = data.result.score || 0;
    m.result[SIDE_EXTRA[side]] = data.result.extra || 0;
    m.result.absent[side] = !!data.result.absent;
    if (!m.result.questionScores) m.result.questionScores = [];
    data.result.answers.forEach((ans, i) => {
      if (!m.result.questionScores[i]) m.result.questionScores[i] = {};
      m.result.questionScores[i][SIDE_Q[side]] = ans.q;
      m.result.questionScores[i][SIDE_C[side]] = ans.c;
    });
  } else if (m.result) {
    m.result[SIDE_SCORE[side]] = 0;
    m.result[SIDE_EXTRA[side]] = 0;
    if (!m.result.absent || typeof m.result.absent !== 'object') {
      m.result.absent = { home: m.result.absentSide === 'home', away: m.result.absentSide === 'away' };
      delete m.result.absentSide;
    }
    m.result.absent[side] = false;
    (m.result.questionScores || []).forEach(qs => { qs[SIDE_Q[side]] = null; qs[SIDE_C[side]] = null; });
  }

  if (data.progress) {
    if (!m.progress) m.progress = { turnData: [], extraScores: { home: 0, away: 0 } };
    if (!m.progress.extraScores) m.progress.extraScores = { home: 0, away: 0 };
    m.progress.extraScores[side] = data.progress.extra || 0;
    if (!m.progress.turnData) m.progress.turnData = [];
    data.progress.turns.forEach((turn, i) => {
      if (!m.progress.turnData[i]) m.progress.turnData[i] = {};
      m.progress.turnData[i][side] = turn;
    });
  } else if (m.progress) {
    if (m.progress.extraScores) m.progress.extraScores[side] = 0;
    (m.progress.turnData || []).forEach(td => { td[side] = null; });
  }
}

/**
 * Cambia de rival a un participante DENTRO de la misma jornada, intercambiando
 * su lugar con otro participante que también juega esa jornada (en otro
 * enfrentamiento, o en el lado contrario del mismo). Cada uno se lleva
 * consigo sus propios aciertos y puntaje ya cargados —si los tenía—; lo único
 * que cambia es contra quién quedó enfrentado. La victoria de cada
 * enfrentamiento se recalcula sola a partir de los puntajes ya guardados,
 * ahora comparados entre quienes terminan cara a cara.
 *
 * sideA/sideB: 'home' | 'away'.
 * Devuelve true si el cambio se pudo aplicar.
 */
export function swapOpponentsInRound(t, roundIndex, matchIndexA, sideA, matchIndexB, sideB) {
  const round = t.rounds?.[roundIndex];
  if (!round) return false;
  const mA = round[matchIndexA], mB = round[matchIndexB];
  if (!mA || !mB) return false;

  const nameA = mA[sideA], nameB = mB[sideB];
  if (!nameA || !nameB || nameA === nameB) return false;

  const dataA = extractSideData(mA, sideA);
  const dataB = extractSideData(mB, sideB);

  mA[sideA] = nameB;
  mB[sideB] = nameA;

  applySideData(mA, sideA, dataB);
  applySideData(mB, sideB, dataA);

  return true;
}

// ---------- Shared ("mismo para todos") por jornada ----------

/**
 * Devuelve las preguntas asignadas a una jornada específica (índice 0-based)
 * cuando el torneo usa contentType 'shared'.
 *
 * Si el torneo tiene `questionsByRound` (consola por jornada), busca la ronda
 * correspondiente. Si no la encuentra, o si el torneo es de un formato anterior
 * que solo tenía un banco plano `questions`, devuelve ese banco como fallback
 * (comportamiento legado: mismas preguntas en todas las jornadas).
 */
export function sharedQuestionsForRound(t, roundIndex) {
  if (t.questionsByRound && t.questionsByRound.length) {
    const entry = t.questionsByRound.find(r => r.round === roundIndex + 1);
    if (entry) return entry.questions || [];
  }
  return t.questions || [];
}

/**
 * Construye una copia editable de `questionsByRound` con una entrada por cada
 * jornada del torneo (t.rounds). Si falta contenido específico para alguna
 * jornada, la rellena con el banco plano legado `t.questions` (si existe),
 * para no perder datos de torneos creados antes de este cambio.
 */
export function ensureQuestionsByRound(t) {
  const existing = t.questionsByRound || [];
  return t.rounds.map((_, i) => {
    const found = existing.find(r => r.round === i + 1);
    return {
      round: i + 1,
      questions: found ? [...found.questions] : [...(t.questions || [])]
    };
  });
}

// ---------- Buffet helpers ----------

/**
 * Shuffle Fisher-Yates (copia, no muta).
 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Recolecta el texto de las preguntas que ya le salieron a un participante
 * en CUALQUIER otro enfrentamiento del torneo (jornadas ya evaluadas o
 * dejadas a medias con progreso guardado). Se usa para no repetirle
 * preguntas de un tema si todavía hay otras sin usar.
 */
function askedQuestionTexts(t, participantName) {
  const asked = new Set();
  (t.rounds || []).forEach(round => {
    (round || []).forEach(m => {
      if (m.home !== participantName && m.away !== participantName) return;
      const side = m.home === participantName ? 'home' : 'away';

      // Enfrentamiento ya evaluado y guardado.
      (m.result?.questionScores || []).forEach(s => {
        const q = side === 'home' ? s.homeQ : s.awayQ;
        if (q?.pregunta) asked.add(q.pregunta);
      });

      // Enfrentamiento a medias (progreso autoguardado).
      (m.progress?.turnData || []).forEach(td => {
        const q = td?.[side]?.question;
        if (q?.pregunta) asked.add(q.pregunta);
      });
    });
  });
  return asked;
}

/**
 * Devuelve los temas asignados al participante agrupados con N preguntas aleatorias cada uno,
 * donde N es `t.questionsPerTema` (1, 2 o 3 — por defecto 3 si el torneo no lo define).
 * Formato: [{ Tema: number|string, questions: [{ pregunta, respuesta, justificacion }] }]
 *
 * Ejemplo: si tiene asignados temas 1, 2, 3 y questionsPerTema = 2 → devuelve 3 grupos,
 * cada uno con hasta 2 preguntas aleatorias de ese tema.
 *
 * Prioriza preguntas que el participante todavía no respondió en jornadas
 * anteriores del torneo: primero arma el grupo al azar entre las preguntas
 * "nuevas" de ese tema, y solo si no alcanzan para completar la cantidad
 * pedida, rellena con preguntas ya usadas (también elegidas al azar) para
 * no dejar el tema corto.
 */
export function buffetTemasForParticipant(t, participantName) {
  const Temas = (t.participantTemas && t.participantTemas[participantName]) || [];
  const bd = t.buffetData;
  if (!bd || !bd.Temas) return [];
  const perTema = [1, 2, 3].includes(t.questionsPerTema) ? t.questionsPerTema : 3;
  const asked = askedQuestionTexts(t, participantName);
  const result = [];
  Temas.forEach(d => {
    const TemaObj = bd.Temas.find(x => String(x.Tema) === String(d));
    if (!TemaObj) return;
    const allQ = (TemaObj.preguntas || []).map(p => ({
      pregunta: p.pregunta || '',
      respuesta: p.respuesta || '',
      justificacion: p.justificacion || ''
    }));
    const nuevas = allQ.filter(q => !asked.has(q.pregunta));
    const yaUsadas = allQ.filter(q => asked.has(q.pregunta));

    let picked = shuffle(nuevas).slice(0, perTema);
    if (picked.length < perTema) {
      picked = picked.concat(shuffle(yaUsadas).slice(0, perTema - picked.length));
    }
    result.push({ Tema: d, questions: shuffle(picked) });
  });
  return result;
}

/**
 * Compatibilidad: devuelve [{ text }] plano aplanando los temas.
 * N temas × questionsPerTema preguntas = total de items.
 */
export function buffetItemsForParticipant(t, participantName) {
  const grouped = buffetTemasForParticipant(t, participantName);
  const items = [];
  grouped.forEach(g => g.questions.forEach(q => items.push(q)));
  return items;
}

// ---------- Utilidad HTML ----------
export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}