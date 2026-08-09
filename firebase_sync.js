#!/usr/bin/env node
// firebase_sync.js — Deduplicate quiz questions by content and persist the
// unique question bank to Firestore, classified by course and quiz.
//
//   node firebase_sync.js --dry-run             # report only (no Firebase needed)
//   node firebase_sync.js                       # upload to Firestore
//   node firebase_sync.js --data path/to.json   # use a different data file
//
// Firebase credentials (tried in order):
//   1. env FIREBASE_SERVICE_ACCOUNT (JSON string, for Render)
//   2. env GOOGLE_APPLICATION_CREDENTIALS (path to service-account JSON)
//   3. web/firebase-service-account.json (gitignored, for local dev)
//
// Firestore layout:
//   courses/{hostSlug}__{courseId}                  → {name, courseId, baseUrl, quizzes, questions, updatedAt}
//   courses/{hostSlug}__{courseId}/quizzes/{quizKey} → {name, quizId, cmid, attempts, uniqueQuestionCount, questions:[…], updatedAt}
//
// Each question in the bank keeps the EXACT shape the renderers expect
// (type, questionText, options, subQuestions, images, audios, feedback…), so
// the stored JSON can be rendered the same way as the per-attempt reviews.
// Student-specific state (selected answers, marks, essay text) is cleared;
// static correctness marks Moodle gives in the review (markedCorrect /
// markedIncorrect) are kept because they identify the right answer.

const fs = require('fs');
const path = require('path');

// ─── Firebase init (lazy: never touched unless credentials exist) ─────
let firestore = null;

function isConfigured() {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      fs.existsSync(path.join(__dirname, 'firebase-service-account.json')),
  );
}

function getFirestore() {
  if (firestore) return firestore;
  const admin = require('firebase-admin');
  let cred;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    cred = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  } else {
    const local = path.join(__dirname, 'firebase-service-account.json');
    if (fs.existsSync(local)) cred = local;
  }
  if (!cred) return null;
  // firebase-admin >= 14: cert() is top-level and Firestore lives in the
  // firebase-admin/firestore subpath (admin.credential / admin.firestore are gone).
  admin.initializeApp({ credential: admin.cert(cred) });
  const { getFirestore } = require('firebase-admin/firestore');
  firestore = getFirestore();
  return firestore;
}

// ─── Text helpers ─────────────────────────────────────────────────────
function slug(str) {
  return (
    String(str || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // strip accents (ñ → n, á → a)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'x'
  );
}

// The dedup key must only use STATIC question content. Moodle shuffles
// answer-option order per attempt, so options are sorted before comparing;
// ddwtos/gapselect embed the student's answer in boxed spans, so those are
// blanked out. Anything that varies per attempt (selected flags, marks,
// essay text, match/ddwtos chosen answers) is excluded.
function uniqueKey(q) {
  let text = String(q.questionText || '').trim();
  text = text.replace(/<span class="ddwtos-answer">[\s\S]*?<\/span>/g, '___');
  const optKey = (o) =>
    String(o.text || '').trim() + '|' + (o.optionImages || []).map((i) => i.url).join('+');
  const opts = (q.options || []).map(optKey).sort().join(' | ');
  const subStems = (q.subQuestions || []).map((s) => String(s.questionText || '').trim()).join(' | ');
  const subOpts = (q.subQuestions || [])
    .map((s) => (s.options || []).map(optKey).sort().join(' , '))
    .join(' ; ');
  const imgs = (q.images || []).map((i) => i.url).join('+');
  const auds = (q.audios || []).map((i) => i.url).join('+');
  const fbi = (q.feedbackImages || []).map((i) => i.url).join('+');
  const fb = String(q.feedback || '').trim();
  return [q.type, text, opts, subStems, subOpts, imgs, auds, fbi, fb].join(' @@ ');
}

// Static version of the question text: for ddwtos/gapselect the student's
// answer is replaced with a neutral "gap" box so the bank reads as a blank
// to fill (the correct answers live in `feedback` for those types).
function staticText(q) {
  let t = String(q.questionText || '');
  if (q.type === 'ddwtos' || q.type === 'gapselect') {
    t = t.replace(
      /<span class="ddwtos-answer">[\s\S]*?<\/span>/g,
      '<span class="ddwtos-answer">…</span>',
    );
  }
  return t;
}

// Convert one parsed attempt question into its bank form. The shape mirrors
// what parseQuestion() produces so the existing renderers work unchanged.
function canonicalize(q) {
  const opt = (o) => ({
    letter: o.letter,
    text: o.text,
    optionImages: (o.optionImages || []).map((m) => ({ url: m.url, localFile: m.localFile || '' })),
    selected: false,
    markedCorrect: !!o.markedCorrect,
    markedIncorrect: !!o.markedIncorrect,
    index: o.index,
  });
  const sub = (s) => ({
    number: s.number,
    questionText: s.questionText,
    type: s.type,
    options: (s.options || []).map(opt),
    selectedText: '',
    isCorrect: false,
    isIncorrect: false,
  });
  return {
    questionBank: true, // renderers show a neutral header ("P1", no marks)
    questionNumber: 0, // renumbered below
    type: q.type,
    questionText: staticText(q),
    subQuestions: (q.subQuestions || []).map(sub),
    options: (q.options || []).map(opt),
    selectedValue: -1,
    markObtained: 0,
    markMax: q.markMax || 0,
    isCorrect: false,
    isWrong: false,
    images: (q.images || []).map((m) => ({ url: m.url, localFile: m.localFile || '' })),
    audios: (q.audios || []).map((m) => ({ url: m.url, localFile: m.localFile || '' })),
    feedbackImages: (q.feedbackImages || []).map((m) => ({ url: m.url, localFile: m.localFile || '' })),
    essayResponse: '',
    feedback: q.feedback || '',
  };
}

// Dedupe all questions across every attempt of one quiz. Returns the bank
// array (renumbered 1..N) with per-question aggregate stats attached.
function buildUniqueQuestions(attemptsData) {
  const seen = new Map(); // key → { canonical, stats }
  for (const att of attemptsData || []) {
    for (const q of att.questions || []) {
      const key = uniqueKey(q);
      let entry = seen.get(key);
      if (!entry) {
        entry = {
          canonical: canonicalize(q),
          stats: { seenInAttempts: 0, timesCorrect: 0, timesWrong: 0, timesPartial: 0, totalMarkPct: 0 },
        };
        seen.set(key, entry);
      }
      entry.stats.seenInAttempts++;
      if (q.isCorrect) entry.stats.timesCorrect++;
      else if (q.isWrong) entry.stats.timesWrong++;
      else entry.stats.timesPartial++;
      entry.stats.totalMarkPct += q.markMax > 0 ? (q.markObtained / q.markMax) * 100 : 0;
    }
  }
  const list = [...seen.values()].map((e, i) => {
    const s = e.stats;
    e.canonical.questionNumber = i + 1;
    e.canonical.stats = {
      seenInAttempts: s.seenInAttempts,
      timesCorrect: s.timesCorrect,
      timesWrong: s.timesWrong,
      timesPartial: s.timesPartial,
      avgMarkPct: Math.round((s.totalMarkPct / s.seenInAttempts) * 10) / 10,
    };
    return e.canonical;
  });
  return list;
}

// ─── Sync ─────────────────────────────────────────────────────────────
async function syncServers(servers, log = console.log) {
  const db = getFirestore();
  if (!db) {
    throw new Error('Firebase no está configurado (falta la credencial de servicio).');
  }
  let courses = 0;
  let quizzes = 0;
  let questions = 0;
  for (const s of servers) {
    const hostSlug = slug(s.baseUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, ''));
    for (const c of s.courses || []) {
      const courseKey = `${hostSlug}__${c.courseId}`;
      const courseRef = db.collection('courses').doc(courseKey);
      let quizCount = 0;
      let qCount = 0;
      for (const qz of c.quizzes || []) {
        const attemptsData = qz.attemptsData || [];
        if (!attemptsData.length) continue;
        const unique = buildUniqueQuestions(attemptsData);
        if (!unique.length) continue;
        const quizKey = `${slug(qz.name)}__${qz.quizId}`;
        await db
          .collection('courses')
          .doc(courseKey)
          .collection('quizzes')
          .doc(quizKey)
          .set({
            name: qz.name,
            quizId: qz.quizId,
            cmid: qz.cmid || null,
            attempts: attemptsData.length,
            uniqueQuestionCount: unique.length,
            questions: unique,
            updatedAt: new Date().toISOString(),
          });
        log(`  ${qz.name} → ${attemptsData.length} intentos → ${unique.length} preguntas únicas`);
        quizCount++;
        qCount += unique.length;
      }
      if (quizCount > 0) {
        await courseRef.set(
          {
            name: c.name,
            courseId: c.courseId,
            baseUrl: s.baseUrl,
            quizzes: quizCount,
            questions: qCount,
            updatedAt: new Date().toISOString(),
          },
          { merge: true },
        );
        courses++;
        quizzes += quizCount;
        questions += qCount;
      }
    }
  }
  return { courses, quizzes, questions };
}

// ─── CLI ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const dataIdx = args.indexOf('--data');
  const dataPath =
    dataIdx >= 0 ? args[dataIdx + 1] : path.join(__dirname, 'output', 'quiz_study_data.json');

  let servers;
  try {
    const parsed = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    servers = Array.isArray(parsed) ? parsed : Object.values(parsed);
  } catch (e) {
    console.error(`No se pudo leer ${dataPath}: ${e.message}`);
    process.exit(1);
  }

  console.log(`Datos: ${dataPath} (${servers.length} servidor(es))\n`);
  let totalCourses = 0;
  let totalQuizzes = 0;
  let totalUnique = 0;
  for (const s of servers) {
    console.log(`● ${s.baseUrl}`);
    for (const c of s.courses || []) {
      const withQuestions = (c.quizzes || []).filter((qz) => (qz.attemptsData || []).length);
      if (!withQuestions.length) continue;
      totalCourses++;
      console.log(`  ─ ${c.name}`);
      for (const qz of withQuestions) {
        const unique = buildUniqueQuestions(qz.attemptsData);
        const seen = unique.reduce((a, q) => a + (q.stats ? q.stats.seenInAttempts : 0), 0);
        console.log(
          `    ${qz.name}: ${unique.length} únicas de ${(qz.attemptsData || []).length} intentos (${seen} instancias)`,
        );
        totalQuizzes++;
        totalUnique += unique.length;
      }
    }
  }
  console.log(
    `\nResumen: ${totalCourses} cursos, ${totalQuizzes} quizzes, ${totalUnique} preguntas únicas`,
  );

  if (dry) {
    console.log('\n(--dry-run: nada se subió. Quita --dry-run para subir a Firestore.)');
    process.exit(0);
  }
  if (!isConfigured()) {
    console.error(
      '\nFirebase no está configurado. Coloca web/firebase-service-account.json o define\n' +
        'FIREBASE_SERVICE_ACCOUNT (JSON) / GOOGLE_APPLICATION_CREDENTIALS (ruta).\n' +
        'Para solo reportar usa --dry-run.',
    );
    process.exit(1);
  }
  syncServers(servers)
    .then((r) => {
      console.log(
        `\nSubido a Firestore: ${r.courses} cursos, ${r.quizzes} quizzes, ${r.questions} preguntas únicas`,
      );
    })
    .catch((e) => {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    });
}

module.exports = { isConfigured, syncServers, buildUniqueQuestions, uniqueKey };
