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
    'anon-opt-consistent', 'anon-opt-keywords', 'anon-opt-autorun'
  ];
  settingsInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        if (document.getElementById('anon-opt-autorun').checked) {
          anonymizeProcess();
        }
      });
      if (id === 'anon-opt-keywords') {
        el.addEventListener('input', () => {
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
    keywords: document.getElementById('anon-opt-keywords').value
  };

  showLoader('Anonymizing logs... 0%');
  document.getElementById('anon-stats').innerHTML = '<strong>Status:</strong> Processing...';

  // Inline worker logic to bypass Chrome's file:// CORS restriction
  function workerLogic() {
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

      var keywordsList = opts.keywords && opts.keywords.trim()
        ? opts.keywords.split(',').map(function(k) { return k.trim(); }).filter(function(k) { return k.length > 0; }).sort(function(a, b) { return b.length - a.length; })
        : [];

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
        }
        
        if (keywordsList.length > 0) {
          for (var ki = 0; ki < keywordsList.length; ki++) {
            var kwEscaped = escRegex(keywordsList[ki]);
            var kwRegex = new RegExp('\\b' + kwEscaped + '\\b', 'gi');
            addMatches(kwRegex, 'REDACTED', 'keywords');
          }
        }

        matches.sort(function(a, b) {
          return a.start - b.start;
        });

        var validMatches = [];
        var lastEnd = 0;
        for (var i = 0; i < matches.length; i++) {
          var m = matches[i];
          if (m.start >= lastEnd) {
            validMatches.push(m);
            lastEnd = m.end;
            stats[m.statKey]++;
          }
        }

        var rawChunk = '';
        var anonChunk = '';
        var cursor = 0;
        for (var i = 0; i < validMatches.length; i++) {
          var m = validMatches[i];
          var prefix = chunk.substring(cursor, m.start);
          rawChunk += prefix + '\x01' + m.rawText + '\x02';
          
          var anonText = m.anonText;
          if (opts.consistent && m.statKey !== 'keywords' && m.statKey !== 'datetime') {
            // Strip brackets for map key
            var label = m.anonText.replace('[', '').replace(']', '');
            var key = label + ':' + m.rawText;
            if (!maskMap[key]) {
              maskCounters[label] = (maskCounters[label] || 0) + 1;
              maskMap[key] = '[' + label + '-' + maskCounters[label] + ']';
            }
            anonText = maskMap[key];
          }
          
          anonChunk += prefix + '\x01' + anonText + '\x02';
          cursor = m.end;
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
      if (stats.auth > 0) activeStats.push(stats.auth + ' Auth Tokens');
      if (stats.number > 0) activeStats.push(stats.number + ' Numbers');
      if (stats.keywords > 0) activeStats.push(stats.keywords + ' Custom Words');

      var statText = activeStats.length > 0
        ? 'Anonymized: ' + activeStats.join(', ') + '.'
        : 'No sensitive data detected with active rules.';
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
  alert('Anonymized log copied to clipboard!');
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
