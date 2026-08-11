const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { collect } = require('./collector');
const fb = require('./firebase_sync');

const app = express();
const PORT = process.env.PORT || 3000; // Render sets PORT; local dev defaults to 3000
const outDir = path.join(__dirname, 'output');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve downloaded media (audio, images) at /resources/*
app.use('/resources', express.static(path.join(outDir, 'resources')));

// ── Login: get a Moodle web-service token ──────────────────────────
app.post('/api/login', async (req, res) => {
  const { moodleUrl, username, password } = req.body;
  if (!moodleUrl || !username || !password) {
    return res.status(400).json({ error: 'URL, username, and password are required.' });
  }
  try {
    // Accept "aulagradob.unemi.edu.ec" without a scheme: prepend https://
    // (or keep an explicit http://).
    let baseUrl = String(moodleUrl || '').trim().replace(/\/+$/, '');
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = 'https://' + baseUrl;
    if (!baseUrl) {
      return res.status(400).json({ error: 'URL, username, and password are required.' });
    }
    const tokenRes = await fetch(
      `${baseUrl}/login/token.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&service=moodle_mobile_app`,
    );
    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      return res.status(401).json({ error: tokenData.error || 'Login failed.' });
    }
    const siteInfoRes = await fetch(
      `${baseUrl}/webservice/rest/server.php?wstoken=${encodeURIComponent(tokenData.token)}&wsfunction=core_webservice_get_site_info&moodlewsrestformat=json`
    );
    const siteInfo = await siteInfoRes.json();
    res.json({
      token: tokenData.token,
      baseUrl,
      userId: siteInfo.userid,
      fullname: siteInfo.fullname,
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to connect: ${err.message}` });
  }
});

// ── Collect: run the full quiz extraction (SSE) ─────────────────────
app.get('/api/collect', (req, res) => {
  const { baseUrl, token, userId } = req.query;
  if (!baseUrl || !token || !userId) {
    return res.status(400).json({ error: 'Missing baseUrl, token, or userId.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  fs.mkdirSync(outDir, { recursive: true });

  collect(baseUrl, token, parseInt(userId), outDir, (msg) => {
    send('progress', { message: msg });
  })
    .then((result) => {
      send('done', result);
      res.end();
    })
    .catch((err) => {
      send('error', { message: err.message });
      res.end();
    });
});

// ── Result: serve collected JSON for in-browser rendering ───────────
app.get('/api/result', (req, res) => {
  const jsonFile = path.join(outDir, 'quiz_study_data.json');
  if (!fs.existsSync(jsonFile)) {
    return res.status(404).json({ error: 'No data yet. Run a collection first.' });
  }
  res.sendFile(jsonFile);
});

// ── Download the generated output as a ZIP ─────────────────────────
app.get('/api/download', (req, res) => {
  const htmlFile = path.join(outDir, 'quiz_study_guide.html');
  if (!fs.existsSync(htmlFile)) {
    return res.status(404).json({ error: 'No generated output found. Run the collector first.' });
  }

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="moodle_quiz_guide.zip"',
  });

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  archive.file(htmlFile, { name: 'quiz_study_guide.html' });

  const resourcesDir = path.join(outDir, 'resources');
  if (fs.existsSync(resourcesDir)) {
    archive.directory(resourcesDir, 'resources');
  }

  const jsonData = path.join(outDir, 'quiz_study_data.json');
  if (fs.existsSync(jsonData)) {
    archive.file(jsonData, { name: 'quiz_study_data.json' });
  }

  archive.finalize();
});

// ── Simulator: read the unique-question bank from Firestore ────────
// Media: the bank may have been uploaded by another collector, so a
// localFile only survives when the file actually exists on THIS server
// (otherwise the browser falls back to the remote Moodle URL).
function mediaLocalExists(list) {
  return (list || []).map((m) => ({
    url: m.url,
    localFile:
      m.localFile && fs.existsSync(path.join(outDir, 'resources', m.localFile))
        ? m.localFile
        : '',
  }));
}

// ddwtos/gapselect: the parser never captured the draggable choices for this
// Moodle version, but the review feedback lists the right answers in brackets
// ("… [Respuesta 1] [Respuesta 2] …"). Rebuild the choice pool from those so
// the simulator can offer selectable gaps instead of static boxes.
function gapChoicesFromFeedback(q) {
  const fb = String(q.feedback || '').replace(/\u0002[^\u0002]*\u0002/g, '');
  const matches = fb.match(/\[([^\]]+)\]/g) || [];
  return matches
    .map((m, i) => ({
      letter: String.fromCharCode(97 + i),
      text: m.slice(1, -1).trim(),
      optionImages: [],
      selected: false,
      markedCorrect: false,
      markedIncorrect: false,
      index: i,
    }))
    .filter((o) => o.text);
}

function normalizeSimQuestion(q) {
  const copy = {
    ...q,
    images: mediaLocalExists(q.images),
    audios: mediaLocalExists(q.audios),
    feedbackImages: mediaLocalExists(q.feedbackImages),
  };
  copy.options = (q.options || []).map((o) => ({ ...o, optionImages: mediaLocalExists(o.optionImages) }));
  copy.subQuestions = (q.subQuestions || []).map((s) => ({
    ...s,
    options: (s.options || []).map((o) => ({ ...o, optionImages: mediaLocalExists(o.optionImages) })),
  }));
  if ((q.type === 'ddwtos' || q.type === 'gapselect') && !(copy.options || []).length) {
    copy.options = gapChoicesFromFeedback(q);
  }
  if (q.type === 'match') matchAnswersFromFeedback(copy);
  return copy;
}

// match: the parser never marked per-stem correctness, but the review
// feedback lists "Stem → Answer, Stem → Answer, …" in the same order as the
// stems. Anchor on the known stems to recover each correct answer robustly
// (stems and answers may contain commas).
function matchAnswersFromFeedback(q) {
  const subs = q.subQuestions || [];
  if (!subs.length) return;
  if (subs.some((s) => (s.options || []).some((o) => o.markedCorrect))) return; // already known
  const fb = String(q.feedback || '').replace(/\u0002[^\u0002]*\u0002/g, '');
  if (!fb) return;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const stems = subs.map((s) => norm(s.questionText));
  const fbN = norm(fb);
  const answers = new Array(subs.length).fill(null);
  for (let i = 0; i < stems.length; i++) {
    const stem = stems[i];
    if (!stem) continue;
    let start = fbN.indexOf(stem);
    if (start === -1) continue;
    start += stem.length;
    // Answer ends where the earliest OTHER stem appears after this one
    // (Moodle may list the pairs in any order, so use every stem as a
    // boundary, not just the next one).
    let end = fbN.length;
    for (let j = 0; j < stems.length; j++) {
      if (j === i || !stems[j]) continue;
      const pos = fbN.indexOf(stems[j], start);
      if (pos !== -1 && pos < end) end = pos;
    }
    const raw = fbN.slice(start, end).trim();
    const m = raw.match(/^→\s*([\s\S]*?)\s*$/);
    if (!m) continue;
    const ans = m[1].replace(/,\s*$/, '').trim();
    if (ans) answers[i] = ans;
  }
  for (let i = 0; i < subs.length; i++) {
    if (!answers[i]) continue;
    const opt = (subs[i].options || []).find((o) => norm(o.text) === answers[i]);
    if (opt) opt.markedCorrect = true;
  }
}

// List every course in the bank, so the UI can map a locally collected
// course (baseUrl + courseId) to its Firestore key.
app.get('/api/simulator/courses', async (req, res) => {
  if (!fb.isConfigured()) {
    return res.status(503).json({ error: 'El banco de preguntas no está configurado en este servidor.' });
  }
  try {
    const db = fb.getFirestore();
    const snap = await db.collection('courses').get();
    const courses = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      courses.push({
        courseKey: doc.id,
        name: d.name,
        courseId: d.courseId,
        baseUrl: d.baseUrl,
        quizCount: d.quizzes || 0,
        questionCount: d.questions || 0,
        updatedAt: d.updatedAt || null,
      });
    });
    courses.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    res.json(courses);
  } catch (err) {
    res.status(500).json({ error: `Error leyendo el banco: ${err.message}` });
  }
});

// All unique questions of one course, pooled across its quizzes and
// renumbered 1..N for the practice session.
app.get('/api/simulator/course', async (req, res) => {
  const courseKey = String(req.query.course || '');
  if (!courseKey) return res.status(400).json({ error: 'Falta el parámetro course.' });
  if (!fb.isConfigured()) {
    return res.status(503).json({ error: 'El banco de preguntas no está configurado en este servidor.' });
  }
  try {
    const db = fb.getFirestore();
    const courseRef = db.collection('courses').doc(courseKey);
    const courseSnap = await courseRef.get();
    if (!courseSnap.exists) {
      return res.status(404).json({ error: 'Materia no encontrada en el banco.' });
    }
    const c = courseSnap.data();
    const quizSnap = await courseRef.collection('quizzes').get();
    const quizzes = [];
    const pooled = [];
    quizSnap.forEach((doc) => {
      const qz = doc.data() || {};
      quizzes.push({
        quizId: qz.quizId,
        name: qz.name,
        cmid: qz.cmid || null,
        attempts: qz.attempts || 0,
        uniqueQuestionCount: (qz.questions || []).length,
      });
      for (const q of qz.questions || []) {
        const norm = normalizeSimQuestion(q);
        norm.sourceQuiz = qz.name || '';
        pooled.push(norm);
      }
    });
    pooled.forEach((q, i) => {
      q.questionNumber = i + 1;
    });
    res.json({
      courseKey,
      name: c.name,
      courseId: c.courseId,
      baseUrl: c.baseUrl,
      quizzes,
      questionCount: pooled.length,
      questions: pooled,
    });
  } catch (err) {
    res.status(500).json({ error: `Error leyendo el banco: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Moodle Quiz Collector running at http://localhost:${PORT}\n`);
});
