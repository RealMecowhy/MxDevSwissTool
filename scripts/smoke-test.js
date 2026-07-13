const { spawn } = require('child_process');
const http = require('http');

console.log('Starting bridge server for smoke test...');
const server = spawn('node', ['server/mendix-observability-bridge.js']);

let serverOutput = '';
server.stdout.on('data', (data) => {
  serverOutput += data.toString();
});

server.stderr.on('data', (data) => {
  console.error('SERVER ERROR:', data.toString());
});

// Wait 2 seconds for server to start
setTimeout(() => {
  console.log('Sending request to /status...');
  http.get('http://127.0.0.1:9999/status', (res) => {
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
      try {
        const parsedData = JSON.parse(rawData);
        if (parsedData.status === 'online') {
          console.log('Smoke test passed successfully.');
          server.kill();
          process.exit(0);
        } else {
          console.error('Smoke test failed: Unexpected status response:', parsedData);
          server.kill();
          process.exit(1);
        }
      } catch (e) {
        console.error('Smoke test failed: Could not parse response:', rawData);
        server.kill();
        process.exit(1);
      }
    });
  }).on('error', (e) => {
    console.error('Smoke test failed: Request error:', e.message);
    server.kill();
    process.exit(1);
  });
}, 2000);

// Timeout test after 10 seconds
setTimeout(() => {
  console.error('Smoke test timed out.');
  server.kill();
  process.exit(1);
}, 10000);
