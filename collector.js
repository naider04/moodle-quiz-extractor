const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ─── Small text helpers ──────────────────────────────────────────────
// Images inside question/feedback text become this marker so their position in
// the text flow survives stripHtml (text → break → image → break → text, just
// like Moodle). The renderers swap it back for an <img> tag.
const IMG_T = '\u0002';
function imgToTokens(htmlStr) {
  return String(htmlStr || '').replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, (m, src) => {
    const url = src.replace(/&amp;/g, '&').trim();
    return url ? IMG_T + url + IMG_T : '';
  });
}
function imgTokenRe() {
  return new RegExp(IMG_T + '([^' + IMG_T + ']+)' + IMG_T, 'g');
}

function stripHtml(html) {
  if (!html) return '';
  let li = 0;
  // Structural line breaks use a NUL marker so they survive the source-
  // whitespace collapse below (raw newlines in the HTML are formatting and
  // collapse to a single space, exactly like a browser does).
  const NL = '\u0000';
  return String(html)
    .replace(/<ol[^>]*>/gi, () => { li = 0; return NL; })
    .replace(/<li[^>]*>/gi, () => { li++; return `${NL}${li}. `; })
    .replace(/<\/li>/gi, '')
    .replace(/<\/ol>/gi, NL)
    .replace(/<br\s*\/?>/gi, NL)
    .replace(/<\/p>\s*<p[^>]*>/gi, NL)
    .replace(/<\/p>/gi, NL)
    .replace(/<\/h[1-6]>/gi, NL)
    .replace(/<hr[^>]*>/gi, NL)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')          // collapse source whitespace (HTML semantics)
    .replace(/&nbsp;/gi, '\u00A0') // real NBSP: survives collapsing, preserves alignment
    .replace(/&#160;/gi, '\u00A0')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2011;/gi, '-') // non-breaking hyphen → plain hyphen
    .replace(/&#8211;|&ndash;/gi, '\u2013')
    .replace(/&#8212;|&mdash;/gi, '\u2014')
    .replace(/&#8230;|&hellip;/gi, '\u2026')
    .replace(/&#8220;|&ldquo;/gi, '\u201C')
    .replace(/&#8221;|&rdquo;/gi, '\u201D')
    .replace(/&#8216;|&lsquo;/gi, '\u2018')
    .replace(/&#8217;|&rsquo;/gi, '\u2019')
    .replace(/&#183;|&middot;/gi, '\u00B7')
    .replace(new RegExp(NL + '+', 'g'), NL)  // one break per structural element
    .replace(new RegExp(NL + ' +', 'g'), NL) // strip spaces right after a break
    .replace(new RegExp(' +' + NL, 'g'), NL) // strip spaces right before a break
    .replace(new RegExp(NL, 'g'), '\n')
    .replace(/[ \u00A0]+\n/g, '\n')  // strip trailing spaces/NBSPs at line ends
    .trim();
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Moodle web-service call ─────────────────────────────────────────
async function wsCall(baseUrl, token, wsfunction, params = {}) {
  const qs = new URLSearchParams({
    wstoken: token,
    wsfunction,
    moodlewsrestformat: 'json',
  });
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((vv, i) => qs.append(`${k}[${i}]`, String(vv)));
    else qs.append(k, String(v));
  }
  const res = await fetch(`${baseUrl}/webservice/rest/server.php?${qs.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} para ${wsfunction}`);
  const data = await res.json();
  if (data && data.exception) {
    throw new Error(data.message || data.errorcode || `Error en ${wsfunction}`);
  }
  return data;
}

// ─── Multianswer (cloze) parser ──────────────────────────────────────
function parseMultianswer(html) {
  let questionText = '';

  // Main question text — classic layouts render it in <div class="qtext">;
  // newer themes put the whole intro in the formulation without that div.
  const qtextMatch = html.match(
    /<div class="qtext"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<fieldset|<div class="(?:ablock|answer))/i,
  );
  if (qtextMatch) {
    questionText = stripHtml(qtextMatch[1]).trim();
  } else {
    // Everything in the formulation before the first answer block, minus
    // media players (audios are rendered separately) and hidden labels.
    let introHtml = html;
    const formStart = introHtml.indexOf('<div class="formulation');
    if (formStart >= 0) introHtml = introHtml.slice(formStart);
    const firstBlock = introHtml.search(/<(?:fieldset|div)\s+class="answer"|<span class="subquestion"/i);
    if (firstBlock >= 0) {
      // Trim the intro at the first sub-question stem (the last <strong>
      // right before the first answer block), so stems aren't duplicated.
      const windowStart = Math.max(0, firstBlock - 500);
      const strongs = [...introHtml.slice(windowStart, firstBlock).matchAll(/<strong[^>]*>([\s\S]*?)<\/strong>/gi)];
      if (strongs.length) introHtml = introHtml.slice(0, windowStart + strongs[strongs.length - 1].index);
      else introHtml = introHtml.slice(0, firstBlock);
    }
    introHtml = introHtml.replace(/<(?:audio|video)[^>]*>[\s\S]*?<\/(?:audio|video)>|<(?:audio|video)[^>]*\/?>/gi, '');
    introHtml = introHtml.replace(/<h4 class="accesshide">[\s\S]*?<\/h4>/gi, '');
    questionText = stripHtml(introHtml).trim();
  }

  const subQuestions = [];
  let idx = 0;

  // Stem text for a sub-question: the last <strong> (or <p>) right before
  // the answer block that holds it.
  const stemBefore = (htmlSource, index, windowSize) => {
    const before = htmlSource.slice(Math.max(0, index - windowSize), index);
    const strongs = [...before.matchAll(/<strong[^>]*>([\s\S]*?)<\/strong>/gi)];
    if (strongs.length) return stripHtml(strongs[strongs.length - 1][1]).trim();
    const ps = [...before.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
    if (ps.length) return stripHtml(ps[ps.length - 1][1]).trim();
    return '';
  };

  // ── Layout A: <span class="subquestion"><select>…</select></span> ──
  // Used by e.g. listening quizzes with cloze dropdowns.
  const subqRe = /<span class="subquestion">([\s\S]*?)<\/span>/gi;
  let sm;
  while ((sm = subqRe.exec(html)) !== null) {
    const inner = sm[1];
    const selectMatch = inner.match(/<select[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/select>/i);
    if (!selectMatch) continue;
    const selClasses = selectMatch[1];
    const isCorrect = /\bcorrect\b/.test(selClasses);
    const isIncorrect = /\bincorrect\b/.test(selClasses);
    const opts = [];
    let selectedText = '';
    const optRe = /<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;
    let om;
    let optIndex = 0;
    while ((om = optRe.exec(selectMatch[2])) !== null) {
      const value = om[1];
      const text = stripHtml(om[2]).trim();
      const isSelected = /selected\s*=\s*["']?selected["']?/i.test(om[0]);
      if (value === '' || !text) continue; // placeholder row
      opts.push({
        letter: String.fromCharCode(97 + optIndex),
        text,
        optionImages: [],
        selected: isSelected,
        markedCorrect: isSelected && isCorrect,
        markedIncorrect: isSelected && isIncorrect,
        index: optIndex,
      });
      if (isSelected) selectedText = text;
      optIndex++;
    }
    subQuestions.push({
      number: ++idx,
      questionText: stemBefore(html, sm.index, 400),
      options: opts,
      selectedText,
      isCorrect,
      isIncorrect,
      type: 'multianswer',
    });
  }

  // ── Layout B: <fieldset class="answer"> with form-check radios ──
  // Used by e.g. listening exams rendered as radio options per question.
  const fieldsetRe = /<fieldset[^>]*class="answer"[^>]*>([\s\S]*?)<\/fieldset>/gi;
  let fm;
  while ((fm = fieldsetRe.exec(html)) !== null) {
    const blockHtml = fm[1];
    const opts = [];
    let selectedText = '';
    let selectedOpt = null;
    const optRe = /<div class="form-check[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let om;
    let optIndex = 0;
    while ((om = optRe.exec(blockHtml)) !== null) {
      const chunk = om[1];
      const wrapperMatch = om[0].match(/class="([^"]*)"/);
      const wrapperClasses = wrapperMatch ? wrapperMatch[1] : '';
      const isMarkedCorrect = /\bcorrect\b/.test(wrapperClasses);
      const isMarkedIncorrect = /\bincorrect\b/.test(wrapperClasses);
      const isSelected = /\bchecked\s*=\s*["']?checked["']?/i.test(chunk);
      const labelMatch = chunk.match(/<label[^>]*>([\s\S]*?)<\/label>/i);
      let letter = String.fromCharCode(97 + optIndex);
      let text = stripHtml(labelMatch ? labelMatch[1] : chunk).trim();
      const letterMatch = text.match(/^([A-Za-z])[.)]\s*(.*)$/);
      if (letterMatch) {
        letter = letterMatch[1].toLowerCase();
        text = letterMatch[2].trim();
      }
      opts.push({
        letter,
        text,
        optionImages: [],
        selected: isSelected,
        markedCorrect: isMarkedCorrect,
        markedIncorrect: isMarkedIncorrect,
        index: optIndex,
      });
      if (isSelected) {
        selectedText = text;
        selectedOpt = opts[opts.length - 1];
      }
      optIndex++;
    }
    subQuestions.push({
      number: ++idx,
      questionText: stemBefore(html, fm.index, 500),
      options: opts,
      selectedText,
      isCorrect: selectedOpt ? selectedOpt.markedCorrect : false,
      isIncorrect: selectedOpt ? selectedOpt.markedIncorrect : false,
      type: 'multianswer',
    });
  }

  // ── Layout C (classic): <div class="answer">…</div></fieldset> ──
  const classicRe = /<div class="answer"[^>]*>([\s\S]*?)<\/div>\s*<\/fieldset>/gi;
  let cm;
  while ((cm = classicRe.exec(html)) !== null) {
    const blockHtml = cm[1];
    const opts = [];
    let selectedText = '';
    let selectedOpt = null;
    const optRe = /<div class="r[01][^"]*"[^>]*>([\s\S]*?)(?=<div class="r[01][^"]*"[^>]*>|$)/gi;
    let om;
    let optIndex = 0;
    while ((om = optRe.exec(blockHtml)) !== null) {
      const chunk = om[1];
      const letterMatch = chunk.match(/<span class="answernumber">([^<]+)<\/span>/);
      const letter = letterMatch ? letterMatch[1].trim().replace(/\.$/, '') : String.fromCharCode(97 + optIndex);
      const isSelected = chunk.includes('checked="checked"');
      const text = stripHtml(chunk.replace(/<input[^>]*>/gi, '')).trim();
      if (!text) continue;
      opts.push({
        letter,
        text,
        optionImages: [],
        selected: isSelected,
        markedCorrect: false,
        markedIncorrect: false,
        index: optIndex,
      });
      if (isSelected) {
        selectedText = text;
        selectedOpt = opts[opts.length - 1];
      }
      optIndex++;
    }
    subQuestions.push({
      number: ++idx,
      questionText: stemBefore(html, cm.index, 500),
      options: opts,
      selectedText,
      isCorrect: false,
      isIncorrect: false,
      type: 'multianswer',
    });
  }

  return { questionText, subQuestions };
}

// ─── Question parser ─────────────────────────────────────────────────
function parseQuestion(q) {
  const html = q.html || '';
  const isMultianswer = (q.type || '') === 'multianswer';
  const isMatch = (q.type || '') === 'match';
  const isDDWTOS = (q.type || '') === 'ddwtos';
  const isGapSelect = (q.type || '') === 'gapselect';

  let questionText = '';
  let options = [];
  let subQuestions = [];
  let selectedValue = -1;

  if (isMultianswer) {
    const parsed = parseMultianswer(html);
    questionText = parsed.questionText;
    subQuestions = parsed.subQuestions;
  } else if (isMatch) {
    // Parse match question
    const qtextMatch = html.match(
      /<div class="qtext"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<fieldset|<div class="(?:ablock|answer))/i,
    );
    questionText = qtextMatch ? stripHtml(qtextMatch[1]).trim() : '';

    // Find the matching table
    const tableMatch = html.match(/<table[^>]*class="answer"[^>]*>([\s\S]*?)<\/table>/i);
    if (tableMatch) {
      const tableHtml = tableMatch[1];
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch;
      let rowIndex = 0;

      while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
        const rowHtml = rowMatch[1];

        // Extract left cell (item to match)
        const textCellMatch = rowHtml.match(/<td[^>]*class="text"[^>]*>([\s\S]*?)<\/td>/i);
        let stem = '';
        if (textCellMatch) {
          stem = stripHtml(textCellMatch[1]).trim();
        }

        // Extract right cell (dropdown with options)
        const controlCellMatch = rowHtml.match(/<td[^>]*class="control"[^>]*>([\s\S]*?)<\/td>/i);
        let opts = [];
        let selectedText = '';
        let selectedIndex = -1;

        if (controlCellMatch) {
          const controlHtml = controlCellMatch[1];
          const selectMatch = controlHtml.match(/<select[^>]*>([\s\S]*?)<\/select>/i);
          if (selectMatch) {
            const selectHtml = selectMatch[1];
            const optionRegex = /<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;
            let optionMatch;
            let optionIndex = 0;

            while ((optionMatch = optionRegex.exec(selectHtml)) !== null) {
              const value = optionMatch[1];
              const text = stripHtml(optionMatch[2]).trim();
              const isSelected = /selected\s*=\s*["']?["']?/i.test(optionMatch[0]);

              // Skip empty-value options and the "Elegir..." placeholder.
              if (value === '' || /^(elegir|choose|seleccionar|seleccione|selecciona|select)/i.test(text)) {
                continue;
              }

              opts.push({
                letter: String.fromCharCode(97 + optionIndex), // a, b, c, ...
                text: text,
                optionImages: [], // Match questions don't typically have images in options
                selected: isSelected,
                markedCorrect: false,
                markedIncorrect: false,
                index: optionIndex,
              });

              if (isSelected) {
                selectedIndex = optionIndex;
                selectedText = text;
              }

              optionIndex++;
            }
          }
        }

        if (stem && opts.length > 0) {
          subQuestions.push({
            number: rowIndex + 1,
            questionText: stem,
            options: opts,
            selectedText: selectedText,
            isCorrect: false, // We don't have per-item correctness from the review HTML
            isIncorrect: false,
            type: 'select',
          });
          rowIndex++;
        }
      }
    }
  } else if (isDDWTOS || isGapSelect) {
    // Parse ddwtos (drag-and-drop words into text) and gapselect (select a
    // word for each gap) questions. Both embed their gaps in the question
    // text; we keep the RAW qtext HTML so we can substitute the student's
    // answer into each gap, then strip the remaining tags.
    const qtextMatch = html.match(
      /<div class="qtext"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<fieldset|<div class="(?:ablock|answer))/i,
    );
    const qtextHtml = qtextMatch ? imgToTokens(qtextMatch[1]) : '';
    questionText = qtextMatch ? stripHtml(qtextHtml).trim() : '';

    // Find draggable items (choices)
    const choicesMatch = html.match(/<div class="user-select-none draggrouphomes1">([\s\S]*?)<\/div>/i);
    let opts = [];
    if (choicesMatch) {
      const choicesHtml = choicesMatch[1];
      const choiceRegex = /<span[^>]*class="draghome[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
      let choiceMatch;
      let choiceIndex = 0;

      while ((choiceMatch = choiceRegex.exec(choicesHtml)) !== null) {
        const text = stripHtml(choiceMatch[1]).trim();
        if (text) {
          opts.push({
            letter: String.fromCharCode(97 + choiceIndex), // a, b, c, ...
            text: text,
            optionImages: [],
            selected: false,
            markedCorrect: false,
            markedIncorrect: false,
            index: choiceIndex,
          });
          choiceIndex++;
        }
      }
    }

    // Find drop targets and their selections from hidden inputs.
    // Moodle's markup varies, so try several patterns.
    let placeInputs =
      html.match(/<input[^>]*id="q[^_]+_p[0-9]+"[^>]*class="placeinput[^"]*"[^>]*name="q[^:]+:p[0-9]+"[^>]*value="([^"]*)"[^\/]*\/>/gi) || [];
    if (placeInputs.length === 0) {
      placeInputs = html.match(/<input[^>]*name="q[^:]+:p[0-9]+"[^>]*value="([^"]*)"[^>]*>/gi) || [];
    }
    if (placeInputs.length === 0) {
      // Final fallback: inputs whose id looks like q123_p1 / q123_p2 ...
      placeInputs = html.match(/<input[^>]*id="[^"]*_p[0-9]+"[^>]*value="([^"]*)"[^>]*>/gi) || [];
    }

    const placeValues = {};
    placeInputs.forEach((input) => {
      const nameMatch = input.match(/:p([0-9]+)/);
      const idMatch = input.match(/_p([0-9]+)/);
      const valueMatch = input.match(/value="([^"]*)"/);
      const placeNum = (nameMatch && nameMatch[1]) || (idMatch && idMatch[1]);
      if (placeNum && valueMatch) {
        placeValues[placeNum] = valueMatch[1]; // which choice was placed here (1-based, or empty)
      }
    });

    const placeNums = Object.keys(placeValues).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    // Build sub-questions for each drop target
    placeNums.forEach((placeNum) => {
      const value = placeValues[placeNum];
      const selectedIndex = value ? parseInt(value, 10) - 1 : -1; // Convert to 0-based index
      const selectedText =
        selectedIndex >= 0 && selectedIndex < opts.length ? opts[selectedIndex].text : '';

      // Try to get a more meaningful question text for this drop target
      const placeSpanMatch = html.match(
        new RegExp(
          `<span[^>]*class="place${placeNum}[^"]*"[^>]*>[\\s\\S]*?<span[^>]*class="accesshide"[^>]*>([\\s\\S]*?)<\\/span>[\\s\\S]*?<\\/span>`,
          'i',
        ),
      );
      let stem = `Espacio ${placeNum}`;
      if (placeSpanMatch) {
        stem = stripHtml(placeSpanMatch[1]).trim();
        if (!stem) stem = `Espacio ${placeNum}`;
      }

      subQuestions.push({
        number: parseInt(placeNum, 10),
        questionText: stem,
        options: opts,
        selectedText: selectedText,
        isCorrect: false, // We don't have per-drop-target correctness from review HTML
        isIncorrect: false,
        type: 'ddwtos',
      });
    });

    // Substitute each gap's answer into the question text, wrapping the
    // student's answer in a boxed span so it stands out from the stem.
    let displayText = qtextHtml;
    if (isDDWTOS) {
      // 1) Replace the placeholder <span class="placeN">…</span> with the answer.
      placeNums.forEach((placeNum) => {
        const value = placeValues[placeNum];
        const selectedIndex = value ? parseInt(value, 10) - 1 : -1;
        const answer = selectedIndex >= 0 && selectedIndex < opts.length ? opts[selectedIndex].text : '';
        const spanRe = new RegExp(
          `<span[^>]*class="[^"]*place${placeNum}[^"]*"[^>]*>[\\s\\S]*?<\\/span>`,
          'gi',
        );
        displayText = displayText.replace(spanRe, answer ? `<span class="ddwtos-answer">${answer}</span>` : '');
      });
      // 2) Fallback: textual "Vacío N Pregunta M" placeholders.
      placeNums.forEach((placeNum) => {
        const value = placeValues[placeNum];
        const selectedIndex = value ? parseInt(value, 10) - 1 : -1;
        const answer = selectedIndex >= 0 && selectedIndex < opts.length ? opts[selectedIndex].text : '';
        if (!answer) return;
        const vacioRe = new RegExp(
          `(?:&#160;|&nbsp;|\\s)+Vacío\\s*${placeNum}\\s*Pregunta\\s*\\d+`,
          'gi',
        );
        displayText = displayText.replace(vacioRe, ` <span class="ddwtos-answer">${answer}</span> `);
      });
    } else if (isGapSelect) {
      // gapselect: each gap is a <select> (usually wrapped in a
      // <span class="control"> with a sr-only "Vacío N Pregunta M" label)
      // embedded directly in the question text. Replace the whole control
      // span with the student's chosen option in a boxed span.
      const selectToAnswer = (selectHtml) => {
        let selected = '';
        const optRe = /<option[^>]*value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/gi;
        let om;
        while ((om = optRe.exec(selectHtml)) !== null) {
          const text = stripHtml(om[3]).trim();
          if (!text || om[1] === '') continue;
          if (/selected\s*=\s*["']?selected/i.test(om[0])) selected = text;
        }
        return selected ? `<span class="ddwtos-answer">${selected}</span>` : ' ';
      };
      displayText = displayText.replace(
        /<span[^>]*class="[^"]*control[^"]*"[^>]*>[\s\S]*?<\/span>/gi,
        (whole) => {
          const selMatch = whole.match(/<select[^>]*>([\s\S]*?)<\/select>/i);
          return selMatch ? selectToAnswer(selMatch[1]) : whole;
        },
      );
      // Fallback: a bare <select> not wrapped in a control span.
      displayText = displayText.replace(/<select[^>]*>([\s\S]*?)<\/select>/gi, (m, inner) => selectToAnswer(inner));
    }
    // Protect the answer boxes from stripHtml, then restore them.
    const BOX_OPEN = '%%DDWTOS_OPEN%%';
    const BOX_CLOSE = '%%DDWTOS_CLOSE%%';
    displayText = displayText.replace(
      /<span class="ddwtos-answer">([\s\S]*?)<\/span>/g,
      (m, inner) => BOX_OPEN + inner + BOX_CLOSE,
    );
    questionText = stripHtml(displayText).trim() || questionText;
    questionText = questionText
      .split(BOX_OPEN).join('<span class="ddwtos-answer">')
      .split(BOX_CLOSE).join('</span>');
  } else {
    // Question text (standard types)
    const qtextMatch = html.match(
      /<div class="qtext"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<fieldset|<div class="(?:ablock|answer))/i,
    );
    questionText = qtextMatch ? stripHtml(imgToTokens(qtextMatch[1])).trim() : '';
    if (!questionText) {
      const alt = html.match(/<div class="qtext"[^>]*>([\s\S]*?)<\/div>/i);
      if (alt) questionText = stripHtml(imgToTokens(alt[1])).trim();
    }

    // Selected answer
    const checkedMatch = html.match(
      /<input[^>]*name="[^"]*_answer"[^>]*checked="checked"[^>]*value="(\d+)"/i,
    );
    selectedValue = checkedMatch ? parseInt(checkedMatch[1], 10) : -1;

    // Answer options
    const answerBlock = html.match(/<div class="answer">([\s\S]*?)<\/div>\s*<\/fieldset>/i);
    if (answerBlock) {
      const ansHtml = answerBlock[1];
      const optRegex = /<div class="r[01][^"]*">([\s\S]*?)(?=<div class="r[01][^"]*">|$)/gi;
      let optMatch;
      let optIndex = 0;
      while ((optMatch = optRegex.exec(ansHtml)) !== null) {
        const chunk = optMatch[1];
        const letterMatch = chunk.match(/<span class="answernumber">([^<]+)<\/span>/);
        const letter = letterMatch ? letterMatch[1].trim() : `${String.fromCharCode(97 + optIndex)}.`;

        // Extract option images and text from flex-fill area
        const optionImages = [];
        let text = '';
        const extractOptContent = (innerHtml) => {
          // Collect any pluginfile images inside this option
          const oiRe = /<img[^>]*src=["']([^"']+)["'][^>]*>/gi;
          let oim;
          while ((oim = oiRe.exec(innerHtml)) !== null) {
            const s = oim[1].replace(/&amp;/g, '&');
            if (s.includes('pluginfile.php') && !optionImages.includes(s)) optionImages.push(s);
          }
          // Strip img tags before converting to plain text
          return stripHtml(innerHtml.replace(/<img[^>]*>/gi, '')).trim();
        };

        const flexMatch = chunk.match(/<div class="flex-fill[^"]*">([\s\S]*?)<\/div>\s*(?:<\/div>|<span)/i);
        if (flexMatch) text = extractOptContent(flexMatch[1]);
        if (!text && optionImages.length === 0) {
          const labelMatch = chunk.match(
            /data-region="answer-label">[\s\S]*?<div class="flex-fill[^"]*">([\s\S]*?)<\/div>/i,
          );
          if (labelMatch) text = extractOptContent(labelMatch[1]);
        }
        if (!text && optionImages.length === 0) {
          const afterLetter = chunk.split(/answernumber/)[1];
          if (afterLetter) text = stripHtml(afterLetter).trim();
        }
        // truefalse / simple options: the answer text lives in a <label>
        if (!text && optionImages.length === 0) {
          const lblMatch = chunk.match(/<label[^>]*>([\s\S]*?)<\/label>/i);
          if (lblMatch) text = stripHtml(lblMatch[1]).trim();
        }
        if (!text && optionImages.length === 0) {
          text = stripHtml(chunk).trim();
        }

        const isSelected = chunk.includes('checked="checked"');
        const wrapperMatch = optMatch[0].match(/class="(r[01][^"]*)"/);
        const wrapperClasses = wrapperMatch ? wrapperMatch[1] : '';
        const isMarkedCorrect = /(?:^|\s)correct(?:\s|$)/.test(wrapperClasses);
        const isMarkedIncorrect = /(?:^|\s)incorrect(?:\s|$)/.test(wrapperClasses);

        options.push({
          letter,
          text,
          optionImages,
          selected: isSelected,
          markedCorrect: isMarkedCorrect,
          markedIncorrect: isMarkedIncorrect,
          index: optIndex,
        });
        optIndex++;
      }
    }
  }

  // Grade — Moodle returns the mark already rounded to 2 decimals (e.g.
  // "1,88") while maxmark is raw (e.g. 1.875). Round both the way Moodle
  // displays them, otherwise a fully-correct question reads as partial.
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const markObtained = round2(parseFloat(String(q.mark || '0').replace(',', '.')));
  const markMax = round2(q.maxmark || 0);
  const isEssay = (q.type || '') === 'essay';
  const isCorrect = markObtained === markMax && markMax > 0;
  // Essays use manual grading — a score of 0 doesn't mean "wrong", it may be ungraded
  const isWrong = !isEssay && markObtained === 0 && markMax > 0;

  // Feedback ("La respuesta correcta es: ...") — images keep their position
  // in the text flow and are collected separately for downloading.
  let feedback = '';
  let feedbackImages = [];
  const feedbackMatch = html.match(/<div class="rightanswer">([\s\S]*?)<\/div>/i);
  if (feedbackMatch) {
    feedback = stripHtml(imgToTokens(feedbackMatch[1])).trim();
    const fbImgRe = /<img[^>]*src="([^"]+)"[^>]*>/gi;
    let fim;
    while ((fim = fbImgRe.exec(feedbackMatch[1])) !== null) {
      const s = fim[1].replace(/&amp;/g, '&');
      if (s.includes('pluginfile.php') && !feedbackImages.includes(s)) feedbackImages.push(s);
    }
  }

  // Essay response — what the student wrote
  let essayResponse = '';
  if (isEssay) {
    const responseMatch = html.match(/<div[^>]*class="[^"]*qtype_essay_response[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (responseMatch) {
      // Preserve paragraph breaks, then strip remaining tags
      const raw = responseMatch[1]
        .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
        .replace(/<p[^>]*>/gi, '')
        .replace(/<\/p>/gi, '');
      essayResponse = stripHtml(raw).trim();
    }
  }

  // Images — only from the question text, not from answer options
  // (answer option images are extracted per-option above)
  const images = [];
  const imgRegex = /<img[^>]*src="([^"]+)"[^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    const src = imgMatch[1].replace(/&amp;/g, '&');
    // Skip answer-option images and duplicates (the same image often appears
    // both in the question text and in the right-answer feedback).
    if (src.includes('pluginfile.php') && !src.includes('/question/answer/') && !images.includes(src)) {
      images.push(src);
    }
  }

  // Audio/video — collect player sources (e.g. listening quizzes)
  const audios = [];
  const mediaBlockRegex = /<(audio|video)[^>]*>[\s\S]*?<\/\1>|<(audio|video)[^>]*\bsrc=["']([^"']+)["'][^>]*\/?>/gi;
  let mediaMatch;
  while ((mediaMatch = mediaBlockRegex.exec(html)) !== null) {
    const block = mediaMatch[0];
    const urls = [];
    const selfSrc = block.match(/\bsrc=["']([^"']+)["']/i);
    if (selfSrc) urls.push(selfSrc[1]);
    let sm;
    const sourceRe = /<source[^>]*src=["']([^"']+)["']/gi;
    while ((sm = sourceRe.exec(block)) !== null) urls.push(sm[1]);
    let hm;
    const hrefRe = /<a[^>]*href=["']([^"']+)["']/gi;
    while ((hm = hrefRe.exec(block)) !== null) {
      if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|mp4|webm|ogv|m4v|mov)(?:$|[?#])/i.test(hm[1])) {
        urls.push(hm[1]);
      }
    }
    for (const raw of urls) {
      const src = raw.replace(/&amp;/g, '&');
      if (!src || src.startsWith('data:')) continue;
      if (!src.includes('pluginfile.php') && !/^https?:\/\//i.test(src)) continue;
      if (!audios.includes(src)) audios.push(src);
    }
  }

  return {
    slot: q.slot,
    questionNumber: q.questionnumber || q.number || q.slot,
    type: q.type || 'unknown',
    questionText,
    subQuestions,
    options,
    selectedValue,
    markObtained,
    markMax,
    isCorrect,
    isWrong,
    images,
    audios,
    feedbackImages,
    essayResponse,
    feedback,
  };
}

// ─── Media helpers ───────────────────────────────────────────────────
function guessExt(url, contentType) {
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (m) return m[1].toLowerCase();
  } catch {
    /* ignore */
  }
  const ct = (contentType || '').toLowerCase();
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg',
    'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg',
    'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'video/mp4': 'mp4',
    'video/webm': 'webm', 'application/pdf': 'pdf',
  };
  for (const [k, v] of Object.entries(map)) {
    if (ct.includes(k)) return v;
  }
  return 'bin';
}

// ─── Main collection ─────────────────────────────────────────────────
async function collect(baseUrl, token, userId, outDir, onMessage) {
  const log = (msg) => onMessage && onMessage(msg);
  const ws = (fn, params) => wsCall(baseUrl, token, fn, params);

  const resourcesDir = path.join(outDir, 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });

  const mediaMap = new Map(); // url -> localFile
  let imgCounter = 0;
  let audioCounter = 0;
  let mediaTotal = 0;

  // Seed counters from media already on disk so re-collecting one account
  // doesn't overwrite files still referenced by another account's data.
  try {
    for (const f of fs.readdirSync(resourcesDir)) {
      const im = f.match(/^img_(\d+)\./);
      if (im) imgCounter = Math.max(imgCounter, parseInt(im[1], 10));
      const am = f.match(/^audio_(\d+)\./);
      if (am) audioCounter = Math.max(audioCounter, parseInt(am[1], 10));
    }
  } catch { /* resources dir may not exist yet */ }

  const downloadMedia = async (url, kind) => {
    if (!url || mediaMap.has(url)) return mediaMap.get(url) || null;
    // The plain /pluginfile.php endpoint does not accept wstoken and returns
    // the Moodle login page (HTML) instead of the file. The web-service
    // endpoint /webservice/pluginfile.php does accept the token.
    let fixedUrl = url;
    if (!/\/webservice\/pluginfile\.php\//.test(url)) {
      fixedUrl = url.replace(/\/pluginfile\.php\//, '/webservice/pluginfile.php/');
    }
    const sep = fixedUrl.includes('?') ? '&' : '?';
    const fullUrl = `${fixedUrl}${sep}token=${encodeURIComponent(token)}`;
    // Retry transient failures (throttling, network hiccups) so a hiccup
    // doesn't leave a question without its image/audio.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(fullUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = res.headers.get('content-type') || '';
        // The login page is HTML — never accept it as media.
        if (ct.includes('text/html')) throw new Error('got HTML login page instead of media');
        const ext = guessExt(url, ct);
        const isAudio = kind === 'audio' || (url.match(/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)(?:$|[?#])/i) && kind !== 'image');
        const name = isAudio ? `audio_${++audioCounter}.${ext}` : `img_${++imgCounter}.${ext}`;
        const buf = await res.buffer();
        fs.writeFileSync(path.join(resourcesDir, name), buf);
        mediaMap.set(url, name);
        mediaTotal++;
        return name;
      } catch (e) {
        if (attempt === 3) {
          log(`  ⚠ No se pudo descargar ${kind} (${e.message}): ${url.slice(0, 90)}…`);
          return null;
        }
        await sleep(700 * attempt);
      }
    }
  };

  log('Obteniendo cursos…');
  let coursesData = [];
  try {
    coursesData = await ws('core_enrol_get_users_courses', { userid: userId });
  } catch (e) {
    log(`⚠ No se pudieron obtener los cursos: ${e.message}`);
    throw e;
  }

  const server = { baseUrl, courses: [] };
  let questionCount = 0;
  let correctCount = 0;

  for (const c of coursesData || []) {
    const course = {
      name: decodeEntities(c.fullname || c.shortname || `Curso ${c.id}`),
      courseId: c.id,
      quizzes: [],
    };
    log(`\nCurso: ${course.name}`);

    let quizzes = [];
    try {
      const qr = await ws('mod_quiz_get_quizzes_by_courses', { courseids: [c.id] });
      quizzes = qr.quizzes || [];
    } catch (e) {
      log(`  ⚠ No se pudieron listar los quizzes: ${e.message}`);
    }

    for (const quiz of quizzes) {
      const quizName = decodeEntities(quiz.name);
      const sumGrades = quiz.sumgrades;

      let attempts = [];
      try {
        const ar = await ws('mod_quiz_get_user_attempts', {
          quizid: quiz.id,
          userid: userId,
          status: 'finished',
        });
        attempts = ar.attempts || [];
      } catch (e) {
        log(`  ⚠ Quiz "${quizName}": ${e.message}`);
        continue;
      }

      if (attempts.length === 0) {
        log(`  ${quizName} → sin intentos terminados`);
        continue;
      }

      // Fetch the review of EVERY finished attempt (not only the best one).
      const attemptsData = [];
      for (const a of attempts) {
        let questions = [];
        try {
          const rev = await ws('mod_quiz_get_attempt_review', { attemptid: a.id, page: -1 });
          for (const q of rev.questions || []) {
            const parsed = parseQuestion(q);
            parsed.images = await Promise.all(
              (parsed.images || []).map(async (src) => ({
                url: src,
                localFile: await downloadMedia(src, 'image'),
              })),
            );
            parsed.feedbackImages = await Promise.all(
              (parsed.feedbackImages || []).map(async (src) => ({
                url: src,
                localFile: await downloadMedia(src, 'image'),
              })),
            );
            parsed.audios = await Promise.all(
              (parsed.audios || []).map(async (src) => ({
                url: src,
                localFile: await downloadMedia(src, 'audio'),
              })),
            );
            // Option images (multichoice answers that contain images) need the
            // same {url, localFile} shape the renderers expect.
            for (const opt of parsed.options || []) {
              opt.optionImages = await Promise.all(
                (opt.optionImages || []).map(async (src) => ({
                  url: src,
                  localFile: await downloadMedia(src, 'image'),
                })),
              );
            }
            for (const sub of parsed.subQuestions || []) {
              for (const opt of sub.options || []) {
                opt.optionImages = await Promise.all(
                  (opt.optionImages || []).map(async (src) => ({
                    url: src,
                    localFile: await downloadMedia(src, 'image'),
                  })),
                );
              }
            }
            questions.push(parsed);
          }
        } catch (e) {
          log(`  ⚠ Revisión intento ${a.attempt || a.id} de "${quizName}": ${e.message}`);
          continue;
        }
        attemptsData.push({
          attemptId: a.id,
          attemptNumber: a.attempt || attemptsData.length + 1,
          score: a.sumgrades,
          questions,
        });
      }

      if (attemptsData.length === 0) continue;
      attemptsData.sort((x, y) => x.attemptNumber - y.attemptNumber);
      const best = attemptsData.reduce((x, y) => (y.score > x.score ? y : x));
      const bestGrade = best.score;
      log(`  ${quizName} → ${attemptsData.length} intento(s), mejor ${bestGrade}/${sumGrades}`);

      // Stats are based on the best attempt, keeping headers consistent.
      for (const q of best.questions) {
        if (q.isCorrect) correctCount++;
        questionCount++;
      }

      course.quizzes.push({
        name: quizName,
        quizId: quiz.id,
        cmid: quiz.coursemodule || null,
        sumGrades,
        bestGrade,
        attempts: attemptsData.length,
        folder: '',
        questions: best.questions,
        attemptsData,
      });
    }

    if (course.quizzes.length > 0) server.courses.push(course);
  }

  const dataFile = path.join(outDir, 'quiz_study_data.json');
  // Merge into the shared data file (one entry per Moodle host) so multiple
  // accounts/hosts can coexist instead of overwriting each other.
  let servers = [];
  if (fs.existsSync(dataFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      if (Array.isArray(existing)) servers = existing;
    } catch { /* corrupt/old file, start fresh */ }
  }
  servers = servers.filter((s) => s.baseUrl !== server.baseUrl);
  servers.push(server);
  fs.writeFileSync(dataFile, JSON.stringify(servers, null, 2), 'utf8');
  log(`\nDatos → ${dataFile} (${servers.length} servidor(es))`);

  const guideFile = path.join(outDir, 'quiz_study_guide.html');
  fs.writeFileSync(guideFile, buildStaticGuide(servers), 'utf8');
  log(`Guía  → ${guideFile}`);

  return { questionCount, correctCount, mediaCount: mediaTotal };
}

// ─── Static guide generation ─────────────────────────────────────────
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Escape everything except our <span class="ddwtos-answer">…</span> boxes and
// <img …> tags, which are intentionally kept as markup so they render.
function escapeHtmlKeepAnswerBoxes(str) {
  const re = /<span class="ddwtos-answer">([\s\S]*?)<\/span>|<img[^>]*>/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(String(str || ''))) !== null) {
    out += escapeHtml(String(str).slice(last, m.index));
    if (m[0].startsWith('<img')) {
      out += m[0];
    } else {
      out += `<span class="ddwtos-answer">${escapeHtml(m[1])}</span>`;
    }
    last = m.index + m[0].length;
  }
  out += escapeHtml(String(str).slice(last));
  return out;
}

function buildStaticGuide(servers) {
  const css = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f0f;color:#e0e0e0;padding:20px;line-height:1.6}
  h1{text-align:center;margin:30px 0;color:#7c4dff;font-size:1.8em}
  .server-hdr{background:#1a1a2e;border-radius:10px;padding:15px 20px;margin:30px 0 15px;border-left:4px solid #7c4dff}
  .server-hdr h2{color:#b388ff;font-size:1.1em}
  .course-blk{background:#1a1a1a;border-radius:10px;margin:15px 0;overflow:hidden;border:1px solid #2a2a2a}
  .course-title{background:#1e1e2e;padding:12px 20px;font-weight:600;color:#82b1ff;font-size:1.05em;cursor:pointer;user-select:none;display:flex;justify-content:space-between;align-items:center}
  .course-title:hover{background:#252538}
  .quiz-blk{border-top:1px solid #2a2a2a}
  .quiz-hdr{padding:12px 20px;background:#161625;cursor:pointer;display:flex;justify-content:space-between;align-items:center}
  .quiz-hdr:hover{background:#1e1e30}
  .quiz-hdr .name{font-weight:500;color:#c5cae9}
  .quiz-hdr .name .quiz-link{display:inline-block;margin-left:8px;color:#7c4dff;text-decoration:none;vertical-align:middle;line-height:0;padding:3px;border-radius:4px}
  .quiz-hdr .name .quiz-link:hover{background:#2a2a40;color:#b388ff}
  .quiz-hdr .score{font-weight:600;font-size:.95em}
  .quiz-hdr .info{color:#888;font-size:.8em}
  .quiz-body{display:none;padding:0}
  .quiz-body.open{display:block}
  .attempt-hdr{padding:8px 20px;background:#131324;color:#82b1ff;font-weight:600;font-size:.85em;border-top:1px solid #2a2a2a;border-bottom:1px solid #1c1c30}
  .course-quizzes{display:none}
  .course-quizzes.open{display:block}
  .q{padding:15px 20px;border-top:1px solid #222}
  .q:hover{background:#1a1a28}
  .q-num{font-weight:700;margin-bottom:5px;font-size:.9em}
  .q-num.correct{color:#69f0ae}
  .q-num.wrong{color:#ff5252}
  .q-num.partial{color:#ffd740}
  .q-type{color:#666;font-size:.75em;margin-bottom:3px}
  .q-text{color:#e0e0e0;margin-bottom:8px;font-size:.95em;white-space:pre-wrap;overflow-wrap:break-word}
  .q-img{max-width:100%;border-radius:8px;margin:8px 0;border:1px solid #333}
  .q-audio{width:100%;max-width:440px;margin:8px 0;display:block}
  .opt-img{max-width:260px;border-radius:6px;margin:4px 0;display:block}
  .opt{padding:4px 0 4px 15px;font-size:.9em}
  .opt.correct{color:#69f0ae;font-weight:600}
  .opt.correct::before{content:"✓ ";font-weight:bold}
  .opt.selected-wrong{color:#ff5252;text-decoration:line-through;opacity:.8}
  .opt.selected-wrong::before{content:"✗ ";font-weight:bold}
  .opt.not-selected{color:#888}
  .opt.not-selected::before{content:"• "}
  .opt.selected{color:#c5cae9}
  .opt.selected::before{content:"● "}
  .sub-q{margin:10px 0 4px;padding:8px 12px;background:#1c1c2e;border-radius:6px;border-left:3px solid #444}
  .sub-q-text{font-size:.9em;color:#ccc;margin-bottom:6px;font-weight:500}
  .sub-opt{padding:3px 0 3px 14px;font-size:.88em}
  .sub-opt.correct{color:#69f0ae;font-weight:600}
  .sub-opt.correct::before{content:"✓ "}
  .sub-opt.selected-wrong{color:#ff5252;text-decoration:line-through;opacity:.8}
  .sub-opt.selected-wrong::before{content:"✗ "}
  .sub-opt.not-selected{color:#666}
  .sub-opt.not-selected::before{content:"• "}
  .sub-opt.selected{color:#c5cae9}
  .sub-opt.selected::before{content:"● "}
  .sub-answer{font-size:.88em;margin-top:4px;padding:3px 10px;border-radius:4px;display:inline-block}
  .sub-answer.correct{background:#1b3a2a;color:#69f0ae;border:1px solid #2e7d4f}
  .sub-answer.wrong{background:#3a1b1b;color:#ff5252;border:1px solid #b71c1c}
  .sub-answer.partial{background:#3a3018;color:#ffd54f;border:1px solid #8a6d1f}
  .ddwtos-answer{display:inline-block;margin:0 3px;padding:1px 6px;border-radius:4px;background:#2a2a2a;color:#cfd8dc;font-weight:600;border:1px solid #555;white-space:nowrap}
  .q-text.ddwtos-ok .ddwtos-answer{background:#1b3a2a;color:#69f0ae;border:1px solid #2e7d4f}
  .feedback{color:#b388ff;font-size:.85em;margin-top:6px;padding:6px 10px;background:#1a1a2e;border-left:3px solid #7c4dff;border-radius:4px;font-style:italic;white-space:pre-wrap}
  .essay-label{color:#888;font-size:.78em;text-transform:uppercase;letter-spacing:.05em;margin-top:10px;margin-bottom:4px}
  .essay-response{color:#cfd8dc;font-size:.92em;line-height:1.7;white-space:pre-wrap;background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:10px 14px;margin-top:4px}
  .stats{color:#888;font-size:.85em}
  .legend{display:flex;gap:20px;justify-content:center;padding:10px;font-size:.85em;margin-bottom:20px}
  .legend span{display:flex;align-items:center;gap:5px}
  .legend .dot{width:12px;height:12px;border-radius:50%;display:inline-block}
  .legend .dot.g{background:#69f0ae}
  .legend .dot.r{background:#ff5252}
  .legend .dot.y{background:#ffd740}
  .expand-btn{display:inline-block;padding:6px 14px;background:#7c4dff;color:white;border:none;border-radius:6px;cursor:pointer;font-size:.85em;margin:10px 20px}
  .expand-btn:hover{background:#651fff}
  .hidden{display:none!important}
  #float-box{position:fixed;right:16px;bottom:16px;width:280px;max-width:calc(100vw - 32px);background:#161625;border:1px solid #2a2a3a;border-radius:12px;padding:12px 14px;box-shadow:0 10px 30px rgba(0,0,0,.55);z-index:1000}
  #float-box .float-label{font-size:.68em;text-transform:uppercase;letter-spacing:.08em;color:#7c4dff;font-weight:700;margin-bottom:4px}
  #float-quiz-name{font-size:.85em;color:#e0e0e0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:8px}
  #float-attempt-link{display:inline-block;background:#7c4dff;color:#fff;text-decoration:none;font-size:.8em;font-weight:600;padding:7px 12px;border-radius:8px;text-align:center}
  #float-attempt-link:hover{background:#651fff}
  #float-attempt-link.disabled{background:#2a2a3a;color:#666;cursor:default}
  `;

  const html = [];
  html.push('<!DOCTYPE html>');
  html.push('<html lang="es"><head><meta charset="UTF-8">');
  html.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
  html.push('<title>Moodle Quiz Study Guide</title>');
  html.push(`<style>${css}</style>`);
  html.push(`<script>
    var __lastFloat=null;
    function toggleAll(btn){
      const open=document.querySelectorAll('.course-quizzes.open,.quiz-body.open');
      const closed=document.querySelectorAll('.course-quizzes:not(.open),.quiz-body:not(.open)');
      if(closed.length>0){ closed.forEach(e=>e.classList.add('open')); btn.textContent='Collapse All'; }
      else { open.forEach(e=>e.classList.remove('open')); btn.textContent='Expand All'; }
      updateFloat();
    }
    function updateFloat(){
      const mid=window.innerHeight/2;
      let hit=null;
      const bodies=document.querySelectorAll('.quiz-body');
      for(let i=0;i<bodies.length;i++){
        const el=bodies[i];
        const r=el.getBoundingClientRect();
        if(r.top<=mid && r.bottom>=mid){
          const entry=window.__QUIZ_REGISTRY__[+el.dataset.reg];
          if(!entry || !entry.attempts.length) continue;
          let attempt=entry.attempts[0];
          if(entry.attempts.length>1){
            const hdrs=el.querySelectorAll('.attempt-hdr');
            for(let j=0;j<hdrs.length;j++){ if(hdrs[j].getBoundingClientRect().top<=mid) attempt=entry.attempts[j]; }
          }
          hit={entry:entry,attempt:attempt};
          break;
        }
      }
      if(hit) __lastFloat=hit;
      const cur=hit||__lastFloat;
      const box=document.getElementById('float-box');
      const name=document.getElementById('float-quiz-name');
      const link=document.getElementById('float-attempt-link');
      if(!cur){ box.classList.add('hidden'); return; }
      box.classList.remove('hidden');
      name.textContent=cur.entry.attempts.length>1?cur.entry.name+' — Intento '+cur.attempt.n:cur.entry.name;
      if(cur.entry.cmid && cur.attempt.id!=null){
        link.href=cur.entry.base+'/mod/quiz/review.php?attempt='+cur.attempt.id+'&cmid='+cur.entry.cmid;
        link.textContent='Abrir intento '+cur.attempt.n;
        link.classList.remove('disabled');
      }else{
        link.removeAttribute('href');
        link.classList.add('disabled');
        link.textContent='Sin enlace de revisión';
      }
    }
    window.addEventListener('scroll',function(){requestAnimationFrame(updateFloat);},{passive:true});
    window.addEventListener('resize',updateFloat);
    window.addEventListener('load',updateFloat);
  </script></head><body>`);
  html.push('<div id="float-box" class="hidden"><div class="float-label">Viendo</div><div id="float-quiz-name"></div><a id="float-attempt-link" target="_blank" rel="noopener">Abrir intento</a></div>');
  html.push('<h1>📚 Moodle Quiz Study Guide</h1>');
  html.push('<div class="legend">');
  html.push('<span><span class="dot g"></span> Correcta</span>');
  html.push('<span><span class="dot r"></span> Incorrecta (tu respuesta)</span>');
  html.push('<span><span class="dot y"></span> Parcial / Info</span>');
  html.push('</div>');
  html.push('<button class="expand-btn" onclick="toggleAll(this)">Expand All</button>');

  const reg = []; // quiz metadata for the floating widget
  for (const server of servers) {
    html.push(`<div class="server-hdr"><h2>${escapeHtml(server.baseUrl.replace('https://', ''))}</h2></div>`);
    for (const course of server.courses) {
      const totalQ = course.quizzes.reduce((s, q) => s + q.questions.length, 0);
      const correctQ = course.quizzes.reduce((s, q) => s + q.questions.filter((x) => x.isCorrect).length, 0);
      html.push('<div class="course-blk">');
      html.push('<div class="course-title" onclick="this.nextElementSibling.classList.toggle(\'open\')">');
      html.push(`<span>${escapeHtml(course.name)}</span>`);
      html.push(`<span class="stats">${course.quizzes.length} quizzes · ${correctQ}/${totalQ} correctas</span>`);
      html.push('</div>');
      html.push('<div class="course-quizzes">');

      for (const quiz of course.quizzes) {
        const quizCorrect = quiz.questions.filter((q) => q.isCorrect).length;
        const quizTotal = quiz.questions.length;
        html.push('<div class="quiz-blk">');
        html.push('<div class="quiz-hdr" onclick="this.nextElementSibling.classList.toggle(\'open\')">');
        html.push('<div>');
        const quizLink = quiz.cmid
          ? ` <a class="quiz-link" href="${escapeHtml(server.baseUrl)}/mod/quiz/view.php?id=${quiz.cmid}" target="_blank" rel="noopener" title="Abrir en Moodle" onclick="event.stopPropagation()">${escapeHtml('↗')}</a>`
          : '';
        html.push(`<span class="name">${escapeHtml(quiz.name)}${quizLink}</span>`);
        html.push(`<div class="info">${quiz.attempts} intento(s) · ${quizCorrect}/${quizTotal} correctas</div>`);
        html.push('</div>');
        const color = quiz.bestGrade >= quiz.sumGrades ? '#69f0ae' : quiz.bestGrade > 0 ? '#ffd740' : '#ff5252';
        html.push(`<span class="score" style="color:${color}">${quiz.bestGrade != null ? quiz.bestGrade + '/' + quiz.sumGrades : '?'}</span>`);
        html.push('</div>');

        // All finished attempts, or a single synthetic attempt for old data.
        const attemptsData = quiz.attemptsData ||
          (quiz.questions && quiz.questions.length
            ? [{ attemptNumber: 1, score: quiz.bestGrade, questions: quiz.questions }]
            : []);
        reg.push({
          name: quiz.name,
          cmid: quiz.cmid || null,
          base: server.baseUrl,
          attempts: attemptsData.map((a) => ({ n: a.attemptNumber, id: a.attemptId != null ? a.attemptId : null })),
        });
        html.push(`<div class="quiz-body" data-reg="${reg.length - 1}">`);

        if (!attemptsData.length) {
          html.push('<div class="no-review">No se pudo obtener la revisión</div>');
        } else {
          for (const attempt of attemptsData) {
            if (attemptsData.length > 1) {
              const attScore = attempt.score != null ? attempt.score + '/' + quiz.sumGrades : '?';
              html.push(`<div class="attempt-hdr">Intento ${attempt.attemptNumber} — ${attScore}</div>`);
            }
            for (const q of attempt.questions) {
              const numCls = q.isCorrect ? 'correct' : q.isWrong ? 'wrong' : 'partial';
              const numText = q.isCorrect
                ? `P${q.questionNumber} — ✓ Correcta`
                : q.isWrong
                  ? `P${q.questionNumber} — ✗ Incorrecta`
                  : `P${q.questionNumber} — ${q.markObtained}/${q.markMax}`;
              html.push('<div class="q">');
              html.push(`<div class="q-num ${numCls}">${escapeHtml(numText)}</div>`);
              html.push(`<div class="q-type">${escapeHtml(q.type)}</div>`);
              // ddwtos answers are only tinted green when the whole question
              // earned max grade — otherwise we can't tell which gaps were right.
              const ddwtosCls = (q.type === 'ddwtos' || q.type === 'gapselect') && q.isCorrect ? ' ddwtos-ok' : '';
              // Images embedded in the question text keep their position in the
              // flow (text → break → image → break → text, just like Moodle).
              const imgMap = new Map((q.images || []).map((i) => [i.url, i.localFile]));
              const renderedInText = new Set();
              const qtextHtml = (q.questionText || '').replace(imgTokenRe(), (m, url) => {
                renderedInText.add(url);
                const src = imgMap.get(url) ? `resources/${imgMap.get(url)}` : url;
                return `<img class="q-img" alt="question image" loading="lazy" src="${escapeHtml(src)}">`;
              });
              html.push(`<div class="q-text${ddwtosCls}">${escapeHtmlKeepAnswerBoxes(qtextHtml)}</div>`);

          // Fallback: images not embedded in the text (e.g. multianswer) and not
          // part of the feedback are appended after the question.
          const feedbackImgUrls = new Set((q.feedbackImages || []).map((i) => i.url));
          for (const img of q.images || []) {
            if (renderedInText.has(img.url) || feedbackImgUrls.has(img.url)) continue;
            const src = img.localFile ? `resources/${img.localFile}` : img.url;
            html.push(`<img class="q-img" alt="question image" loading="lazy" src="${escapeHtml(src)}">`);
          }
          for (const a of q.audios || []) {
            const src = a.localFile ? `resources/${a.localFile}` : a.url;
            html.push(`<audio class="q-audio" controls preload="none" src="${escapeHtml(src)}"></audio>`);
          }

          // ddwtos answers are already substituted into the question text,
          // so the raw draggable-choices list is skipped for that type.
          if (q.type !== 'ddwtos') {
          for (const sub of q.subQuestions || []) {
            html.push('<div class="sub-q">');
            if (sub.questionText) html.push(`<div class="sub-q-text">${escapeHtml(sub.questionText)}</div>`);
            if (sub.type === 'select') {
              // Match question row → show only the student's choice, boxed so
              // it reads as the selected answer, separate from the prompt.
              const qCls = q.isCorrect ? 'correct' : q.isWrong ? 'wrong' : 'partial';
              const cls = sub.isCorrect ? 'correct' : sub.isIncorrect ? 'wrong' : qCls;
              html.push(`<span class="sub-answer ${cls}">${escapeHtml(sub.selectedText || '— (sin selección)')}</span>`);
            } else if (sub.options && sub.options.length > 0) {
              for (const opt of sub.options) {
                let cls = 'not-selected';
                if (opt.markedCorrect) cls = 'correct';
                else if (opt.markedIncorrect && opt.selected) cls = 'selected-wrong';
                else if (sub.isCorrect && opt.selected) cls = 'correct';
                else if (sub.isIncorrect && opt.selected) cls = 'selected-wrong';
                else if (!sub.isCorrect && !sub.isIncorrect && opt.selected) cls = 'selected';
                html.push(`<div class="sub-opt ${cls}"><strong>${escapeHtml(opt.letter)}</strong> ${escapeHtml(opt.text)}</div>`);
              }
            } else if (sub.selectedText) {
              const cls = sub.isCorrect ? 'correct' : sub.isIncorrect ? 'wrong' : '';
              html.push(`<span class="sub-answer ${cls}">${escapeHtml(sub.selectedText)}</span>`);
            }
            html.push('</div>');
          }
          }

          for (const opt of q.options) {
            let cls = 'not-selected';
            if (opt.markedCorrect) cls = 'correct';
            else if (opt.markedIncorrect && opt.selected) cls = 'selected-wrong';
            else if (q.isCorrect && opt.selected) cls = 'correct';
            else if (q.isWrong && opt.selected) cls = 'selected-wrong';
            else if (!q.isCorrect && !q.isWrong && opt.selected) cls = 'selected';
            let optHtml = `<div class="opt ${cls}"><strong>${escapeHtml(opt.letter)}</strong>`;
            if (opt.text) optHtml += ' ' + escapeHtml(opt.text);
            for (const img of opt.optionImages || []) {
              const src = img.localFile ? `resources/${img.localFile}` : img.url;
              optHtml += `<br><img class="opt-img" alt="option image" src="${escapeHtml(src)}">`;
            }
            optHtml += '</div>';
            html.push(optHtml);
          }

          if (q.essayResponse) {
            html.push('<div class="essay-label">Tu respuesta:</div>');
            html.push(`<div class="essay-response">${escapeHtml(q.essayResponse)}</div>`);
          }
          if (q.feedback) {
            const fbImgMap = new Map((q.feedbackImages || []).map((i) => [i.url, i.localFile]));
            const fbHtml = q.feedback.replace(imgTokenRe(), (m, url) => {
              const src = fbImgMap.get(url) ? `resources/${fbImgMap.get(url)}` : url;
              return `<img class="q-img" alt="feedback image" loading="lazy" src="${escapeHtml(src)}">`;
            });
            html.push(`<div class="feedback">${escapeHtmlKeepAnswerBoxes(fbHtml)}</div>`);
          }
              html.push('</div>');
            }
          }
        }

        html.push('</div></div>');
      }

      html.push('</div></div>');
    }
  }

  html.push(`<script>window.__QUIZ_REGISTRY__=${JSON.stringify(reg).replace(/</g, '\\u003c')};</script>`);
  html.push('</body></html>');
  return html.join('\n');
}

module.exports = { collect, wsCall, buildStaticGuide, parseQuestion };
