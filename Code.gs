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
