const puppeteer = require('puppeteer');
const path = require('path');

async function run() {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  await page.setViewport({ width: 512, height: 512 });
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head><style>
      body { margin: 0; padding: 0; background-color: #3b82f6; display: flex; justify-content: center; align-items: center; height: 100vh; }
      svg { width: 380px; height: 380px; fill: none; stroke: #ffffff; stroke-linecap: round; stroke-linejoin: round; }
    </style></head>
    <body>
      <svg viewBox="0 0 24 24">
        <path d="M8 4C6.5 4 5.5 5 5.5 6.5V10C5.5 11.5 4 12 4 12C4 12 5.5 12.5 5.5 14V17.5C5.5 19 6.5 20 8 20" stroke-width="2"></path>
        <path d="M16 4C17.5 4 18.5 5 18.5 6.5V10C18.5 11.5 20 12 20 12C20 12 18.5 12.5 18.5 14V17.5C18.5 19 17.5 20 16 20" stroke-width="2"></path>
        <line x1="12" y1="7" x2="12" y2="17" stroke-width="4"></line>
        <line x1="7" y1="12" x2="17" y2="12" stroke-width="4"></line>
      </svg>
    </body>
    </html>
  `;
  
  await page.setContent(html);
  await page.screenshot({ path: path.join(__dirname, '../public/logo.png') });
  await browser.close();
  console.log('Logo generated successfully!');
}

run();
