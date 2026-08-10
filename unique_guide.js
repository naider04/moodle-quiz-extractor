#!/usr/bin/env node
// unique_guide.js — Generate a static HTML with the UNIQUE questions of one
// quiz (deduplicated across all its attempts), rendered with the same engine
// (buildStaticGuide) as the per-attempt study guide.
//
//   node unique_guide.js                                  # default: Simulador Grammar
//   node unique_guide.js --host https://aulagradoa.unemi.edu.ec --cmid 103316
//   node unique_guide.js --cmid 61445 --out output/banco.html

const fs = require('fs');
const path = require('path');
const { buildStaticGuide } = require('./collector');
const { buildUniqueQuestions } = require('./firebase_sync');

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const host = argVal('--host', 'https://aulagradoa.unemi.edu.ec').replace(/\/+$/, '');
const cmid = String(argVal('--cmid', '103316'));
const out = argVal(
  '--out',
  path.join(__dirname, 'output', `quiz_unique_cmid${cmid}.html`),
);

const dataFile = path.join(__dirname, 'output', 'quiz_study_data.json');
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
} catch (e) {
  console.error(`No se pudo leer ${dataFile}: ${e.message}`);
  process.exit(1);
}
const servers = Array.isArray(parsed) ? parsed : Object.values(parsed);

let found = null;
for (const s of servers) {
  if (String(s.baseUrl).replace(/\/+$/, '') !== host) continue;
  for (const c of s.courses) {
    for (const qz of c.quizzes) {
      if (String(qz.cmid) !== cmid) continue;
      found = { server: s, course: c, quiz: qz };
    }
  }
}
if (!found) {
  console.error(`No se encontró quiz con cmid=${cmid} en ${host}`);
  console.error('Quizzes disponibles:');
  for (const s of servers) {
    for (const c of s.courses) {
      for (const qz of c.quizzes) {
        console.error(`  ${s.baseUrl}  cmid=${qz.cmid}  ${qz.name}`);
      }
    }
  }
  process.exit(1);
}

const { server, course, quiz } = found;
const attemptsData = quiz.attemptsData || [];
if (!attemptsData.length) {
  console.error(`El quiz "${quiz.name}" no tiene intentos terminados.`);
  process.exit(1);
}

const bank = buildUniqueQuestions(attemptsData);
if (!bank.length) {
  console.error('No se pudo construir el banco de preguntas únicas.');
  process.exit(1);
}
console.log(`${quiz.name}: ${attemptsData.length} intentos → ${bank.length} preguntas únicas`);

// Wrap the bank as a single synthetic attempt so the SAME engine renders it:
// same CSS, same per-question renderer, same helpers.
const synthetic = [
  {
    baseUrl: server.baseUrl,
    courses: [
      {
        name: course.name,
        courseId: course.courseId,
        quizzes: [
          {
            name: quiz.name,
            quizId: quiz.quizId,
            cmid: quiz.cmid,
            sumGrades: quiz.sumGrades,
            bestGrade: null,
            attempts: attemptsData.length, // real attempt count (for the header)
            folder: '',
            questions: bank,
            attemptsData: [{ attemptNumber: 1, score: null, questions: bank }],
          },
        ],
      },
    ],
  },
];

fs.writeFileSync(out, buildStaticGuide(synthetic, { bank: true }), 'utf8');
console.log(`Banco de preguntas únicas → ${out}`);
