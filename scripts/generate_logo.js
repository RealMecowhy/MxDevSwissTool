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
        <path d="M5 4C3.5 4 2.5 5 2.5 6.5V10C2.5 11.5 1 12 1 12C1 12 2.5 12.5 2.5 14V17.5C2.5 19 3.5 20 5 20" stroke-width="2"></path>
        <path d="M19 4C20.5 4 21.5 5 21.5 6.5V10C21.5 11.5 23 12 23 12C23 12 21.5 12.5 21.5 14V17.5C21.5 19 20.5 20 19 20" stroke-width="2"></path>
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
