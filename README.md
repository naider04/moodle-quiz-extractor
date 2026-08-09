# Moodle Quiz Collector

Extracts Moodle quiz reviews (every attempt) via the Moodle web service and renders a study guide.

## Local run

```sh
npm install
npm start          # → http://localhost:3000
```

Collect with your Moodle credentials in the UI (`/api/login` + `/api/collect`). Data lands in `output/quiz_study_data.json` (per-attempt reviews) and `output/quiz_study_guide.html` (static guide).

## Firebase unique-question bank

The app keeps showing **all attempts**. Additionally, the collector deduplicates questions **by content** (ignoring option order — Moodle shuffles per attempt — and student answers) and stores the unique question bank in Firestore, classified by course and quiz:

```
courses/{host}__{courseId}            → course doc
courses/{host}__{courseId}/quizzes/{quizSlug}__{quizId}  → {name, attempts, uniqueQuestionCount, questions:[…]}
```

Question objects keep the exact shape the renderers use (type, questionText, options, subQuestions, images, audios, feedback), with student-specific state cleared, correctness marks kept, and aggregate `stats` (times seen/correct/wrong, avg mark %).

### Sync

```sh
node firebase_sync.js --dry-run   # report unique counts per course/quiz (no Firebase needed)
node firebase_sync.js             # upload to Firestore
node firebase_sync.js --data other.json
```

Credentials are picked up from, in order:

1. env `FIREBASE_SERVICE_ACCOUNT` (JSON string — set this in Render → Settings → Environment)
2. env `GOOGLE_APPLICATION_CREDENTIALS` (path)
3. `web/firebase-service-account.json` (gitignored, for local dev)

When credentials exist, `collect()` also auto-syncs the bank at the end of a collection.

Firestore rules (`firestore.rules`): public read, server-only writes (admin SDK bypasses rules).
