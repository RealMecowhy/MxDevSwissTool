// Web Worker for Log & Text Anonymizer
// Processes text in byte-aligned chunks entirely off the main thread
// Uses setTimeout between chunks to guarantee progress message delivery
// ============================================================

function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

self.onmessage = function(e) {
  var rawText = e.data.rawText;
  var opts = e.data.opts;
  var totalLength = rawText.length;

  if (totalLength === 0) {
    self.postMessage({ type: 'complete', result: '', stats: {}, totalLines: 0 });
    return;
  }

  var chunkByteSize = 256 * 1024; // 256 KB chunks
  var start = 0;
  var totalLines = 0;
  var processedRawChunks = [];
  var processedAnonChunks = [];
  var stats = { uuid: 0, ip: 0, email: 0, mendixId: 0, datetime: 0, number: 0, mac: 0, creditcard: 0, auth: 0, keywords: 0 };
  var totalSizeStr = formatSize(totalLength);
  
  var maskMap = {};
  var maskCounters = {};

  // Precompile regexes
  var uuidRegex = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
  var ipv4Regex = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
  var ipv6Regex = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g;
  var emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  var mendixIdRegex = /\b\d{15,19}\b/g;
  var dateRegex1 = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/gi;
  var dateRegex2 = /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
  var numRegex = /\b\d+\b/g;
  var macRegex = /\b(?:[0-9A-Fa-f]{2}[:-]){5}(?:[0-9A-Fa-f]{2})\b/g;
  var creditCardRegex = /\b(?:4[0-9]{12}(?:[0-9]{3})?|(?:5[1-5][0-9]{2}|222[1-9]|22[3-9][0-9]|2[3-6][0-9]{2}|27[01][0-9]|2720)[0-9]{12}|3[47][0-9]{13})\b/g;
  var jwtRegex = /\beyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\b/g;
  var bearerRegex = /\b(?:Bearer|Basic)\s+[a-zA-Z0-9\-\._~+\/]+=*/gi;
  var awsKeyRegex = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g;
  var genericApiKeyRegex = /\b(?:api[_-]?key|x-api-key)\s*[:=]\s*["']?[A-Za-z0-9\-_]{16,}["']?/gi;
  var passwordInUrlRegex = /([?&](?:password|passwd|pwd|secret|token)=)[^&\s"']+/gi;
  var setCookieRegex = /\b(?:Set-Cookie|Cookie):\s*[^\r\n]+/gi;

  var keywordsList = (opts.keywords && opts.keywords.trim()) ?
    opts.keywords.split(',').map(function(k) { return k.trim(); }).filter(function(k) { return k.length > 0; }).sort(function(a, b) { return b.length - a.length; }) :
    [];

  self.postMessage({
    type: 'progress',
    progress: 0,
    phase: 'Anonymizing... 0 B / ' + totalSizeStr + ' (0%)'
  });

  // Process chunks using setTimeout to yield between each chunk.
  // This guarantees progress messages are dispatched to the main thread.
  function processNextChunk() {
    var end = Math.min(start + chunkByteSize, totalLength);

    // Align to next newline to avoid splitting a line mid-way
    if (end < totalLength) {
      var nl = rawText.indexOf('\n', end);
      end = nl !== -1 ? nl + 1 : totalLength;
    }

    var chunk = rawText.substring(start, end);

    // Count lines in this chunk
    for (var i = 0; i < chunk.length; i++) {
      if (chunk.charCodeAt(i) === 10) totalLines++;
    }

    // Collect matches
    var matches = [];

    function addMatches(regex, anonLabel, statKey) {
      var match;
      while ((match = regex.exec(chunk)) !== null) {
        matches.push({
          start: match.index,
          end: match.index + match[0].length,
          rawText: match[0],
          anonText: '[' + anonLabel + ']',
          statKey: statKey
        });
      }
    }

    if (opts.uuid) addMatches(uuidRegex, 'UUID', 'uuid');
    if (opts.ip) {
      addMatches(ipv4Regex, 'IP', 'ip');
      addMatches(ipv6Regex, 'IP', 'ip');
    }
    if (opts.email) addMatches(emailRegex, 'EMAIL', 'email');
    if (opts.mendixId) addMatches(mendixIdRegex, 'MENDIX_ID', 'mendixId');
    if (opts.datetime) {
      addMatches(dateRegex1, 'DATETIME', 'datetime');
      addMatches(dateRegex2, 'TIME', 'datetime');
    }
    if (opts.number) addMatches(numRegex, 'NUM', 'number');
    if (opts.mac) addMatches(macRegex, 'MAC', 'mac');
    if (opts.creditcard) addMatches(creditCardRegex, 'CREDIT_CARD', 'creditcard');
    if (opts.auth) {
      addMatches(jwtRegex, 'JWT_TOKEN', 'auth');
      addMatches(bearerRegex, 'AUTH_TOKEN', 'auth');
      addMatches(awsKeyRegex, 'AWS_KEY', 'auth');
      addMatches(genericApiKeyRegex, 'API_KEY', 'auth');
      addMatches(passwordInUrlRegex, 'PASSWORD_URL', 'auth');
      addMatches(setCookieRegex, 'COOKIE', 'auth');
    }

    if (keywordsList.length > 0) {
      for (var ki = 0; ki < keywordsList.length; ki++) {
        var kwEscaped = escRegex(keywordsList[ki]);
        var kwRegex = new RegExp('\\b' + kwEscaped + '\\b', 'gi');
        addMatches(kwRegex, 'REDACTED', 'keywords');
      }
    }

    // Sort matches by start position
    matches.sort(function(a, b) {
      return a.start - b.start;
    });

    // Filter overlaps and update stats
    var validMatches = [];
    var lastEnd = 0;
    for (var j = 0; j < matches.length; j++) {
      var matchItem = matches[j];
      if (matchItem.start >= lastEnd) {
        validMatches.push(matchItem);
        lastEnd = matchItem.end;
        stats[matchItem.statKey]++;
      }
    }

    // Build highlighted chunks
    var rawChunk = '';
    var anonChunk = '';
    var cursor = 0;
    for (var k = 0; k < validMatches.length; k++) {
      var mMatch = validMatches[k];
      var prefix = chunk.substring(cursor, mMatch.start);
      rawChunk += prefix + '\x01' + mMatch.rawText + '\x02';
      
      var anonText = mMatch.anonText;
      if (opts.consistent && mMatch.statKey !== 'keywords' && mMatch.statKey !== 'datetime') {
        // Strip brackets for map key
        var label = mMatch.anonText.replace('[', '').replace(']', '');
        var key = label + ':' + mMatch.rawText;
        if (!maskMap[key]) {
          maskCounters[label] = (maskCounters[label] || 0) + 1;
          maskMap[key] = '[' + label + '-' + maskCounters[label] + ']';
        }
        anonText = maskMap[key];
      }
      
      anonChunk += prefix + '\x01' + anonText + '\x02';
      cursor = mMatch.end;
    }
    var suffix = chunk.substring(cursor);
    rawChunk += suffix;
    anonChunk += suffix;

    processedRawChunks.push(rawChunk);
    processedAnonChunks.push(anonChunk);
    start = end;

    if (start < totalLength) {
      var processedStr = formatSize(start);
      var pct = Math.round((start / totalLength) * 100);
      self.postMessage({
        type: 'progress',
        progress: pct,
        phase: 'Anonymizing... ' + processedStr + ' / ' + totalSizeStr + ' (' + pct + '%)'
      });
      // Yield between chunks so postMessage is dispatched to the main thread
      setTimeout(processNextChunk, 0);
    } else {
      self.postMessage({ type: 'progress', progress: 99, phase: 'Joining results...' });

      // Use setTimeout before the join to allow the 99% message to be delivered
      setTimeout(function() {
        var result = processedAnonChunks.join('');
        var rawResult = processedRawChunks.join('');
        totalLines++; // Account for last line without trailing newline
        self.postMessage({ type: 'complete', result: result, rawResult: rawResult, stats: stats, totalLines: totalLines });
      }, 0);
    }
  }

  processNextChunk();
};
