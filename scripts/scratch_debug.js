const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function extractDeploymentPath(cmdLine) {
  if (!cmdLine) return null;
  const matches = cmdLine.match(/["']?([^"']+\\deployment)["']?/i);
  if (matches && matches[1]) {
    return matches[1];
  }
  if (cmdLine.includes('runtimelauncher.jar')) {
    const parts = cmdLine.split('runtimelauncher.jar');
    if (parts.length > 1) {
      const pathPart = parts[1].trim();
      const pathMatch = pathPart.match(/^["']?([^"'\s]+)["']?/);
      if (pathMatch && pathMatch[1]) {
        return pathMatch[1];
      }
    }
  }
  return null;
}

function detectProject() {
  return new Promise((resolve) => {
    // Run PowerShell command to get javaw processes with command line
    const cmd = `powershell -Command "Get-CimInstance Win32_Process -Filter \\"name = 'javaw.exe'\\" | Select-Object -ExpandProperty CommandLine"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        return resolve({ success: false, reason: error.message });
      }
      
      const lines = stdout.split('\r\n').map(l => l.trim()).filter(l => l.length > 0);
      let deploymentPath = null;
      
      for (const line of lines) {
        if (line.includes('runtimelauncher.jar')) {
          deploymentPath = extractDeploymentPath(line);
          if (deploymentPath) break;
        }
      }
      
      if (!deploymentPath) {
        return resolve({ success: false, reason: "No running Mendix javaw process found." });
      }
      
      resolve({ success: true, deploymentPath });
    });
  });
}

async function run() {
  const result = await detectProject();
  console.log("DETECT RESULT:", result);
  if (result.success) {
    const depPath = result.deploymentPath;
    const metadataPath = path.join(depPath, 'model', 'metadata.json');
    const configPath = path.join(depPath, 'model', 'config.json');
    
    console.log("metadataPath exists:", fs.existsSync(metadataPath));
    console.log("configPath exists:", fs.existsSync(configPath));
    
    if (fs.existsSync(metadataPath)) {
      const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      console.log("METADATA NAME:", meta.ProjectName);
      console.log("METADATA ROLES:", Object.values(meta.Roles || {}).map(r => r.Name));
    }
    
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log("CONFIG DB:", config.Configuration.DatabaseType, config.Configuration.DatabaseName);
    }
  }
}

run();
