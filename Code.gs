/**
 * SINCRONIZZAZIONE + RICERCA SBN per "La Mia Biblioteca"
 */
var PIN = '6912';
var FILE_NAME = 'biblioteca_sync.json';
var SBN_SEARCH_URL = 'https://opac.sbn.it/o/opac-api/titles-search-full-post';

function doGet(e) {
  try {
    if (!checkPin_(e.parameter.pin)) return jsonOut_({ ok: false, error: 'PIN errato' });
    var action = String(e.parameter.action || '');

    if (action === 'sbnIsbn') {
      return jsonOut_({ ok: true, result: cercaSbnIsbn_(e.parameter.isbn) });
    }
    if (action !== 'load') return jsonOut_({ ok: false, error: 'Azione non valida' });

    var file = findFile_();
    if (!file) return jsonOut_({ ok: true, ts: 0, data: null });
    var content = JSON.parse(file.getBlob().getDataAsString());
    return jsonOut_({ ok: true, ts: content.ts || 0, data: content.data || null });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!checkPin_(body.pin)) return jsonOut_({ ok: false, error: 'PIN errato' });
    if (body.action === 'aiPlot') {
      return jsonOut_({ ok: true, result: creaTramaGoogle_(body) });
    }
    if (!body.data) return jsonOut_({ ok: false, error: 'Dati mancanti' });
    var ts = body.ts || Date.now();
    var payload = JSON.stringify({ ts: ts, data: body.data });
    var file = findFile_();
    if (file) file.setContent(payload);
    else DriveApp.createFile(FILE_NAME, payload, 'application/json');
    return jsonOut_({ ok: true, ts: ts });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function cercaSbnIsbn_(value) {
  var isbn = String(value || '').replace(/[^0-9Xx]/g, '');
  if (!isbn) throw new Error('ISBN mancante');
  var response = UrlFetchApp.fetch(SBN_SEARCH_URL, {
    method: 'post',
    payload: {
      core: 'sbn',
      'fieldaccess[0]': 'ISBN:7',
      'fieldvalue[0]': isbn,
      'fieldstruct[0]': 'ricerca.frase:4=1'
    },
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'User-Agent': 'LaMiaBiblioteca/10' }
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Catalogo SBN non disponibile (' + response.getResponseCode() + ')');
  }
  var parsed = JSON.parse(response.getContentText());
  var rows = parsed && parsed.data && parsed.data.results;
  if (!rows || !rows.length) return null;
  var row = rows[0];
  var fullTitle = String((row.title && row.title.info) || '').trim();
  var title = (fullTitle.split(/\s+\/\s+/)[0] || fullTitle).trim();
  var rawAuthor = String((row.title && row.title.text) || '').trim();
  var author = normalizzaAutore_(rawAuthor);
  var publication = String((row.infos && row.infos[0]) || '');
  var matchYear = publication.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return {
    title: title,
    authors: author ? [author] : [],
    date: matchYear ? matchYear[0] : '',
    cover: null,
    source: 'SBN'
  };
}

function normalizzaAutore_(name) {
  var parts = String(name || '').split(',').map(function(x) { return x.trim(); }).filter(String);
  return parts.length === 2 ? parts[1] + ' ' + parts[0] : parts.join(' ');
}

function creaTramaGoogle_(body) {
  var key = String(body.key || '').trim();
  var title = String(body.title || '').trim();
  var author = String(body.author || '').trim();
  if (!key) throw new Error('Chiave Gemini mancante');
  if (!title) throw new Error('Titolo mancante');
  if (!author) throw new Error('Autore mancante');
  var prompt = 'Cerca con Google informazioni sul LIBRO indicato e scrivi esclusivamente la sua trama in italiano.\n' +
    'Titolo: ' + title + '\nAutore: ' + author + '\n\n' +
    'Verifica che titolo e autore si riferiscano alla stessa opera. Non usare né cercare codici ISBN o dati della specifica edizione. Ignora completamente film, serie TV, adattamenti, recensioni, quarte di copertina promozionali e significati del titolo come parola comune. ' +
    'Scrivi una trama narrativa neutra e completa, indicativamente tra 1200 e 2500 caratteri e comunque non oltre 3000: ambientazione, protagonisti e sviluppo della vicenda. Non esprimere giudizi, non analizzare temi o stile, non usare frasi pubblicitarie e non rivelare il finale o colpi di scena decisivi. ' +
    'Se Google non consente di identificare con certezza quel preciso libro, rispondi soltanto TRAMA_NON_TROVATA. Non aggiungere titolo, fonti o introduzioni.';
  var apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(key);
  var payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };
  var response = UrlFetchApp.fetch(apiUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    var detail = response.getContentText().substring(0, 500);
    throw new Error('Gemini non disponibile (' + response.getResponseCode() + '): ' + detail);
  }
  var data = JSON.parse(response.getContentText());
  var candidate = data && data.candidates && data.candidates[0];
  var parts = candidate && candidate.content && candidate.content.parts || [];
  var text = parts.map(function(part) { return String(part.text || ''); }).join(' ').replace(/\s+/g, ' ').trim();
  if (candidate && candidate.finishReason === 'MAX_TOKENS') {
    throw new Error('Risposta Gemini interrotta: limite token raggiunto');
  }
  if (!text || text.indexOf('TRAMA_NON_TROVATA') >= 0) return null;
  return { text: text, source: 'Gemini con Ricerca Google' };
}

function checkPin_(pin) {
  return String(pin || '') === PIN;
}

function findFile_() {
  var files = DriveApp.getFilesByName(FILE_NAME);
  return files.hasNext() ? files.next() : null;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function autorizzaBiblioteca() {
  UrlFetchApp.fetch('https://opac.sbn.it', { muteHttpExceptions: true });
  DriveApp.getFilesByName(FILE_NAME).hasNext();
}
