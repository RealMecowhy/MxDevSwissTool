// SHARED EXPORT HELPERS (wave 5)
// ============================================================
// One place for the three export formats every table-shaped tool needs — CSV,
// a Markdown table, and a self-contained HTML report — so each tool stops
// re-implementing quoting/escaping. The Log Query Extractor was migrated onto
// this first; the self-contained HTML builder also underpins the Incident Report.
//
// Pure string builders (mtExportToCsv / …ToMarkdown / …ToHtml) attach to
// window/self so they can be unit tested in Node; the download/copy wrappers are
// browser-only and never run at import time.

(function (root) {
  'use strict';

  function esc(v) { return String(v == null ? '' : v); }
  function htmlEscape(s) {
    return esc(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // RFC 4180: quote every field, double embedded quotes. CRLF line endings keep
  // Excel happy. header is an array of column names; rows an array of arrays.
  function mtExportToCsv(header, rows) {
    const q = function (v) { return '"' + esc(v).replace(/"/g, '""') + '"'; };
    const lines = [header.map(q).join(',')];
    for (let i = 0; i < rows.length; i++) lines.push(rows[i].map(q).join(','));
    return lines.join('\r\n');
  }

  // GitHub-flavoured Markdown table. Pipes and newlines in cells are neutralized
  // so the table can't break out of its row.
  function mtExportToMarkdown(header, rows) {
    const cell = function (v) { return esc(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); };
    const lines = [
      '| ' + header.map(cell).join(' | ') + ' |',
      '|' + header.map(function () { return '---'; }).join('|') + '|'
    ];
    for (let i = 0; i < rows.length; i++) lines.push('| ' + rows[i].map(cell).join(' | ') + ' |');
    return lines.join('\n');
  }

  // Self-contained HTML report: a single file with inline CSS, no external
  // requests — safe to email or archive. opts:
  //   { title, subtitle?, meta?: [{label,value}], columns, rows, note?,
  //     sections?: [{ title, subtitle?, columns, rows, note? }] }
  // A report is either one table (columns/rows) or several (sections) — the
  // Incident Report uses sections; a single tool export uses columns/rows.
  function mtExportToHtml(opts) {
    opts = opts || {};
    const generated = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

    function tableHtml(cols, rows) {
      const head = '<tr>' + (cols || []).map(function (c) { return '<th>' + htmlEscape(c) + '</th>'; }).join('') + '</tr>';
      const body = (rows || []).map(function (r) {
        return '<tr>' + r.map(function (v) { return '<td>' + htmlEscape(v) + '</td>'; }).join('') + '</tr>';
      }).join('');
      if (!rows || !rows.length) {
        return '<p class="empty">No rows.</p>';
      }
      return '<div class="tw"><table><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
    }

    function sectionHtml(s) {
      return '<section>'
        + '<h2>' + htmlEscape(s.title) + '</h2>'
        + (s.subtitle ? '<p class="sub">' + htmlEscape(s.subtitle) + '</p>' : '')
        + tableHtml(s.columns, s.rows)
        + (s.note ? '<p class="note">' + htmlEscape(s.note) + '</p>' : '')
        + '</section>';
    }

    const metaHtml = (opts.meta && opts.meta.length)
      ? '<div class="meta">' + opts.meta.map(function (m) {
          return '<span class="chip"><b>' + htmlEscape(m.label) + '</b> ' + htmlEscape(m.value) + '</span>';
        }).join('') + '</div>'
      : '';

    const bodyInner = (opts.sections && opts.sections.length)
      ? opts.sections.map(sectionHtml).join('')
      : (opts.title || opts.columns
          ? sectionHtml({ title: opts.sectionTitle || 'Data', columns: opts.columns, rows: opts.rows, note: opts.note })
          : '');

    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>' + htmlEscape(opts.title || 'MxDev Swiss Tool report') + '</title>'
      + '<style>'
      + ':root{color-scheme:light dark;--bg:#0f1115;--panel:#171a21;--border:#2a2f3a;--text:#e6e8ec;--muted:#9aa1ad;--accent:#e8862e;--th:#1e222b;}'
      + '@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--panel:#fff;--border:#e2e5ea;--text:#1c1f26;--muted:#5c6470;--accent:#c86a12;--th:#f0f2f5;}}'
      + '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px;}'
      + '.wrap{max-width:1200px;margin:0 auto}h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.05rem;margin:28px 0 6px}'
      + '.subtitle{color:var(--muted);margin:0 0 16px}.sub{color:var(--muted);margin:0 0 10px;font-size:0.85rem}'
      + '.meta{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px}.chip{background:var(--panel);border:1px solid var(--border);border-radius:999px;padding:4px 12px;font-size:0.8rem;color:var(--muted)}.chip b{color:var(--text);font-weight:600}'
      + '.tw{overflow-x:auto;border:1px solid var(--border);border-radius:8px;background:var(--panel)}'
      + 'table{border-collapse:collapse;width:100%;font-size:0.82rem}th,td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--border);vertical-align:top;white-space:pre-wrap;word-break:break-word;max-width:520px}'
      + 'th{background:var(--th);position:sticky;top:0;font-weight:600}tbody tr:last-child td{border-bottom:none}tbody tr:hover td{background:color-mix(in srgb,var(--accent) 6%,transparent)}'
      + '.empty{color:var(--muted);padding:16px;margin:0}.note{color:var(--muted);font-size:0.8rem;margin:8px 0 0}'
      + 'footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--border);color:var(--muted);font-size:0.78rem}'
      + 'footer a{color:var(--accent)}'
      + '</style></head><body><div class="wrap">'
      + '<h1>' + htmlEscape(opts.title || 'MxDev Swiss Tool report') + '</h1>'
      + (opts.subtitle ? '<p class="subtitle">' + htmlEscape(opts.subtitle) + '</p>' : '')
      + metaHtml
      + bodyInner
      + '<footer>Generated ' + htmlEscape(generated) + ' by MxDev Swiss Tool. Fully self-contained — no external resources. '
      + 'Review for sensitive data before sharing; the Log &amp; Text Anonymizer can scrub logs first.</footer>'
      + '</div></body></html>';
  }

  // epoch ms → "YYYY-MM-DD HH:MM:SS UTC" for report metadata (UTC to match the
  // ms basis every tool's tsToMs helper produces).
  function mtFmtTs(ms) {
    if (ms == null || isNaN(ms)) return '';
    const d = new Date(ms);
    const p = function (n) { return String(n).length < 2 ? '0' + n : '' + n; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
      p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' UTC';
  }

  // Assembles the Incident Report model from the per-tool report sections the
  // Incident Report tool collected (each already filtered to the window). Pure:
  // returns an options object ready for mtExportToHtml. sections is an array of
  // { id, title, subtitle, columns, rows, total, firstMs, lastMs }; opts carries
  // { title, fromMs, toMs, notes }.
  function mtBuildIncidentReport(sections, opts) {
    opts = opts || {};
    sections = (sections || []).filter(Boolean);
    let minMs = Infinity, maxMs = -Infinity, totalRows = 0;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      if (s.firstMs != null && !isNaN(s.firstMs)) minMs = Math.min(minMs, s.firstMs);
      if (s.lastMs != null && !isNaN(s.lastMs)) maxMs = Math.max(maxMs, s.lastMs);
      totalRows += (s.total != null ? s.total : (s.rows ? s.rows.length : 0));
    }
    const windowLabel = (opts.fromMs != null || opts.toMs != null)
      ? ((opts.fromMs != null ? mtFmtTs(opts.fromMs) : 'start') + '  →  ' + (opts.toMs != null ? mtFmtTs(opts.toMs) : 'end'))
      : (minMs !== Infinity ? mtFmtTs(minMs) + '  →  ' + mtFmtTs(maxMs) : 'all loaded data');
    const meta = [
      { label: 'Time window', value: windowLabel },
      { label: 'Sources', value: sections.length ? sections.map(function (s) { return s.id; }).join(', ') : 'none' },
      { label: 'Total rows', value: totalRows }
    ];
    return {
      title: opts.title || 'Mendix Incident Report',
      subtitle: opts.notes ? opts.notes : 'Correlated view across the loaded diagnostics tools for the selected time window.',
      meta: meta,
      sections: sections.map(function (s) { return { title: s.title, subtitle: s.subtitle, columns: s.columns, rows: s.rows }; })
    };
  }

  root.mtExportToCsv = mtExportToCsv;
  root.mtExportToMarkdown = mtExportToMarkdown;
  root.mtExportToHtml = mtExportToHtml;
  root.mtFmtTs = mtFmtTs;
  root.mtBuildIncidentReport = mtBuildIncidentReport;

  // ── Browser-only convenience wrappers ──────────────────────────────────────
  if (typeof document !== 'undefined') {
    const download = function (text, filename, mime) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain;charset=utf-8' }));
      a.download = filename;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
    };
    const flashBtn = function (btn, label) {
      if (!btn) return;
      const old = btn.innerHTML;
      btn.innerHTML = label || 'Copied!';
      setTimeout(function () { btn.innerHTML = old; }, 2000);
    };

    root.mtExport = {
      csv: mtExportToCsv,
      markdown: mtExportToMarkdown,
      html: mtExportToHtml,
      downloadCsv: function (filename, header, rows) { download(mtExportToCsv(header, rows), filename, 'text/csv;charset=utf-8'); },
      downloadHtml: function (filename, opts) { download(mtExportToHtml(opts), filename, 'text/html;charset=utf-8'); },
      buildIncident: mtBuildIncidentReport,
      incidentHtml: function (sections, opts) { return mtExportToHtml(mtBuildIncidentReport(sections, opts)); },
      downloadIncident: function (filename, sections, opts) { download(mtExportToHtml(mtBuildIncidentReport(sections, opts)), filename, 'text/html;charset=utf-8'); },
      copyMarkdown: function (header, rows, btn) {
        const md = mtExportToMarkdown(header, rows);
        if (navigator.clipboard) navigator.clipboard.writeText(md).then(function () { flashBtn(btn); });
        return md;
      }
    };
  }
})(typeof window !== 'undefined' ? window : self);
