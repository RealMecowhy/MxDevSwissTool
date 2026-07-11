// DATA FACTORY
// High-Volume Mock Data Generator

let dfSchema = window.dfSchema || [
  { name: 'ID', type: 'UUID' },
  { name: 'FullName', type: 'Name' },
  { name: 'EmailAddress', type: 'Email' }
];
window.dfSchema = dfSchema;

let dfWorker = null;
let dfDraggedColumnIndex = null;

function dfHandleDragStart(e, index) {
  dfDraggedColumnIndex = index;
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.style.opacity = '0.4';
}

function dfHandleDragOver(e, index) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  return false;
}

function dfHandleDrop(e, index) {
  e.stopPropagation();
  if (dfDraggedColumnIndex !== null && dfDraggedColumnIndex !== index) {
    const movedItem = dfSchema.splice(dfDraggedColumnIndex, 1)[0];
    dfSchema.splice(index, 0, movedItem);
    dfRenderSchema();
  }
  return false;
}

function dfHandleDragEnd(e) {
  e.currentTarget.style.opacity = '1';
  dfDraggedColumnIndex = null;
}

window.dfRenderSchema = dfRenderSchema;
function dfRenderSchema() {
  const list = document.getElementById('df-schema-list');
  if (!list) return;
  
  const types = ['UUID', 'Name', 'Surname', 'FullName', 'Email', 'Number', 'Integer', 'Positive value', 'Negative value', 'Decimal', 'Boolean', 'Date', 'String', 'Address', 'City', 'Country', 'Phone', 'Company', 'IP Address', 'Constant'];
  
  let html = '';
  dfSchema.forEach((s, i) => {
    html += `<div draggable="true" 
      ondragstart="dfHandleDragStart(event, ${i})"
      ondragover="dfHandleDragOver(event, ${i})"
      ondrop="dfHandleDrop(event, ${i})"
      ondragend="dfHandleDragEnd(event)"
      style="display:flex;gap:var(--sp-2);margin-bottom:var(--sp-2);align-items:center;cursor:grab;" class="df-schema-row">
      <div title="Drag to reorder" style="color:var(--text-muted);display:flex;align-items:center;padding:0 var(--sp-1);">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"/></svg>
      </div>
      <select class="select select-sm" onchange="dfUpdateSchema(${i}, 'type', this.value)" style="width: 140px;">
        ${types.map(t => `<option value="${t}" ${s.type === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <input type="text" class="input input-sm" style="flex:1" placeholder="Field name" value="${escHtml(s.name)}" onchange="dfUpdateSchema(${i}, 'name', this.value)">
      ${s.type === 'Constant' ? `<input type="text" class="input input-sm" style="flex:1" placeholder="Constant value" value="${escHtml(s.constantValue || '')}" onchange="dfUpdateSchema(${i}, 'constantValue', this.value)">` : ''}
      <button class="btn btn-ghost btn-sm" onclick="dfRemoveColumn(${i})" style="color:var(--danger)">&times;</button>
    </div>`;
  });
  list.innerHTML = html;
}

function dfUpdateSchema(index, key, value) {
  if (key === 'type') {
    const oldType = dfSchema[index].type;
    dfSchema[index].type = value;
    if (!dfSchema[index].name || dfSchema[index].name === oldType || dfSchema[index].name === 'String' || dfSchema[index].name.startsWith('NewColumn')) {
      dfSchema[index].name = value;
    }
    dfRenderSchema();
    dfPreview();
  } else {
    dfSchema[index][key] = value;
    dfPreview();
  }
}

function dfAddColumn() {
  dfSchema.push({ name: 'String', type: 'String' });
  dfRenderSchema();
}

function dfRemoveColumn(index) {
  dfSchema.splice(index, 1);
  dfRenderSchema();
  dfPreview();
}

window.dfGenerate = dfGenerate;
function dfGenerate() {
  const count = parseInt(document.getElementById('df-count').value);
  const format = document.getElementById('df-format').value;
  const btn = document.getElementById('df-generate-btn');
  
  if (isNaN(count) || count <= 0) return alert('Invalid count');
  if (dfSchema.length === 0) return alert('Schema is empty');
  
  btn.disabled = true;
  
  if (dfWorker) {
    dfWorker.terminate();
    dfWorker = null;
  }
  
  showLoader('Generating data... 0%');

  // Inline worker logic to bypass bundler path issues
  function workerLogic() {
    self.onmessage = function(e) {
      var schema = e.data.schema;
      var count = e.data.count;
      var format = e.data.format;
      
      var result = '';
      var randInt = function(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; };
      var randString = function(len) { return Math.random().toString(36).substring(2, len + 2); };
      var randDate = function() { return new Date(Date.now() - randInt(0, 10000000000)).toISOString(); };
      var randUUID = function() { return (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); };
      var firstNames = ['John','Jane','Alice','Bob','Charlie','Eve','David','Sarah','Michael','Emma'];
      var lastNames = ['Smith','Doe','Johnson','Brown','Williams','Jones','Garcia','Miller','Davis','Rodriguez'];
      var companies = ['Acme Corp', 'Globex', 'Soylent', 'Initech', 'Umbrella Corp', 'Massive Dynamic', 'Stark Industries', 'Wayne Enterprises'];
      var streets = ['Main St', 'High St', 'Park Ave', 'Broadway', 'Elm St', 'Maple Dr', 'Oak Ln', 'Pine Rd'];
      var cities = ['New York', 'London', 'Tokyo', 'Paris', 'Berlin', 'Sydney', 'Toronto', 'Dubai'];
      var countries = ['USA', 'UK', 'Japan', 'France', 'Germany', 'Australia', 'Canada', 'UAE'];
      
      var generateField = function(schemaItem) {
        var type = schemaItem.type;
        switch (type) {
          case 'UUID': return randUUID();
          case 'Name': return firstNames[randInt(0,9)];
          case 'Surname': return lastNames[randInt(0,9)];
          case 'FullName': return firstNames[randInt(0,9)] + ' ' + lastNames[randInt(0,9)];
          case 'Email': return firstNames[randInt(0,9)].toLowerCase() + '.' + lastNames[randInt(0,9)].toLowerCase() + randInt(1,999) + '@example.com';
          case 'Number': return randInt(1, 10000);
          case 'Integer': return randInt(-10000, 10000);
          case 'Positive value': return randInt(1, 100000);
          case 'Negative value': return randInt(-100000, -1);
          case 'Decimal': return (Math.random() * 10000).toFixed(2);
          case 'Boolean': return Math.random() > 0.5;
          case 'Date': return randDate();
          case 'String': return randString(10);
          case 'Address': return randInt(1, 9999) + ' ' + streets[randInt(0, 7)] + ', ' + cities[randInt(0, 7)];
          case 'City': return cities[randInt(0, 7)];
          case 'Country': return countries[randInt(0, 7)];
          case 'Phone': return '+1-' + randInt(100, 999) + '-' + randInt(100, 999) + '-' + randInt(1000, 9999);
          case 'Company': return companies[randInt(0, 7)];
          case 'IP Address': return randInt(1, 255) + '.' + randInt(0, 255) + '.' + randInt(0, 255) + '.' + randInt(0, 255);
          case 'Constant': return schemaItem.constantValue || '';
          default: return 'mock';
        }
      };

      try {
        var chunkSize = 5000;
        var start = 0;
        
        if (format === 'csv') {
          var headers = schema.map(function(s) { return s.name; }).join(',');
          result += headers + '\n';
        } else if (format === 'json') {
          result += '[\n';
        } else if (format === 'xml') {
          result += '<?xml version="1.0" encoding="UTF-8"?>\n<Data>\n';
        }

        function processNextChunk() {
          var end = Math.min(start + chunkSize, count);
          
          for (var i = start; i < end; i++) {
            if (format === 'csv') {
              var row = schema.map(function(s) {
                var val = generateField(s);
                if (typeof val === 'string' && val.indexOf(',') !== -1) val = '"' + val + '"';
                return val;
              }).join(',');
              result += row + '\n';
            } else if (format === 'json') {
              var obj = {};
              schema.forEach(function(s) { obj[s.name] = generateField(s); });
              result += '  ' + JSON.stringify(obj) + (i < count - 1 ? ',\n' : '\n');
            } else if (format === 'xml') {
              var xmlRow = '  <Record>\n';
              schema.forEach(function(s) {
                var val = generateField(s);
                if (typeof val === 'string') val = val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                var safeName = s.name.replace(/[^a-zA-Z0-9_]/g, '');
                if (!safeName) safeName = 'Field';
                xmlRow += '    <' + safeName + '>' + val + '</' + safeName + '>\n';
              });
              xmlRow += '  </Record>\n';
              result += xmlRow;
            }
          }
          
          start = end;
          
          if (start < count) {
            var pct = Math.round((start / count) * 100);
            self.postMessage({
              type: 'progress',
              progress: pct,
              phase: 'Generating data... ' + pct + '%'
            });
            setTimeout(processNextChunk, 0);
          } else {
            if (format === 'json') {
              result += ']';
            } else if (format === 'xml') {
              result += '</Data>';
            }
            self.postMessage({ type: 'progress', progress: 100, phase: 'Finalizing...' });
            setTimeout(function() {
              self.postMessage({ type: 'complete', result: result });
            }, 0);
          }
        }
        
        processNextChunk();
      } catch (err) {
        self.postMessage({ type: 'error', error: err.message });
      }
    };
  }

  try {
    const code = '(' + workerLogic.toString() + ')();';
    const blob = new Blob([code], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    dfWorker = new Worker(workerUrl);
  } catch (err) {
    hideLoader();
    alert('Failed to create Web Worker: ' + err.message);
    dfResetState();
    return;
  }
  
  dfWorker.onmessage = function(msg) {
    const data = msg.data;
    if (data.type === 'error') {
      hideLoader();
      alert('Error generating data: ' + data.error);
      dfResetState();
    } else if (data.type === 'complete') {
      hideLoader();
      setTimeout(() => {
        downloadText(data.result, 'mock-data.' + format);
        dfResetState();
      }, 100);
    } else if (data.type === 'progress') {
      showLoader(data.phase || ('Generating data... ' + data.progress + '%'));
    }
  };
  
  dfWorker.onerror = function(err) {
    hideLoader();
    alert('Worker error: ' + (err.message || ''));
    dfResetState();
  };
  
  dfWorker.postMessage({ schema: dfSchema, count, format });
}

function dfResetState() {
  document.getElementById('df-generate-btn').disabled = false;
  hideLoader();
  if (dfWorker) {
    dfWorker.terminate();
    dfWorker = null;
  }
}

window.dfPreview = dfPreview;
function dfPreview() {
  const format = document.getElementById('df-format')?.value || 'json';
  const previewArea = document.getElementById('df-preview-area');
  if (!previewArea) return;
  if (dfSchema.length === 0) {
    previewArea.innerText = 'Schema is empty';
    return;
  }
  
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randString = (len) => Math.random().toString(36).substring(2, len + 2);
  const randDate = () => new Date(Date.now() - randInt(0, 10000000000)).toISOString();
  const randUUID = () => (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { let r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
  const firstNames = ['John','Jane','Alice','Bob','Charlie','Eve','David','Sarah','Michael','Emma'];
  const lastNames = ['Smith','Doe','Johnson','Brown','Williams','Jones','Garcia','Miller','Davis','Rodriguez'];
  const companies = ['Acme Corp', 'Globex', 'Soylent', 'Initech', 'Umbrella Corp', 'Massive Dynamic', 'Stark Industries', 'Wayne Enterprises'];
  const streets = ['Main St', 'High St', 'Park Ave', 'Broadway', 'Elm St', 'Maple Dr', 'Oak Ln', 'Pine Rd'];
  const cities = ['New York', 'London', 'Tokyo', 'Paris', 'Berlin', 'Sydney', 'Toronto', 'Dubai'];
  const countries = ['USA', 'UK', 'Japan', 'France', 'Germany', 'Australia', 'Canada', 'UAE'];
  
  const generateField = (schemaItem) => {
    switch (schemaItem.type) {
      case 'UUID': return randUUID();
      case 'Name': return firstNames[randInt(0,9)];
      case 'Surname': return lastNames[randInt(0,9)];
      case 'FullName': return firstNames[randInt(0,9)] + ' ' + lastNames[randInt(0,9)];
      case 'Email': return firstNames[randInt(0,9)].toLowerCase() + '.' + lastNames[randInt(0,9)].toLowerCase() + randInt(1,999) + '@example.com';
      case 'Number': return randInt(1, 10000);
      case 'Integer': return randInt(-10000, 10000);
      case 'Positive value': return randInt(1, 100000);
      case 'Negative value': return randInt(-100000, -1);
      case 'Decimal': return (Math.random() * 10000).toFixed(2);
      case 'Boolean': return Math.random() > 0.5;
      case 'Date': return randDate();
      case 'String': return randString(10);
      case 'Address': return randInt(1, 9999) + ' ' + streets[randInt(0, 7)] + ', ' + cities[randInt(0, 7)];
      case 'City': return cities[randInt(0, 7)];
      case 'Country': return countries[randInt(0, 7)];
      case 'Phone': return '+1-' + randInt(100, 999) + '-' + randInt(100, 999) + '-' + randInt(1000, 9999);
      case 'Company': return companies[randInt(0, 7)];
      case 'IP Address': return randInt(1, 255) + '.' + randInt(0, 255) + '.' + randInt(0, 255) + '.' + randInt(0, 255);
      case 'Constant': return schemaItem.constantValue || '';
      default: return 'mock';
    }
  };

  let result = '';
  const count = 3; // Preview 3 records
  
  if (format === 'csv') {
    result += dfSchema.map(s => s.name).join(',') + '\n';
    for (let i = 0; i < count; i++) {
      result += dfSchema.map(s => {
        let val = generateField(s);
        if (typeof val === 'string' && val.includes(',')) val = '"' + val + '"';
        return val;
      }).join(',') + '\n';
    }
  } else if (format === 'json') {
    result += '[\n';
    for (let i = 0; i < count; i++) {
      let obj = {};
      dfSchema.forEach(s => { obj[s.name] = generateField(s); });
      result += '  ' + JSON.stringify(obj) + (i < count - 1 ? ',\n' : '\n');
    }
    result += ']';
  } else if (format === 'xml') {
    result += '<?xml version="1.0" encoding="UTF-8"?>\n<Data>\n';
    for (let i = 0; i < count; i++) {
      result += '  <Record>\n';
      dfSchema.forEach(s => {
        let val = generateField(s);
        if (typeof val === 'string') val = val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let safeName = s.name.replace(/[^a-zA-Z0-9_]/g, '') || 'Field';
        result += '    <' + safeName + '>' + val + '</' + safeName + '>\n';
      });
      result += '  </Record>\n';
    }
    result += '</Data>';
  }
  
  previewArea.innerText = result;
}

// Initial render handled when panel opens or core init


// --- AUTO-GENERATED ESM EXPORTS ---
window.dfRenderSchema = dfRenderSchema;
window.dfUpdateSchema = dfUpdateSchema;
window.dfHandleDragStart = dfHandleDragStart;
window.dfHandleDragOver = dfHandleDragOver;
window.dfHandleDrop = dfHandleDrop;
window.dfHandleDragEnd = dfHandleDragEnd;
window.dfAddColumn = dfAddColumn;
window.dfRemoveColumn = dfRemoveColumn;
window.dfGenerate = dfGenerate;
window.dfResetState = dfResetState;
window.dfPreview = dfPreview;

export function init() {
  setTimeout(() => {
    document.getElementById('df-format')?.addEventListener('change', dfPreview);
    dfPreview();
  }, 100);
}
