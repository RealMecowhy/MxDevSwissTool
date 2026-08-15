// LOG & TEXT ANONYMIZER
// ============================================================
window.pendingAnonymizerText = null;

let anonymizerWorker = null;      // Web Worker instance
let anonymizerDebounceTimer = null;
let anonymizerInitialized = false;

let rawViewer = null;
let cleanViewer = null;

function anonymizeInit() {
  if (anonymizerInitialized) return;
  anonymizerInitialized = true;

  // 8.7: custom keyword list used to be per-session only (audit finding #6) —
  // restore it from toolState (metadata-sized text, never log content).
  const kwInput = document.getElementById('anon-opt-keywords');
  if (kwInput && window.mtStateGet) {
    const savedKeywords = window.mtStateGet('log-anonymizer', 'keywords', '');
    if (savedKeywords) kwInput.value = savedKeywords;
  }

  const container = document.getElementById('anonymizer-input-container');
  if (container) {
    container.addEventListener('dragover', e => { e.preventDefault(); container.classList.add('drag-over'); });
    container.addEventListener('dragleave', () => container.classList.remove('drag-over'));
    container.addEventListener('drop', e => {
      e.preventDefault();
      container.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        showLoader('Reading log file...');
        const file = e.dataTransfer.files[0];
        const reader = new FileReader();
        reader.onload = evt => {
          rawViewer.setText(evt.target.result);
          hideLoader();
          if (document.getElementById('anon-opt-autorun').checked) {
            anonymizeProcess();
          }
        };
        reader.readAsText(file);
      }
    });
  }

  window.anonLoadFile = function(files) {
    if (files && files.length > 0) {
      showLoader('Reading log file...');
      const file = files[0];
      const reader = new FileReader();
      reader.onload = evt => {
        rawViewer.setText(evt.target.result);
        hideLoader();
        if (document.getElementById('anon-opt-autorun').checked) {
          anonymizeProcess();
        }
      };
      reader.readAsText(file);
    }
  };

  // Initialize virtual viewers
  rawViewer = new VirtualTextViewer('anonymizer-raw-input', {
    placeholder: 'Paste logs here, or drag & drop a log file...'
  });
  cleanViewer = new VirtualTextViewer('anonymizer-clean-output', {
    placeholder: 'Anonymized results will appear here...'
  });
  
  // Synchronize scrolling between the two viewers
  let isSyncingLeftScroll = false;
  let isSyncingRightScroll = false;

  rawViewer.container.addEventListener('scroll', function(e) {
    if (!isSyncingLeftScroll) {
      isSyncingRightScroll = true;
      cleanViewer.container.scrollTop = this.scrollTop;
      cleanViewer.container.scrollLeft = this.scrollLeft;
    }
    isSyncingLeftScroll = false;
  });

  cleanViewer.container.addEventListener('scroll', function(e) {
    if (!isSyncingRightScroll) {
      isSyncingLeftScroll = true;
      rawViewer.container.scrollTop = this.scrollTop;
      rawViewer.container.scrollLeft = this.scrollLeft;
    }
    isSyncingRightScroll = false;
  });
  
  // Handle paste manually through the viewer's onPaste hook
  rawViewer.onPaste = (text) => {
    rawViewer.setText(text);
    if (document.getElementById('anon-opt-autorun').checked) {
      clearTimeout(anonymizerDebounceTimer);
      anonymizerDebounceTimer = setTimeout(anonymizeProcess, 300);
    }
  };

  // Bind settings change events
  const settingsInputs = [
    'anon-opt-uuid', 'anon-opt-ip', 'anon-opt-email',
    'anon-opt-mendix', 'anon-opt-datetime', 'anon-opt-number',
    'anon-opt-mac', 'anon-opt-creditcard', 'anon-opt-auth',
    'anon-opt-consistent', 'anon-opt-keywords', 'anon-opt-regex', 'anon-opt-autorun'
  ];
  settingsInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        if (document.getElementById('anon-opt-autorun').checked) {
          anonymizeProcess();
        }
      });
      if (id === 'anon-opt-keywords' || id === 'anon-opt-regex') {
        el.addEventListener('input', () => {
          if (id === 'anon-opt-keywords' && window.mtStateSet) {
            window.mtStateSet('log-anonymizer', 'keywords', el.value);
          }
          if (document.getElementById('anon-opt-autorun').checked) {
            clearTimeout(anonymizerDebounceTimer);
            anonymizerDebounceTimer = setTimeout(anonymizeProcess, 300);
          }
        });
      }
    }
  });

  // Watch for navigation to this panel
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === 'class') {
        const panel = document.getElementById('panel-log-anonymizer');
        if (panel && panel.classList.contains('active')) {
          anonymizerCheckPending();
          // Force render of virtual viewers when panel becomes visible
          if (rawViewer) rawViewer.render();
          if (cleanViewer) cleanViewer.render();
        }
      }
    });
  });
  const panelEl = document.getElementById('panel-log-anonymizer');
  if (panelEl) {
    observer.observe(panelEl, { attributes: true });
  }

  // Run immediately in case it's already active on load
  anonymizerCheckPending();
}

function anonymizerCheckPending() {
  if (window.pendingAnonymizerText !== null) {
    const text = window.pendingAnonymizerText;
    window.pendingAnonymizerText = null;
    if (rawViewer) {
      rawViewer.setText(text);
      anonymizeProcess();
    } else {
      // If viewers aren't initialized yet, defer
      setTimeout(() => {
        window.pendingAnonymizerText = text;
        anonymizerCheckPending();
      }, 50);
    }
  }
}

function anonymizeProcess() {
  // Terminate previous worker if running
  if (anonymizerWorker) {
    anonymizerWorker.terminate();
    anonymizerWorker = null;
  }
  clearTimeout(anonymizerDebounceTimer);

  const rawText = rawViewer.getText();
  if (!rawText) {
    cleanViewer.setText('');
    document.getElementById('anon-stats').innerHTML = 'Ready. Paste some logs to anonymize.';
    return;
  }

  const opts = {
    uuid: document.getElementById('anon-opt-uuid').checked,
    ip: document.getElementById('anon-opt-ip').checked,
    email: document.getElementById('anon-opt-email').checked,
    mendixId: document.getElementById('anon-opt-mendix').checked,
    datetime: document.getElementById('anon-opt-datetime').checked,
    number: document.getElementById('anon-opt-number').checked,
    mac: document.getElementById('anon-opt-mac').checked,
    creditcard: document.getElementById('anon-opt-creditcard').checked,
    auth: document.getElementById('anon-opt-auth').checked,
    consistent: document.getElementById('anon-opt-consistent').checked,
    keywords: document.getElementById('anon-opt-keywords').value,
    customRegex: (document.getElementById('anon-opt-regex') ? document.getElementById('anon-opt-regex').value : '')
  };

  // Validate custom regex patterns on the main thread so the user gets
  // immediate feedback; invalid lines are skipped by the worker.
  const invalidPatterns = [];
  opts.customRegex.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
    try { new RegExp(line, 'gi'); } catch (e) { invalidPatterns.push(line); }
  });

  showLoader('Anonymizing logs... 0%');
  document.getElementById('anon-stats').innerHTML = '<strong>Status:</strong> Processing...';

  // Inline worker logic to bypass Chrome's file:// CORS restriction
  function workerLogic() {
    function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    // Card ranges and the Mendix object-ID rule overlap by shape alone: an ID
    // like 4503599627370567 is 16 digits starting with 4, which is exactly a
    // Visa. The checksum is what actually separates them — a real card passes
    // Luhn, an arbitrary identifier does so only by chance.
    function luhnOk(s) {
      var sum = 0, alt = false;
      for (var i = s.length - 1; i >= 0; i--) {
        var d = s.charCodeAt(i) - 48;
        if (alt) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
        alt = !alt;
      }
      return sum % 10 === 0;
    }
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
      var stats = { uuid: 0, ip: 0, email: 0, mendixId: 0, datetime: 0, number: 0, mac: 0, creditcard: 0, auth: 0, keywords: 0, custom: 0 };
      var totalSizeStr = formatSize(totalLength);
      
      var maskMap = {};
      var maskCounters = {};

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
      // AWS access key IDs: a fixed 4-letter resource prefix plus 16 uppercase
      // alphanumerics. Shape alone identifies them, so no context is needed.
      // The 40-char secret key has no distinguishing shape and is caught by
      // secretAssignRegex instead (its name always contains "secret").
      var awsKeyRegex = /\b(?:AKIA|ASIA|ABIA|ACCA|AIDA|AGPA|AIPA|ANPA|ANVA|AROA)[A-Z0-9]{16}\b/g;
      // Credentials inside a URL: scheme://user:PASSWORD@host. Only the password
      // is masked (tail group) — the host and user still identify the endpoint,
      // which is usually the point of keeping the line at all.
      var urlPasswordRegex = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]{1,128}:([^\s:/@]+)(?=@)/g;
      // Cookie/Set-Cookie: the whole value, to end of line — session cookies are
      // credentials, and attributes (Path, Domain) are not worth the leak risk.
      // Chunks are always cut on a newline, so a header never spans two chunks.
      var cookieRegex = /\b(?:Set-)?Cookie:[ \t]*(\S.*)$/gim;
      // The same headers as they appear in a HAR, where name and value are two
      // separate JSON fields — so neither the raw-header rule above nor the
      // label=value rule below can see them. A HAR is the densest secret-bearing
      // artefact a developer shares, and this toolkit has an analyzer for it,
      // so the "Cookie headers" promise has to hold in this shape too. The
      // lookahead keeps the captured value at the end of the match, which is
      // what addMatches' tail-group offset requires.
      var jsonHeaderSecretRegex = /"name"[ \t]*:[ \t]*"(?:set-cookie|cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)"[ \t]*,[ \t]*"value"[ \t]*:[ \t]*"([^"]+)(?=")/gi;
      // Generic secrets, matched by their LABEL rather than by value shape —
      // an API key has no universal shape, so anything shape-based would either
      // miss most of them or redact half the log. "authorization" is deliberately
      // absent: its value starts with "Bearer ", so this rule would mask the word
      // "Bearer" and leave the token itself exposed. bearerRegex owns that case.
      var secretAssignRegex = /\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|secret|aws[_-]?secret[_-]?access[_-]?key|private[_-]?key|password|passwd|pwd)["']?[ \t]*[:=][ \t]*["']?([^\s"',;&}]{4,})/gi;

      var keywordsList = opts.keywords && opts.keywords.trim()
        ? opts.keywords.split(',').map(function(k) { return k.trim(); }).filter(function(k) { return k.length > 0; }).sort(function(a, b) { return b.length - a.length; })
        : [];

      var customRegexList = [];
      if (opts.customRegex && opts.customRegex.trim()) {
        opts.customRegex.split('\n').forEach(function(line) {
          line = line.trim();
          if (!line) return;
          try { customRegexList.push(new RegExp(line, 'gi')); } catch (e) { /* invalid pattern — reported on main thread */ }
        });
      }

      self.postMessage({
        type: 'progress',
        progress: 0,
        phase: 'Anonymizing... 0 B / ' + totalSizeStr + ' (0%)'
      });

      function processNextChunk() {
        var end = Math.min(start + chunkByteSize, totalLength);
        if (end < totalLength) {
          var nl = rawText.indexOf('\n', end);
          end = nl !== -1 ? nl + 1 : totalLength;
        }

        var chunk = rawText.substring(start, end);

        for (var i = 0; i < chunk.length; i++) {
          if (chunk.charCodeAt(i) === 10) totalLines++;
        }

        var matches = [];

        // tailGroup: mask only that capture group instead of the whole match.
        // The secret-bearing patterns need it — `Cookie: <value>` and
        // `password=<value>` must keep their label visible, or the reader cannot
        // tell what was redacted and the log stops being readable. It is
        // deliberately restricted to a group that sits at the END of the match,
        // so the offset is a length subtraction rather than a re-search (which
        // would pick the wrong occurrence when the value repeats in the match).
        function addMatches(regex, anonLabel, statKey, accept, tailGroup) {
          var match;
          while ((match = regex.exec(chunk)) !== null) {
            var text = tailGroup ? match[tailGroup] : match[0];
            if (!text) continue;
            if (accept && !accept(text)) continue;
            var startAt = match.index + (tailGroup ? match[0].length - text.length : 0);
            matches.push({
              start: startAt,
              end: startAt + text.length,
              rawText: text,
              anonText: '[' + anonLabel + ']',
              statKey: statKey
            });
          }
        }

        // Registration order decides overlaps: matches are sorted by start
        // offset with a stable sort, then resolved first-wins, so a specific
        // pattern must be added before a generic one that also covers it.
        // The Mendix ID rule (\d{15,19}) matches every card number and any long
        // digit run inside a JWT, so it runs after those two.
        // Secrets are registered FIRST, ahead of every general-purpose rule.
        // Ties on the same start offset are settled by registration order, and
        // several secrets are shaped like something more innocent: the password
        // in `scheme://user:pass@host` parses as an e-mail address (pass@host),
        // so with e-mail masking on — the default — the e-mail rule would take
        // it, label a credential `[EMAIL]` and swallow the hostname the URL rule
        // deliberately preserves. Same class of collision for an IP or UUID
        // sitting in a `password=` value.
        if (opts.auth) {
          // Within this block the order is specific → generic for the same
          // reason: the context-anchored rules must outrank a bare JWT that
          // happens to sit inside their value.
          addMatches(awsKeyRegex, 'AWS_KEY', 'auth');
          addMatches(urlPasswordRegex, 'URL_PASSWORD', 'auth', null, 1);
          addMatches(cookieRegex, 'COOKIE', 'auth', null, 1);
          addMatches(jsonHeaderSecretRegex, 'HEADER_SECRET', 'auth', null, 1);
          addMatches(secretAssignRegex, 'SECRET', 'auth', null, 1);
          addMatches(jwtRegex, 'JWT_TOKEN', 'auth');
          addMatches(bearerRegex, 'AUTH_TOKEN', 'auth');
        }
        if (opts.uuid) addMatches(uuidRegex, 'UUID', 'uuid');
        if (opts.ip) {
          addMatches(ipv4Regex, 'IP', 'ip');
          addMatches(ipv6Regex, 'IP', 'ip');
        }
        if (opts.email) addMatches(emailRegex, 'EMAIL', 'email');
        if (opts.mac) addMatches(macRegex, 'MAC', 'mac');
        if (opts.creditcard) addMatches(creditCardRegex, 'CREDIT_CARD', 'creditcard', luhnOk);
        if (opts.mendixId) addMatches(mendixIdRegex, 'MENDIX_ID', 'mendixId');
        if (opts.datetime) {
          addMatches(dateRegex1, 'DATETIME', 'datetime');
          addMatches(dateRegex2, 'TIME', 'datetime');
        }
        if (opts.number) addMatches(numRegex, 'NUM', 'number');

        if (keywordsList.length > 0) {
          for (var ki = 0; ki < keywordsList.length; ki++) {
            var kwEscaped = escRegex(keywordsList[ki]);
            var kwRegex = new RegExp('\\b' + kwEscaped + '\\b', 'gi');
            addMatches(kwRegex, 'REDACTED', 'keywords');
          }
        }

        for (var cri = 0; cri < customRegexList.length; cri++) {
          customRegexList[cri].lastIndex = 0;
          addMatches(customRegexList[cri], 'CUSTOM', 'custom');
        }

        matches.sort(function(a, b) {
          return a.start - b.start;
        });

        var validMatches = [];
        var lastEnd = 0;
        for (var mi = 0; mi < matches.length; mi++) {
          var m = matches[mi];
          if (m.start >= lastEnd) {
            validMatches.push(m);
            lastEnd = m.end;
            stats[m.statKey]++;
          }
        }

        var rawChunk = '';
        var anonChunk = '';
        var cursor = 0;
        for (var vi = 0; vi < validMatches.length; vi++) {
          var vm = validMatches[vi];
          var prefix = chunk.substring(cursor, vm.start);
          rawChunk += prefix + '\x01' + vm.rawText + '\x02';

          var anonText = vm.anonText;
          if (opts.consistent && vm.statKey !== 'keywords' && vm.statKey !== 'datetime') {
            // Strip brackets for map key
            var label = vm.anonText.replace('[', '').replace(']', '');
            var key = label + ':' + vm.rawText;
            if (!maskMap[key]) {
              maskCounters[label] = (maskCounters[label] || 0) + 1;
              maskMap[key] = '[' + label + '-' + maskCounters[label] + ']';
            }
            anonText = maskMap[key];
          }

          anonChunk += prefix + '\x01' + anonText + '\x02';
          cursor = vm.end;
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
          setTimeout(processNextChunk, 0);
        } else {
          self.postMessage({ type: 'progress', progress: 99, phase: 'Joining results...' });
          setTimeout(function() {
            var result = processedAnonChunks.join('');
            var rawResult = processedRawChunks.join('');
            totalLines++;
            self.postMessage({ type: 'complete', result: result, rawResult: rawResult, stats: stats, totalLines: totalLines });
          }, 0);
        }
      }

      processNextChunk();
    };
  }

  try {
    const code = '(' + workerLogic.toString() + ')();';
    const blob = new Blob([code], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    anonymizerWorker = new Worker(workerUrl);
  } catch (err) {
    hideLoader();
    console.error('Failed to create Web Worker:', err);
    document.getElementById('anon-stats').innerHTML = '<strong>Error:</strong> Cannot create Web Worker. Check console.';
    return;
  }

  anonymizerWorker.onmessage = function(msg) {
    var data = msg.data;
    if (data.type === 'progress') {
      showLoader(data.phase || ('Anonymizing logs... ' + data.progress + '%'));
    } else if (data.type === 'complete') {
      const stats = data.stats;
      const totalLines = data.totalLines;

      // Update virtual viewer with the complete anonymized result
      cleanViewer.setText(data.result);
      
      // Update raw viewer with highlighted markers
      if (data.rawResult) {
        rawViewer.setText(data.rawResult);
      }

      // Build stats
      var activeStats = [];
      if (stats.uuid > 0) activeStats.push(stats.uuid + ' UUIDs');
      if (stats.ip > 0) activeStats.push(stats.ip + ' IPs');
      if (stats.email > 0) activeStats.push(stats.email + ' Emails');
      if (stats.mendixId > 0) activeStats.push(stats.mendixId + ' Mendix IDs');
      if (stats.datetime > 0) activeStats.push(stats.datetime + ' Timestamps');
      if (stats.mac > 0) activeStats.push(stats.mac + ' MACs');
      if (stats.creditcard > 0) activeStats.push(stats.creditcard + ' Credit Cards');
      if (stats.auth > 0) activeStats.push(stats.auth + ' Auth Tokens &amp; Secrets');
      if (stats.number > 0) activeStats.push(stats.number + ' Numbers');
      if (stats.keywords > 0) activeStats.push(stats.keywords + ' Custom Words');
      if (stats.custom > 0) activeStats.push(stats.custom + ' Custom Regex');

      var statText = activeStats.length > 0
        ? 'Anonymized: ' + activeStats.join(', ') + '.'
        : 'No sensitive data detected with active rules.';
      if (invalidPatterns.length > 0) {
        statText += ' <span style="color:var(--danger)">Invalid regex skipped: ' + window.escHtml(invalidPatterns.join(', ')) + '</span>';
      }
      document.getElementById('anon-stats').innerHTML = '<strong>Status:</strong> ' + statText;

      hideLoader();
      anonymizerWorker.terminate();
      anonymizerWorker = null;
    }
  };

  anonymizerWorker.onerror = function(err) {
    hideLoader();
    console.error('Anonymizer worker error:', err);
    document.getElementById('anon-stats').innerHTML = '<strong>Error:</strong> Anonymization failed. ' + (err.message || '');
    anonymizerWorker = null;
  };

  anonymizerWorker.postMessage({ rawText: rawText, opts: opts });
}

function anonymizerCopy() {
  var text = cleanViewer ? cleanViewer.getText() : '';
  if (!text) return;
  copyToClipboard(text);
  window.mtToast('Anonymized log copied to clipboard!', 'success');
}

function anonymizerDownload() {
  var text = cleanViewer ? cleanViewer.getText() : '';
  if (!text) return;
  downloadText(text, 'anonymized-logs.txt');
}

function anonymizerClear() {
  if (anonymizerWorker) {
    anonymizerWorker.terminate();
    anonymizerWorker = null;
  }
  clearTimeout(anonymizerDebounceTimer);
  if (rawViewer) rawViewer.setText('');
  if (cleanViewer) cleanViewer.setText('');
  document.getElementById('anon-stats').innerHTML = 'Ready. Paste some logs to anonymize.';
}

// DOMContentLoaded removed — lifecycle managed by core.js init() export


// --- AUTO-GENERATED ESM EXPORTS ---
window.anonymizeInit = anonymizeInit;
window.anonymizerCheckPending = anonymizerCheckPending;
window.anonymizeProcess = anonymizeProcess;
window.anonymizerCopy = anonymizerCopy;
window.anonymizerDownload = anonymizerDownload;
window.anonymizerClear = anonymizerClear;

export function init() {
  if (typeof anonymizeInit === 'function') anonymizeInit();
}
