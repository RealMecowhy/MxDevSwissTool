/**
 * Virtual Text Viewer Component
 * Renders massive text strings (tens of MBs) using virtual scrolling to prevent browser freezing.
 */
class VirtualTextViewer {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    if (!this.container) throw new Error(`Container #${containerId} not found`);
    
    this.container.classList.add('virtual-viewer-host');
    this.container.tabIndex = 0; // Make focusable to capture paste events
    
    this.lineHeight = options.lineHeight || 20;
    this.fontFamily = options.fontFamily || 'var(--font-mono, monospace)';
    this.fontSize = options.fontSize || '0.75rem';
    this.padding = options.padding || 12;
    this.textColor = options.textColor || 'var(--text-primary)';
    this.bgColor = options.bgColor || 'transparent';
    this.placeholderText = options.placeholder || '';
    
    this.text = '';
    this.lineOffsets = new Uint32Array(0);
    this.lineCount = 0;
    this.isRendering = false;
    
    this.initDOM();
    this.bindEvents();
    
    if (this.placeholderText) {
      this.showPlaceholder();
    }
  }
  
  initDOM() {
    this.container.style.position = 'relative';
    this.container.style.overflow = 'auto';
    this.container.style.backgroundColor = this.bgColor;
    this.container.style.outline = 'none';
    
    // The spacer forces the container to have the total scrollable height
    this.spacer = document.createElement('div');
    this.spacer.className = 'virtual-viewer-spacer';
    this.spacer.style.width = '1px';
    this.spacer.style.position = 'absolute';
    this.spacer.style.top = '0';
    this.spacer.style.left = '0';
    
    // The content div holds the currently visible lines
    this.content = document.createElement('div');
    this.content.className = 'virtual-viewer-content';
    this.content.style.position = 'absolute';
    this.content.style.top = '0';
    this.content.style.left = '0';
    this.content.style.minWidth = '100%';
    this.content.style.fontFamily = this.fontFamily;
    this.content.style.fontSize = this.fontSize;
    this.content.style.color = this.textColor;
    this.content.style.whiteSpace = 'pre';
    this.content.style.padding = `${this.padding}px`;
    this.content.style.boxSizing = 'border-box';
    this.content.style.pointerEvents = 'auto';
    
    this.container.appendChild(this.spacer);
    this.container.appendChild(this.content);
  }
  
  bindEvents() {
    this.container.addEventListener('scroll', () => {
      if (!this.isRendering) {
        this.isRendering = true;
        window.requestAnimationFrame(() => {
          this.render();
          this.isRendering = false;
        });
      }
    });
    
    this.container.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (this.onPaste) {
        this.onPaste(text);
      } else {
        this.setText(text);
      }
    });
  }
  
  showPlaceholder() {
    this.content.innerHTML = `<span style="color:var(--text-muted)">${this.placeholderText}</span>`;
  }
  
  setText(text) {
    this.text = text;
    if (!text) {
      this.lineCount = 0;
      this.spacer.style.height = '0px';
      this.showPlaceholder();
      return;
    }
    
    this.computeOffsets();
    this.spacer.style.height = `${this.lineCount * this.lineHeight + this.padding * 2}px`;
    this.render();
  }
  
  getText() {
    return this.text.replace(/\x01|\x02/g, '');
  }
  
  computeOffsets() {
    // 1. Count newlines to allocate exact array size
    let count = 1;
    for (let i = 0; i < this.text.length; i++) {
      if (this.text.charCodeAt(i) === 10) count++;
    }
    
    this.lineCount = count;
    this.lineOffsets = new Uint32Array(count + 1);
    
    // 2. Populate offsets
    let lineIdx = 0;
    this.lineOffsets[lineIdx++] = 0;
    for (let i = 0; i < this.text.length; i++) {
      if (this.text.charCodeAt(i) === 10) {
        this.lineOffsets[lineIdx++] = i + 1;
      }
    }
    this.lineOffsets[lineIdx] = this.text.length + 1; // End boundary marker
  }
  
  render() {
    if (!this.lineCount) return;
    
    const scrollTop = this.container.scrollTop;
    const clientHeight = this.container.clientHeight;
    
    // Calculate visible range
    const startNode = Math.floor(Math.max(0, scrollTop - this.padding) / this.lineHeight);
    const visibleNodesCount = Math.ceil(clientHeight / this.lineHeight);
    
    // Add buffer above and below to prevent flicker during fast scrolling
    const buffer = 15;
    const start = Math.max(0, startNode - buffer);
    const end = Math.min(this.lineCount - 1, startNode + visibleNodesCount + buffer);
    
    // Shift content container down to match scroll position visually
    const offsetY = start * this.lineHeight + this.padding;
    this.content.style.transform = `translateY(${offsetY}px)`;
    
    // Build HTML for visible lines
    let html = '';
    for (let i = start; i <= end; i++) {
      const startIdx = this.lineOffsets[i];
      let endIdx = this.lineOffsets[i + 1] - 1; // Exclude newline
      if (endIdx < startIdx) endIdx = startIdx; // Handle empty lines
      
      const lineText = this.text.substring(startIdx, endIdx);
      
      // Escape HTML
      let escaped = lineText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
        
      escaped = escaped.replace(/\x01/g, '<mark class="anonymizer-highlight">').replace(/\x02/g, '</mark>');
        
      html += `<div style="height:${this.lineHeight}px; line-height:${this.lineHeight}px;">${escaped || ' '}</div>`;
    }
    
    this.content.innerHTML = html;
  }
}

window.VirtualTextViewer = VirtualTextViewer;
export function init() {}
