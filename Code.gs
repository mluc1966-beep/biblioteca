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
    if (action === 'bookPlot') {
      return jsonOut_({ ok: true, result: cercaTrama_(e.parameter.isbn, e.parameter.title, e.parameter.author) });
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

function cercaTrama_(isbnValue, titleValue, authorValue) {
  var isbn = String(isbnValue || '').replace(/[^0-9Xx]/g, '');
  var title = String(titleValue || '').trim();
  var author = String(authorValue || '').trim();
  if (!isbn && !title) throw new Error('ISBN o titolo mancante');
  var candidates = [];
  var queries = [];
  if (isbn) queries.push('isbn:' + isbn);
  if (title) {
    queries.push('intitle:' + title + (author ? ' inauthor:' + author : ''));
    queries.push(title + (author ? ' ' + author : ''));
  }
  queries.forEach(function(query) {
    try {
      var url = 'https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(query) + '&maxResults=20&printType=books';
      var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (response.getResponseCode() !== 200) return;
      var data = JSON.parse(response.getContentText());
      (data.items || []).forEach(function(item) {
        var text = pulisciTrama_(item && item.volumeInfo && item.volumeInfo.description);
        if (text) candidates.push({ text: text, source: 'Google Books' });
      });
    } catch (err) {}
  });
  var olUrls = [];
  if (isbn) olUrls.push('https://openlibrary.org/search.json?isbn=' + encodeURIComponent(isbn) + '&limit=10&fields=key,title');
  if (title) olUrls.push('https://openlibrary.org/search.json?title=' + encodeURIComponent(title) + '&author=' + encodeURIComponent(author) + '&limit=10&fields=key,title');
  olUrls.forEach(function(olUrl) {
    try {
      var olResponse = UrlFetchApp.fetch(olUrl, { muteHttpExceptions: true });
      if (olResponse.getResponseCode() !== 200) return;
      var olData = JSON.parse(olResponse.getContentText());
      (olData.docs || []).slice(0, 6).forEach(function(doc) {
        if (!doc.key) return;
        try {
          var workResponse = UrlFetchApp.fetch('https://openlibrary.org' + doc.key + '.json', { muteHttpExceptions: true });
          if (workResponse.getResponseCode() !== 200) return;
          var work = JSON.parse(workResponse.getContentText());
          var text = pulisciTrama_(work.description);
          if (text) candidates.push({ text: text, source: 'Open Library' });
        } catch (err) {}
      });
    } catch (err) {}
  });
  if (title) {
    try {
      var wikiQuery = title + (author ? ' ' + author : '') + ' libro';
      var wikiUrl = 'https://it.wikipedia.org/w/api.php?action=query&generator=search&gsrnamespace=0&gsrlimit=6&gsrsearch=' + encodeURIComponent(wikiQuery) + '&prop=extracts&exintro=1&explaintext=1&exsentences=10&format=json&formatversion=2';
      var wikiResponse = UrlFetchApp.fetch(wikiUrl, {
        muteHttpExceptions: true,
        headers: { 'User-Agent': 'LaMiaBiblioteca/13.2 (uso personale)' }
      });
      if (wikiResponse.getResponseCode() === 200) {
        var wikiData = JSON.parse(wikiResponse.getContentText());
        var pages = wikiData && wikiData.query && wikiData.query.pages || [];
        var wantedTitle = title.toLowerCase().split(':')[0].trim();
        pages.sort(function(a, b) {
          function score(page) {
            var pageTitle = String(page.title || '').toLowerCase();
            var extract = String(page.extract || '').toLowerCase();
            var value = 0;
            if (pageTitle === wantedTitle) value += 100;
            else if (pageTitle.indexOf(wantedTitle) >= 0 || wantedTitle.indexOf(pageTitle) >= 0) value += 50;
            if (/\bromanzo\b|\blibro\b|\bopera\b/.test(extract)) value += 20;
            if (author && pageTitle === author.toLowerCase()) value -= 80;
            return value;
          }
          return score(b) - score(a);
        });
        pages.slice(0, 1).forEach(function(page) {
          var text = pulisciTrama_(page.extract);
          if (text && text.length >= 180) candidates.push({ text: limitaTrama_(text, 1800), source: 'Wikipedia italiana' });
        });
      }
    } catch (err) {}
  }
  candidates.sort(function(a, b) { return b.text.length - a.text.length; });
  return candidates.length ? candidates[0] : null;
}

function limitaTrama_(text, maxLength) {
  text = String(text || '').trim();
  if (text.length <= maxLength) return text;
  var cut = text.substring(0, maxLength);
  var end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > 500 ? cut.substring(0, end + 1) : cut + '…').trim();
}

function pulisciTrama_(value) {
  var raw = value && typeof value === 'object' ? value.value : value;
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
