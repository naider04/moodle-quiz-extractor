const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { collect } = require('./collector');

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

app.listen(PORT, () => {
  console.log(`\n  Moodle Quiz Collector running at http://localhost:${PORT}\n`);
});
