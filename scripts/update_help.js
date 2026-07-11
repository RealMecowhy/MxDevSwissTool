const fs = require('fs');

const path = 'c:/Users/mikol/Documents/Antigravity_Projects/MendixTools/js/tools-help.js';
let content = fs.readFileSync(path, 'utf8');

// Replace the log-viewer part
const logViewerRegex = /'log-viewer':\s*\{[\s\S]*?\n\s*\},/;
const newLogViewerTabs = `'log-viewer-stream': {
    title: 'Mendix Log Viewer - Log Stream',
    description: 'Tool for rapid analysis, searching, and filtering of Mendix application logs. Instead of opening giant text files in a traditional notepad, you can load them here, filter loggers and error levels, and automatically group (aggregate) identical errors.',
    howToGet: \`
      <ul>
        <li><strong>Mendix Cloud:</strong> Log in to the Mendix Portal, go to <em>Environments</em> → select an environment (e.g., Production) → <em>Details</em> → <em>Logs</em> → click <em>Download Log File</em> or download archive logs.</li>
        <li><strong>Local Environment:</strong> In your Mendix project folder, logs are located at <code>[project_directory]/deployment/log/log.txt</code>.</li>
        <li><strong>Hybrid Environments (Docker):</strong> Download container logs using the command: <code>docker logs [container_name] > app_log.txt</code>.</li>
      </ul>
    \`,
    howToUse: \`
      <ol>
        <li>Drag and drop the log file (e.g., <code>.txt</code>, <code>.log</code>) directly into the browser window or paste raw log text into the input field.</li>
        <li>Use the filters in the sidebar: enter a phrase (e.g., Microflow name), select log level (DEBUG, INFO, WARNING, ERROR, CRITICAL) or filter by a specific logger name (e.g., <code>ConnectionBus</code>).</li>
        <li>Search for specific time intervals by moving the time slider or entering the time.</li>
        <li>Click <strong>Aggregate Errors</strong> in the top right corner of the module bar to open a modal with a summary of unique errors and their occurrence statistics (useful for locating error loops).</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>ConnectionBus errors:</strong> Usually indicate database problems, query timeouts, or attempts to write incomplete objects.</li>
        <li><strong>ActionManager errors:</strong> Indicate a failure in Microflow / Activity execution. Check the Microflow name provided in the log and navigate to it in Mendix Studio Pro.</li>
        <li><strong>Jetty / Connector errors:</strong> Suggest network issues, dropped client HTTP connections, or server response timeouts to a user request.</li>
      </ul>
    \`
  },
  'log-viewer-correlation': {
    title: 'Mendix Log Viewer - Correlation Flow',
    description: 'Visualizes the flow of requests and microflow executions based on correlation IDs in the logs, allowing you to trace a complete transaction across multiple log entries.',
    howToGet: 'Ensure your Mendix logs contain Correlation IDs. You can enable them by setting the <code>CorrelationId</code> logger to <code>TRACE</code> or <code>DEBUG</code> in your environment settings.',
    howToUse: \`
      <ol>
        <li>Switch to the <strong>Correlation Flow</strong> tab.</li>
        <li>Select a specific Correlation ID from the list to see all log entries related to that specific transaction.</li>
        <li>Follow the chronological flow to identify where a process failed or took too long.</li>
      </ol>
    \`,
    interpretation: 'Helps in debugging complex transactions that span multiple microflows and integrations by isolating only the logs relevant to a single user action.'
  },
  'log-viewer-sequence': {
    title: 'Mendix Log Viewer - Sequence Diagram',
    description: 'Generates a UML sequence diagram based on Mendix log entries, showing the interactions between different components (e.g., ActionManager, ConnectionBus, REST services).',
    howToGet: 'You need logs with sufficient detail, preferably <code>DEBUG</code> or <code>TRACE</code> for relevant loggers like <code>ActionManager</code> or <code>REST_Consume</code>.',
    howToUse: \`
      <ol>
        <li>Switch to the <strong>Sequence Diagram</strong> tab.</li>
        <li>Analyze the chronological sequence of events and calls between different system components.</li>
      </ol>
    \`,
    interpretation: 'Useful for understanding the architecture of an execution path and spotting unexpected loops or missing calls.'
  },
  'log-viewer-gantt': {
    title: 'Mendix Log Viewer - Gantt Chart',
    description: 'Provides a timeline view of long-running operations in your logs, helping you identify performance bottlenecks and parallel execution issues.',
    howToGet: 'Logs containing timestamps for start and end of operations, typically found in <code>TRACE</code> level logs for microflows or database queries.',
    howToUse: \`
      <ol>
        <li>Switch to the <strong>Gantt Chart</strong> tab.</li>
        <li>Look for long horizontal bars that represent slow operations.</li>
      </ol>
    \`,
    interpretation: 'A long bar indicates a slow operation. If multiple operations are executed sequentially but could run in parallel, the Gantt chart will clearly highlight this inefficiency.'
  },`;

content = content.replace(logViewerRegex, newLogViewerTabs);

const showActiveHelpRegex = /function showActiveToolHelp\(\) \{[\s\S]*?const helpData = TOOLS_HELP\[toolId\];/;
const newShowActiveHelp = `function showActiveToolHelp() {
  let toolId = typeof currentTool !== 'undefined' ? currentTool : 'home';
  if (toolId === 'home') return;

  if (toolId === 'log-viewer') {
    const activeTab = document.querySelector('#panel-log-viewer .tabs .tab.active');
    if (activeTab) {
      if (activeTab.innerText.includes('Stream')) toolId = 'log-viewer-stream';
      else if (activeTab.innerText.includes('Correlation')) toolId = 'log-viewer-correlation';
      else if (activeTab.innerText.includes('Sequence')) toolId = 'log-viewer-sequence';
      else if (activeTab.innerText.includes('Gantt')) toolId = 'log-viewer-gantt';
      else toolId = 'log-viewer-stream';
    } else {
      toolId = 'log-viewer-stream';
    }
  }

  const helpData = TOOLS_HELP[toolId];`;

content = content.replace(showActiveHelpRegex, newShowActiveHelp);

fs.writeFileSync(path, content, 'utf8');
console.log("Successfully updated tools-help.js");
