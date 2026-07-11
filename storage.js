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
 * Devuelve los temas asignados al participante agrupados con 3 preguntas aleatorias cada uno.
 * Formato: [{ Tema: number|string, questions: [{ pregunta, respuesta, justificacion }] }]
 *
 * Ejemplo: si tiene asignados temas 1, 2, 3 → devuelve 3 grupos,
 * cada uno con hasta 3 preguntas aleatorias de ese tema.
 *
 * Prioriza preguntas que el participante todavía no respondió en jornadas
 * anteriores del torneo: primero arma el grupo al azar entre las preguntas
 * "nuevas" de ese tema, y solo si no alcanzan para completar 3, rellena con
 * preguntas ya usadas (también elegidas al azar) para no dejar el tema corto.
 */
export function buffetTemasForParticipant(t, participantName) {
  const Temas = (t.participantTemas && t.participantTemas[participantName]) || [];
  const bd = t.buffetData;
  if (!bd || !bd.Temas) return [];
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

    let picked = shuffle(nuevas).slice(0, 3);
    if (picked.length < 3) {
      picked = picked.concat(shuffle(yaUsadas).slice(0, 3 - picked.length));
    }
    result.push({ Tema: d, questions: shuffle(picked) });
  });
  return result;
}

/**
 * Compatibilidad: devuelve [{ text }] plano aplanando los temas.
 * 3 temas × 3 preguntas = 9 items.
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