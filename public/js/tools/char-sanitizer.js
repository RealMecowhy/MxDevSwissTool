// CHARACTER SANITIZER & MOJIBAKE FIXER LOGIC
// ============================================================

// Polish Mojibake Map
const CS_MOJIBAKE_MAP = {
  'Ä…': { rep: 'ą', desc: 'ą (UTF-8 as CP1250)' },
  'Ä„': { rep: 'Ą', desc: 'Ą (UTF-8 as CP1250)' },
  'Ä‡': { rep: 'ć', desc: 'ć (UTF-8 as CP1250)' },
  'Ä†': { rep: 'Ć', desc: 'Ć (UTF-8 as CP1250)' },
  'Ä™': { rep: 'ę', desc: 'ę (UTF-8 as CP1250)' },
  'Ä˜': { rep: 'Ę', desc: 'Ę (UTF-8 as CP1250)' },
  'Ä\u0098': { rep: 'Ę', desc: 'Ę (UTF-8 as CP1250)' },
  'Ä˜': { rep: 'Ę', desc: 'Ę (UTF-8 as CP1250)' },
  'Å‚': { rep: 'ł', desc: 'ł (UTF-8 as CP1250)' },
  'Å ': { rep: 'Ł', desc: 'Ł (UTF-8 as CP1250)' },
  'Å\u0081': { rep: 'Ł', desc: 'Ł (UTF-8 as CP1250)' },
  'Å„': { rep: 'ń', desc: 'ń (UTF-8 as CP1250)' },
  'Åƒ': { rep: 'Ń', desc: 'Ń (UTF-8 as CP1250)' },
  'Ã³': { rep: 'ó', desc: 'ó (UTF-8 as CP1250)' },
  'Ã“': { rep: 'Ó', desc: 'Ó (UTF-8 as CP1250)' },
  'Å›': { rep: 'ś', desc: 'ś (UTF-8 as CP1250)' },
  'Å\u009A': { rep: 'Ś', desc: 'Ś (UTF-8 as CP1250)' },
  'Åº': { rep: 'ź', desc: 'ź (UTF-8 as CP1250)' },
  'Å¹': { rep: 'Ź', desc: 'Ź (UTF-8 as CP1250)' },
  'Å¼': { rep: 'ż', desc: 'ż (UTF-8 as CP1250)' },
  'Å»': { rep: 'Ż', desc: 'Ż (UTF-8 as CP1250)' },
  'â€ž': { rep: '„', desc: 'Opening Quote „ (UTF-8 as CP1250)' },
  'â€ ': { rep: '”', desc: 'Closing Quote ” (UTF-8 as CP1250)' },
  'â€\u009d': { rep: '”', desc: 'Closing Quote ” (UTF-8 as CP1250)' },
  'â€“': { rep: '–', desc: 'En Dash – (UTF-8 as CP1250)' },
  'â€”': { rep: '—', desc: 'Em Dash — (UTF-8 as CP1250)' },
  'â€¦': { rep: '…', desc: 'Ellipsis … (UTF-8 as CP1250)' },
  'â€™': { rep: '’', desc: 'Apostrophe ’ (UTF-8 as CP1250)' },
  'Â ': { rep: ' ', desc: 'NBSP Space (UTF-8 as CP1250)' }
};

// C0 Control Names
const CS_CTRL_NAMES = {
  0: 'NUL (Null)', 1: 'SOH (Start of Heading)', 2: 'STX (Start of Text)', 3: 'ETX (End of Text)',
  4: 'EOT (End of Transmission)', 5: 'ENQ (Enquiry)', 6: 'ACK (Acknowledge)', 7: 'BEL (Bell)',
  8: 'BS (Backspace)', 11: 'VT (Vertical Tab)', 12: 'FF (Form Feed)', 14: 'SO (Shift Out)',
  15: 'SI (Shift In)', 16: 'DLE (Data Link Escape)', 17: 'DC1 (Device Control 1)', 18: 'DC2 (Device Control 2)',
  19: 'DC3 (Device Control 3)', 20: 'DC4 (Device Control 4)', 21: 'NAK (Negative Acknowledge)', 22: 'SYN (Synchronous Idle)',
  23: 'ETB (End of Trans. Block)', 24: 'CAN (Cancel)', 25: 'EM (End of Medium)', 26: 'SUB (Substitute)',
  27: 'ESC (Escape)', 28: 'FS (File Separator)', 29: 'GS (Group Separator)', 30: 'RS (Record Separator)',
  31: 'US (Unit Separator)', 127: 'DEL (Delete)'
};

// Invisible Character Map
const CS_INVISIBLE_MAP = {
  '\u200B': { name: 'Zero-width Space (ZWSP)', label: 'ZWSP' },
  '\uFEFF': { name: 'Byte Order Mark (BOM)', label: 'BOM' },
  '\u200C': { name: 'Zero-width Non-joiner (ZWNJ)', label: 'ZWNJ' },
  '\u200D': { name: 'Zero-width Joiner (ZWJ)', label: 'ZWJ' },
  '\u200E': { name: 'Left-to-Right Mark (LRM)', label: 'LRM' },
  '\u200F': { name: 'Right-to-Left Mark (RLM)', label: 'RLM' },
  '\u2060': { name: 'Word Joiner (WJ)', label: 'WJ' },
  '\u00A0': { name: 'Non-breaking Space (NBSP)', label: 'NBSP' },
  '\u202F': { name: 'Narrow No-Break Space (NNBSP)', label: 'NNBSP' },
  '\u205F': { name: 'Medium Mathematical Space (MMSP)', label: 'MMSP' },
  '\u3000': { name: 'Ideographic Space (Japanese Space)', label: 'IDSP' },
  '\u00AD': { name: 'Soft Hyphen (SHY)', label: 'SHY' },
  '\uFFFC': { name: 'Object Replacement Character', label: 'ORC' },
  '\uFFFD': { name: 'Replacement Character (Invalid byte sequence)', label: 'REPL' }
};

let csCurrentTab = 'inspector';
let csAnalysisResult = null;

// Switch tab handler
function sanitizeSwitchTab(tabId) {
  csCurrentTab = tabId;
  const tabs = ['inspector', 'stats', 'output'];
  tabs.forEach(t => {
    const tabEl = document.getElementById('cs-tab-' + t);
    const panelEl = document.getElementById('cs-panel-' + t);
    if (tabEl) tabEl.classList.toggle('active', t === tabId);
    if (panelEl) {
      panelEl.style.display = (t === tabId) ? 'flex' : 'none';
    }
  });
}

// Clear all inputs/outputs
function sanitizeClearInput() {
  document.getElementById('char-sanitizer-input').value = '';
  document.getElementById('char-sanitizer-preview').innerHTML = '<span style="color:var(--text-muted)">Output will appear here...</span>';
  document.getElementById('char-sanitizer-status').innerHTML = '';
  document.getElementById('char-sanitizer-stats-summary').className = 'notice notice-info';
  document.getElementById('char-sanitizer-stats-summary').textContent = 'Analyze some text to view statistics.';
  document.getElementById('char-sanitizer-stats-table').style.display = 'none';
  document.getElementById('char-sanitizer-output-text').value = '';
  csAnalysisResult = null;
}

// Load a rich sample text with problems
function sanitizeLoadSample() {
  const sampleText = `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <!-- This file contains hidden errors, non-breaking spaces, and mojibake -->
  <record id="1">
    <status>Active\u200B</status> <!-- Contains invisible ZWSP (Zero Width Space) at the end -->
    <address>Main Street\u00A0100/12</address> <!-- Non-breaking space (NBSP) between street and number -->
    <name>John Doe</name>
    <description>User data ą and ł was encoded incorrectly: ó and ż.</description> <!-- Polish mojibake -->
    <notes>Warning! Bell character\u0007 and end of file character\u001A are not allowed in XML 1.0.</notes> <!-- Control characters C0 -->
  </record>
</root>`;
  document.getElementById('char-sanitizer-input').value = sampleText;
  sanitizeAnalyze();
}

// Run main character analysis
function sanitizeAnalyze() {
  const raw = document.getElementById('char-sanitizer-input').value;
  
  // Hide empty state overlay if there is text
  const overlay = document.querySelector('#panel-char-sanitizer .empty-state-overlay');
  if (overlay) {
    overlay.style.display = raw ? 'none' : 'flex';
  }

  if (!raw) {
    sanitizeClearInput();
    return;
  }

  // Read options
  const optInvisible = document.getElementById('cs-opt-invisible').checked;
  const optControl = document.getElementById('cs-opt-control').checked;
  const optXml = document.getElementById('cs-opt-xml').checked;
  const optMojibake = document.getElementById('cs-opt-mojibake').checked;
  const optNonAscii = document.getElementById('cs-opt-nonascii').checked;
  const optShowMarkers = document.getElementById('cs-opt-show-markers').checked;

  const stats = {};
  const issues = [];
  
  // Highlighting engine variables
  let htmlPreview = '';
  const maxPreviewLength = 50000;
  let isCapped = raw.length > maxPreviewLength;
  let renderLength = isCapped ? maxPreviewLength : raw.length;

  // We iterate using codepoints / index to handle Mojibake, control characters, and surrogates
  let i = 0;
  while (i < raw.length) {
    let char = raw[i];
    let code = raw.charCodeAt(i);
    let nextCode = (i + 1 < raw.length) ? raw.charCodeAt(i + 1) : 0;
    
    let matchedIssue = null; // { category, name, label, matchLength, visualRepl }

    // 1. Check for Mojibake (multi-char sequence check first)
    if (optMojibake) {
      // Check 3-char sequences first
      if (i + 2 < raw.length) {
        const threeChar = raw.slice(i, i + 3);
        if (CS_MOJIBAKE_MAP[threeChar]) {
          matchedIssue = {
            category: 'mojibake',
            name: CS_MOJIBAKE_MAP[threeChar].desc,
            label: `MOJI:${CS_MOJIBAKE_MAP[threeChar].rep}`,
            matchLength: 3,
            visualRepl: threeChar
          };
        }
      }
      
      // Check 2-char sequences
      if (!matchedIssue && i + 1 < raw.length) {
        const twoChar = raw.slice(i, i + 2);
        if (CS_MOJIBAKE_MAP[twoChar]) {
          matchedIssue = {
            category: 'mojibake',
            name: CS_MOJIBAKE_MAP[twoChar].desc,
            label: `MOJI:${CS_MOJIBAKE_MAP[twoChar].rep}`,
            matchLength: 2,
            visualRepl: twoChar
          };
        }
      }
    }

    // 2. Check for Single character issues
    if (!matchedIssue) {
      const charStr = raw[i];
      
      if (optInvisible && CS_INVISIBLE_MAP[charStr]) {
        matchedIssue = {
          category: 'invisible',
          name: CS_INVISIBLE_MAP[charStr].name,
          label: CS_INVISIBLE_MAP[charStr].label,
          matchLength: 1,
          visualRepl: charStr
        };
      } else if (optXml && ((code >= 0 && code <= 31 && code !== 9 && code !== 10 && code !== 13) || code === 0xFFFE || code === 0xFFFF)) {
        // XML invalid character (specifically C0 controls or non-characters)
        const ctrlName = CS_CTRL_NAMES[code] || `U+${code.toString(16).toUpperCase()}`;
        matchedIssue = {
          category: 'xml-invalid',
          name: `Not allowed XML 1.0 character: ${ctrlName}`,
          label: `XML-ERR:0x${code.toString(16).toUpperCase()}`,
          matchLength: 1,
          visualRepl: charStr
        };
      } else if (optControl && ((code >= 0 && code <= 31 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159))) {
        // General C0/C1 control characters
        const ctrlName = CS_CTRL_NAMES[code] || `C1 Control 0x${code.toString(16).toUpperCase()}`;
        matchedIssue = {
          category: 'control',
          name: `Control character: ${ctrlName}`,
          label: `CTRL:0x${code.toString(16).toUpperCase()}`,
          matchLength: 1,
          visualRepl: charStr
        };
      } else if (optNonAscii && code > 127) {
        // General non-ASCII
        matchedIssue = {
          category: 'non-ascii',
          name: `Non-ASCII character (U+${code.toString(16).toUpperCase()})`,
          label: `U+${code.toString(16).toUpperCase()}`,
          matchLength: 1,
          visualRepl: charStr
        };
      }
    }

    // 3. Process the match
    if (matchedIssue) {
      const matchText = raw.slice(i, i + matchedIssue.matchLength);
      
      // Update statistics
      const statKey = `${matchedIssue.category}|${matchedIssue.name}|${matchedIssue.label}|${matchText}`;
      stats[statKey] = (stats[statKey] || 0) + 1;

      // Add to issues list
      issues.push({
        index: i,
        length: matchedIssue.matchLength,
        char: matchText,
        hex: matchText.split('').map(c => 'U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' '),
        category: matchedIssue.category,
        name: matchedIssue.name,
        label: matchedIssue.label
      });

      // Append HTML highlight for visual preview (if within render cap)
      if (i < renderLength) {
        let displayStr = matchedIssue.label;
        
        // Custom visual representations
        if (matchedIssue.category === 'mojibake') {
          const mapRep = CS_MOJIBAKE_MAP[matchText];
          if (optShowMarkers) {
            displayStr = `${escHtml(matchText)}[→${mapRep.rep}]`;
          } else {
            displayStr = escHtml(matchText);
          }
        } else if (matchedIssue.category === 'invisible') {
          // Zero-width characters MUST show a label to be visible
          const isZeroWidth = (matchText === '\u200B' || matchText === '\uFEFF' || matchText === '\u200C' || matchText === '\u200D' || matchText === '\u200E' || matchText === '\u200F' || matchText === '\u2060' || matchText === '\u00AD');
          if (optShowMarkers || isZeroWidth) {
            displayStr = `[${matchedIssue.label}]`;
          } else {
            displayStr = escHtml(matchText);
          }
        } else {
          // Controls and XML errors
          displayStr = optShowMarkers ? `[${matchedIssue.label}]` : '';
        }

        const cssClass = `char-highlight char-${matchedIssue.category}`;
        htmlPreview += `<span class="${cssClass}" data-tooltip="${escHtml(matchedIssue.name)} (${escHtml(matchedIssue.label)})">${displayStr}</span>`;
      }

      // Advance loop index
      i += matchedIssue.matchLength;
    } else {
      // Normal character
      if (i < renderLength) {
        htmlPreview += escHtml(char);
      }
      i++;
    }
  }

  // Handle preview cap warning
  if (isCapped) {
    htmlPreview += `\n\n<div class="jt-error" style="display:block;margin-top:var(--sp-3)">Preview truncated to 50,000 characters. The whole text (${raw.length.toLocaleString()} characters) was analyzed.</div>`;
  }

  // Render Visual Preview
  document.getElementById('char-sanitizer-preview').innerHTML = htmlPreview || '<span style="color:var(--text-muted)">Empty text...</span>';

  // Build Stats Tab
  csAnalysisResult = { raw, issues, stats };
  renderStatsTable();

  // Update badge and status
  const badgeContainer = document.getElementById('char-sanitizer-status');
  if (issues.length === 0) {
    badgeContainer.innerHTML = '<span class="badge badge-success">&#10003; Clean text</span>';
  } else {
    badgeContainer.innerHTML = `<span class="badge badge-error">&#10007; Issues found: ${issues.length}</span>`;
  }

  // Auto update sanitized output tab
  sanitizeOutput();
}

// Render Stats Table
function renderStatsTable() {
  const summaryEl = document.getElementById('char-sanitizer-stats-summary');
  const tableEl = document.getElementById('char-sanitizer-stats-table');
  const bodyEl = document.getElementById('char-sanitizer-stats-body');

  if (!csAnalysisResult || csAnalysisResult.issues.length === 0) {
    summaryEl.className = 'notice notice-success';
    summaryEl.innerHTML = '<strong>Congratulations!</strong> No suspicious or hidden characters found in the text.';
    tableEl.style.display = 'none';
    bodyEl.innerHTML = '';
    return;
  }

  summaryEl.className = 'notice notice-warning';
  summaryEl.innerHTML = `Detected <strong>${csAnalysisResult.issues.length}</strong> problematic characters (unique types: ${Object.keys(csAnalysisResult.stats).length}).`;
  
  let html = '';
  for (const key in csAnalysisResult.stats) {
    const parts = key.split('|');
    const category = parts[0];
    const name = parts[1];
    const label = parts[2];
    const matchText = parts[3];
    const count = csAnalysisResult.stats[key];
    
    // Format character column for visualization
    let charVisual = escHtml(matchText);
    if (category === 'invisible' && (matchText === '\u200B' || matchText === '\uFEFF' || matchText === '\u200C' || matchText === '\u200D' || matchText === '\u200E' || matchText === '\u200F' || matchText === '\u2060' || matchText === '\u00AD')) {
      charVisual = `<span style="color:var(--text-muted);font-style:italic">[Invisible]</span>`;
    }

    const hexCodes = matchText.split('').map(c => 'U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');

    html += `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:var(--sp-2);font-family:var(--font-mono);font-weight:bold">${charVisual}</td>
      <td style="padding:var(--sp-2);font-family:var(--font-mono);font-size:0.75rem">${hexCodes}</td>
      <td style="padding:var(--sp-2)"><span class="badge" style="background:var(--bg-hover);color:var(--text-primary)">${category.toUpperCase()}</span></td>
      <td style="padding:var(--sp-2)">${escHtml(name)}</td>
      <td style="padding:var(--sp-2);text-align:right;font-weight:bold">${count}</td>
    </tr>`;
  }

  bodyEl.innerHTML = html;
  tableEl.style.display = 'table';
}

// Generate Sanitized Output
function sanitizeOutput() {
  if (!csAnalysisResult) {
    document.getElementById('char-sanitizer-output-text').value = '';
    return;
  }

  const cleanInvisible = document.getElementById('cs-clean-invisible').checked;
  const cleanMojibake = document.getElementById('cs-clean-mojibake').checked;
  const cleanXml = document.getElementById('cs-clean-xml').checked;
  const cleanNbsp = document.getElementById('cs-clean-nbsp').checked;

  let text = csAnalysisResult.raw;

  // 1. Repair Mojibake (replace multi-character patterns first to avoid single character collisions)
  if (cleanMojibake) {
    // Sort keys by length descending to replace longer sequences (like â€ž) before shorter ones
    const sortedMojibakeKeys = Object.keys(CS_MOJIBAKE_MAP).sort((a, b) => b.length - a.length);
    for (const key of sortedMojibakeKeys) {
      if (text.includes(key)) {
        const replacement = CS_MOJIBAKE_MAP[key].rep;
        // Global replace
        text = text.split(key).join(replacement);
      }
    }
  }

  // 2. Perform character-by-character replacements
  let cleanedText = '';
  let i = 0;
  while (i < text.length) {
    let char = text[i];
    let code = text.charCodeAt(i);

    let stripChar = false;
    let replacementChar = null;

    // Check NBSP replacement
    if (cleanNbsp && char === '\u00A0') {
      replacementChar = ' ';
    }
    
    // Check general invisible characters (ZWSP, BOM, etc.)
    if (!replacementChar && cleanInvisible && CS_INVISIBLE_MAP[char] && char !== '\u00A0') {
      stripChar = true;
    }

    // Check invalid XML 1.0 tokens
    if (!replacementChar && !stripChar && cleanXml) {
      // XML 1.0 criteria: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
      const isValidXml = (code === 9 || code === 10 || code === 13 || 
                          (code >= 32 && code <= 55295) || 
                          (code >= 57344 && code <= 65533) || 
                          (code >= 65536 && code <= 1114111));
      
      // Keep valid surrogate pairs!
      let isSurrogate = false;
      if (code >= 0xD800 && code <= 0xDBFF) {
        if (i + 1 < text.length) {
          let nextCode = text.charCodeAt(i + 1);
          if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
            isSurrogate = true;
          }
        }
      }

      if (!isValidXml && !isSurrogate) {
        stripChar = true;
      }
    }

    // Check other control characters
    if (!replacementChar && !stripChar && cleanInvisible) {
      const isControl = ((code >= 0 && code <= 31 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159));
      if (isControl) {
        stripChar = true;
      }
    }

    if (replacementChar !== null) {
      cleanedText += replacementChar;
      i++;
    } else if (stripChar) {
      // Just skip this character (or skip surrogate pair)
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
        let nextCode = text.charCodeAt(i + 1);
        if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
          i += 2;
          continue;
        }
      }
      i++;
    } else {
      // Keep character (or surrogate pair)
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
        let nextCode = text.charCodeAt(i + 1);
        if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
          cleanedText += text.slice(i, i + 2);
          i += 2;
          continue;
        }
      }
      cleanedText += char;
      i++;
    }
  }

  document.getElementById('char-sanitizer-output-text').value = cleanedText;
}

// Copy Sanitized Output
function sanitizeCopyOutput() {
  const txt = document.getElementById('char-sanitizer-output-text').value;
  if (!txt) return;
  copyToClipboard(txt);
  
  // Show notification feedback on the button
  const statusEl = document.getElementById('char-sanitizer-status');
  const oldHTML = statusEl.innerHTML;
  statusEl.innerHTML = '<span class="badge badge-success">&#10003; Copied to clipboard!</span>';
  setTimeout(() => {
    statusEl.innerHTML = oldHTML;
  }, 2000);
}

// Download Sanitized Output as file
function sanitizeDownloadOutput() {
  const txt = document.getElementById('char-sanitizer-output-text').value;
  if (!txt) return;
  
  // Try to figure out if it was XML
  const isXml = txt.trim().startsWith('<');
  const filename = isXml ? 'cleansed_message.xml' : 'cleansed_text.txt';
  
  downloadText(txt, filename);
}


// --- AUTO-GENERATED ESM EXPORTS ---
window.sanitizeSwitchTab = sanitizeSwitchTab;
window.sanitizeClearInput = sanitizeClearInput;
window.sanitizeLoadSample = sanitizeLoadSample;
window.sanitizeAnalyze = sanitizeAnalyze;
window.renderStatsTable = renderStatsTable;
window.sanitizeOutput = sanitizeOutput;
window.sanitizeCopyOutput = sanitizeCopyOutput;
window.sanitizeDownloadOutput = sanitizeDownloadOutput;

export function init() {}
