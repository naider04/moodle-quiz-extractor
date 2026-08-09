const d = require('./output/quiz_study_data.json');
const servers = Array.isArray(d) ? d : Object.values(d);
function questionKey(q, mode) {
  let opts = (q.options || []).map(o => (o.text || '').trim());
  if (mode === 'sorted') opts = [...opts].sort();
  if (mode === 'none') opts = [];
  return [q.type, (q.questionText || '').trim(), opts.join(' | ')].join(' @@ ');
}
for (const s of servers) {
  for (const c of s.courses) {
    for (const qz of c.quizzes) {
      if (String(qz.cmid) !== '103316') continue;
      const atts = qz.attemptsData || [];
      const allQs = [];
      for (const att of atts) for (const q of att.questions) allQs.push(q);
      for (const mode of ['ordered', 'none', 'sorted']) {
        const seen = new Map();
        for (const q of allQs) {
          const k = questionKey(q, mode);
          if (!seen.has(k)) seen.set(k, { q, n: 0 });
          seen.get(k).n++;
        }
        const reps = [...seen.values()];
        const maxRep = Math.max(...reps.map(r => r.n));
        const dist = {};
        for (const r of reps) dist[r.n] = (dist[r.n] || 0) + 1;
        console.log(`modo=${mode}: únicas=${seen.size} | repeticiones por pregunta: ${JSON.stringify(dist)} | máx repetida=${maxRep}`);
      }
    }
  }
}
