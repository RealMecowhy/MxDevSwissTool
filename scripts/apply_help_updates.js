const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'js', 'tools-help.js');
let content = fs.readFileSync(filePath, 'utf8');

// Helper function to safely replace text
function safeReplace(searchStr, replacementStr) {
  if (content.indexOf(searchStr) === -1) {
    console.error("COULD NOT FIND:\n", searchStr.substring(0, 50) + "...");
  } else {
    content = content.replace(searchStr, replacementStr);
  }
}

// 1. Add log-anonymizer and password-generator
const timestampRegex = /'timestamp':\s*\{[\s\S]*?\n\s*\}/;
const timestampMatch = content.match(timestampRegex);
if (timestampMatch) {
  const replacement = timestampMatch[0] + `,
  'log-anonymizer': {
    title: 'Log Anonymizer',
    description: 'Anonymizes sensitive data from Mendix logs before sharing them with external support or community forums.',
    howToGet: 'Simply paste your Mendix log file content or drag and drop the log file into the tool.',
    howToUse: \`
      <ol>
        <li>Select the types of data you want to anonymize (UUIDs, IP addresses, Emails, Mendix IDs).</li>
        <li>You can also provide custom keywords (e.g., your company name or secret project names) to be redacted.</li>
        <li>Click Run or enable Auto-run to see the cleaned logs instantly.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> Never share raw logs publicly! Mendix logs often contain email addresses of users who encountered errors, or IP addresses of your internal servers. Always run them through this tool first.</li>
        <li><strong>Custom Keywords:</strong> Use this to hide proprietary table names or module names that might reveal your business logic.</li>
      </ul>
    \`
  },
  'password-generator': {
    title: 'Password Generator',
    description: 'Generates secure, complex passwords for database accounts, API keys, or MxAdmin credentials.',
    howToGet: 'Works locally in your browser. No input data required.',
    howToUse: \`
      <ol>
        <li>Adjust the password length (default is usually secure enough for most systems).</li>
        <li>Toggle options for Uppercase, Lowercase, Numbers, and Symbols depending on the target system\\'s requirements.</li>
        <li>Click Generate and copy the result.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>Mendix Cloud:</strong> When setting up a new environment, use this to generate a 32+ character password for MxAdmin.</li>
        <li><strong>Database integrations:</strong> Some legacy databases have restrictions on certain symbols. You can disable symbols if your connection string fails.</li>
      </ul>
    \`
  }`;
  content = content.replace(timestampRegex, replacement);
} else {
  console.error("Could not find 'timestamp' entry to append new tools.");
}

// 2. Enhance existing helps with interpretations

// log-viewer-correlation
safeReplace(
  `interpretation: 'Helps in debugging complex transactions that span multiple microflows and integrations by isolating only the logs relevant to a single user action.'`,
  `interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> If a user reports an error, ask them for the time it happened. Find the error in the Log Stream, copy its Correlation ID, and paste it here. You will see everything that happened during that exact button click!</li>
        <li><strong>Complex transactions:</strong> Helps in debugging transactions that span multiple microflows and integrations by isolating only the logs relevant to a single user action.</li>
      </ul>
    \``
);

// log-viewer-sequence
safeReplace(
  `interpretation: 'Useful for understanding the architecture of an execution path and spotting unexpected loops or missing calls.'`,
  `interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> A visual way to see "what calls what". If your app hangs, check the sequence diagram to see where the last call stopped.</li>
        <li><strong>Architecture:</strong> Useful for spotting unexpected loops (e.g., a microflow calling itself recursively) or missing API calls.</li>
      </ul>
    \``
);

// log-viewer-gantt
safeReplace(
  `howToUse: \`
      <ol>
        <li>Switch to the <strong>Gantt Chart</strong> tab.</li>
        <li>Look for long horizontal bars that represent slow operations.</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Switch to the <strong>Gantt Chart</strong> tab.</li>
        <li>Look for long horizontal bars that represent slow operations.</li>
        <li>Zoom in to inspect parallel vs sequential executions.</li>
      </ol>
    \``
);
safeReplace(
  `interpretation: 'A long bar indicates a slow operation. If multiple operations are executed sequentially but could run in parallel, the Gantt chart will clearly highlight this inefficiency.'`,
  `interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> Think of this as a race track. The longest bar is the slowest runner (bottleneck). Fix that one first to speed up your app.</li>
        <li><strong>Parallelization:</strong> If you see many operations executed sequentially (stairs-like pattern), consider using parallel execution in your Mendix microflows or batching database queries.</li>
      </ul>
    \``
);

// http-status
safeReplace(
  `howToUse: \`
      <ol>
        <li>Select a group of codes (e.g., 4xx for client errors, 5xx for server errors).</li>
        <li>Click on the code you are interested in (e.g., <code>401 Unauthorized</code> or <code>504 Gateway Timeout</code>).</li>
        <li>Read the description and developer advice regarding the configuration of the <em>Call REST</em> action in Mendix Studio Pro.</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Select a group of codes (e.g., 4xx for client errors, 5xx for server errors).</li>
        <li>Click on the code you are interested in (e.g., <code>401 Unauthorized</code> or <code>504 Gateway Timeout</code>).</li>
        <li>Read the description and developer advice regarding the configuration of the <em>Call REST</em> action in Mendix Studio Pro.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> 4xx means YOU (your Mendix app) made a mistake in the request. 5xx means the TARGET SERVER crashed or failed.</li>
        <li><strong>Integration tip:</strong> Always add error handling for 5xx codes in Mendix to prevent the whole microflow from failing gracefully.</li>
      </ul>
    \``
);

// json-formatter
safeReplace(
  `howToUse: \`
      <ol>
        <li>Paste unformatted or minified JSON text into the left text field.</li>
        <li>Formatting happens automatically upon data entry (you can also click the <em>Format</em> button). In case of syntax errors, the parser will indicate the exact line and cause of the problem.</li>
        <li>Use the interactive tree view on the right side to collapse and expand deeply nested objects or search for keys.</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Paste unformatted or minified JSON text into the left text field.</li>
        <li>Formatting happens automatically upon data entry (you can also click the <em>Format</em> button). In case of syntax errors, the parser will indicate the exact line and cause of the problem.</li>
        <li>Use the interactive tree view on the right side to collapse and expand deeply nested objects or search for keys.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> Use this to create JSON snippets for Mendix Import/Export mappings. It helps visualize complex data structures.</li>
        <li><strong>Troubleshooting:</strong> If a REST call fails with a parsing error, paste the payload here. The validator will point exactly to the missing comma or bracket.</li>
      </ul>
    \``
);

// xml-formatter
safeReplace(
  `howToUse: \`
      <ol>
        <li>Paste raw XML code into the input field.</li>
        <li>Click <strong>Format XML</strong>. The tool will arrange tags with proper indentation and check if the document is well-formed.</li>
        <li>You can explore the tag tree and copy the formatted XML code with one click.</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Paste raw XML code into the input field.</li>
        <li>Click <strong>Format XML</strong>. The tool will arrange tags with proper indentation and check if the document is well-formed.</li>
        <li>You can explore the tag tree and copy the formatted XML code with one click.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> XML is very strict. A missing closing tag breaks everything. Use this to find structural errors in SOAP responses.</li>
        <li><strong>Mendix Namespaces:</strong> Watch out for namespaces (e.g., <code>xmlns:xsi</code>). They often cause issues during Mendix XML import mappings if not defined correctly.</li>
      </ul>
    \``
);

// sql-formatter
safeReplace(
  `howToUse: \`
      <ol>
        <li>Paste a raw, one-line compressed SQL query into the text field.</li>
        <li>Click the <strong>Format SQL</strong> button. Keywords such as SELECT, FROM, JOIN, WHERE will be moved to new lines and bolded.</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Paste a raw, one-line compressed SQL query into the text field.</li>
        <li>Click the <strong>Format SQL</strong> button. Keywords such as SELECT, FROM, JOIN, WHERE will be moved to new lines and bolded.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> Mendix generates very long, unreadable SQL queries under the hood. Formatting them here helps you see exactly which database tables are being joined.</li>
        <li><strong>Debugging:</strong> If an OQL query fails or is slow, inspect the generated SQL to check if it's hitting the expected indexes.</li>
      </ul>
    \``
);

// text-diff
safeReplace(
  `howToGet: 'Prepare two versions of a text file or code that you want to compare.',`,
  `howToGet: 'Copy the original payload/configuration and the new version you want to compare against.',`
);
safeReplace(
  `howToUse: \`
      <ol>
        <li>Paste the original version of the text into the <strong>Original Text (Left)</strong> field.</li>
        <li>Paste the new (modified) version of the text into the <strong>Modified Text (Right)</strong> field.</li>
        <li>Differences will be generated automatically and marked with colors: red (deleted) and green (added).</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Paste the original version of the text into the <strong>Original Text (Left)</strong> field.</li>
        <li>Paste the new (modified) version of the text into the <strong>Modified Text (Right)</strong> field.</li>
        <li>Differences will be generated automatically and marked with colors: red (deleted) and green (added).</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> If an integration worked yesterday but fails today, compare the JSON responses from both days to instantly spot what field changed.</li>
        <li><strong>Configuration sync:</strong> Use this to compare <code>yaml</code> configs between test and production environments to find missing variables.</li>
      </ul>
    \``
);

// encoder
safeReplace(
  `howToGet: 'Any text that requires encoding, or an encoded string obtained e.g., from an HTTP header <code>Authorization: Basic [Base64]</code>.',`,
  `howToGet: 'Obtain Base64 strings from API headers (like Basic Auth) or URL parameters that need decoding.',`
);
safeReplace(
  `howToUse: \`
      <ol>
        <li>Type or paste text into a chosen input field (Plain Text, Base64, or URL Encoded).</li>
        <li>The tool will automatically recalculate values in all other fields in real-time.</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Type or paste text into a chosen input field (Plain Text, Base64, or URL Encoded).</li>
        <li>The tool will automatically recalculate values in all other fields in real-time.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> URLs cannot contain spaces or special characters. If your REST API call fails because of a space in the query parameter, use URL Encoding.</li>
        <li><strong>Basic Authentication:</strong> It is just Base64 of <code>username:password</code>. You can easily generate or decode it here.</li>
      </ul>
    \``
);

// xpath-builder
safeReplace(
  `howToUse: \`
      <ol>
        <li>Paste your XPath query into the editor window.</li>
        <li>Click <strong>Format</strong>. A complex, multi-line query with multiple logical operators will be formatted into a readable indentation tree.</li>
        <li>Use the <strong>XPath Cheat Sheet</strong> section at the bottom of the screen to quickly copy special Mendix platform variables like <code>[%CurrentUser%]</code> or <code>[reversed()]</code> operators for associations.</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Paste your XPath query into the editor window.</li>
        <li>Click <strong>Format</strong>. A complex, multi-line query with multiple logical operators will be formatted into a readable indentation tree.</li>
        <li>Use the <strong>XPath Cheat Sheet</strong> section at the bottom of the screen to quickly copy special Mendix platform variables like <code>[%CurrentUser%]</code> or <code>[reversed()]</code> operators for associations.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> Avoid using <code>contains()</code> or <code>or</code> in your XPath if possible, as they usually cause database performance issues (table scans).</li>
        <li><strong>Deep paths:</strong> Be careful with long XPath associations (e.g. <code>/Module.Entity1/Module.Entity2/Module.Entity3</code>). They translate to multiple SQL JOINs and can slow down your app significantly.</li>
      </ul>
    \``
);

// md-preview
safeReplace(
  `howToGet: 'Manually created developer project documentation (e.g., Readme files, release notes descriptions).',`,
  `howToGet: 'Paste existing documentation or start writing from scratch in the editor.',`
);
safeReplace(
  `howToUse: \`
      <ol>
        <li>Type text in Markdown format in the left editor panel. On the right side, you will instantly see the rendered preview of the document.</li>
        <li><strong>Table Generator:</strong> Enter the number of rows and columns in the helper form, fill in headers and cells, and the tool will output ready Markdown table code that you can paste into your <code>.md</code> file.</li>
        <li>You can copy the resulting HTML code of the rendered document using the <em>Copy HTML</em> button.</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Type text in Markdown format in the left editor panel. On the right side, you will instantly see the rendered preview of the document.</li>
        <li><strong>Table Generator:</strong> Enter the number of rows and columns in the helper form, fill in headers and cells, and the tool will output ready Markdown table code that you can paste into your <code>.md</code> file.</li>
        <li>You can copy the resulting HTML code of the rendered document using the <em>Copy HTML</em> button.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> Markdown is the standard way developers write documentation. Use this to format text easily without needing Word.</li>
        <li><strong>Tables:</strong> Generating markdown tables manually is painful. Use the generator to create structured release notes quickly!</li>
      </ul>
    \``
);

// query-intelligence-formatter
safeReplace(
  `howToUse: \`
      <ol>
        <li>Paste your raw OQL query into the input field.</li>
        <li>Click <strong>Format</strong> or type/edit the query. It will be formatted and syntax-highlighted automatically.</li>
        <li>Click <strong>Copy</strong> to copy the clean, formatted OQL query back to your clipboard.</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Paste your raw OQL query into the input field.</li>
        <li>Click <strong>Format</strong> or type/edit the query. It will be formatted and syntax-highlighted automatically.</li>
        <li>Click <strong>Copy</strong> to copy the clean, formatted OQL query back to your clipboard.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> OQL is Mendix\\'s version of SQL. Formatting helps you understand what data is being fetched and joined.</li>
        <li><strong>Optimization:</strong> Formatting the query visually exposes missing WHERE clauses that could lead to large data retrievals.</li>
      </ul>
    \``
);

// query-intelligence-translator
safeReplace(
  `howToUse: \`
      <ol>
        <li>Select the translation direction using the dropdown: <strong>OQL &rarr; SQL (Postgres)</strong> or <strong>SQL &rarr; OQL</strong>.</li>
        <li>Paste the source query into the input field. The translation will happen automatically.</li>
        <li>Copy the translated query from the output field.</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Select the translation direction using the dropdown: <strong>OQL &rarr; SQL (Postgres)</strong> or <strong>SQL &rarr; OQL</strong>.</li>
        <li>Paste the source query into the input field. The translation will happen automatically.</li>
        <li>Copy the translated query from the output field.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> Helps bridge the gap between database admin tools (SQL) and Mendix logic (OQL).</li>
        <li><strong>Migration:</strong> Essential when migrating pure SQL queries into Mendix OQL reporting datasets.</li>
      </ul>
    \``
);

// odata-builder
safeReplace(
  `howToUse: \`
      <ol>
        <li>Enter the service base URL and the resource name (Entity Set).</li>
        <li>Add filters in the builder (e.g., <code>Age gt 18</code>, <code>Status eq 'Active'</code>), select fields to retrieve ($select) and sort order ($orderby).</li>
        <li>The tool will generate a full, correctly encoded query URL that you can paste into a browser, Postman, or integration configuration in Mendix.</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Enter the service base URL and the resource name (Entity Set).</li>
        <li>Add filters in the builder (e.g., <code>Age gt 18</code>, <code>Status eq 'Active'</code>), select fields to retrieve ($select) and sort order ($orderby).</li>
        <li>The tool will generate a full, correctly encoded query URL that you can paste into a browser, Postman, or integration configuration in Mendix.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> OData query syntax is tricky (e.g. using <code>eq</code> instead of <code>=</code>). Use this builder to avoid frustrating syntax errors.</li>
        <li><strong>Performance:</strong> Always use <code>$select</code> to only fetch the columns you need, and <code>$top</code> to limit results, preventing server overload.</li>
      </ul>
    \``
);

// hash-gen
safeReplace(
  `howToGet: 'Any text string you want to hash.',`,
  `howToGet: 'Type the text string, or provide a file if you need to verify its integrity.',`
);
safeReplace(
  `howToUse: \`
      <ol>
        <li>Enter text in the input field.</li>
        <li>Hashes for all available cryptographic algorithms will be generated and displayed automatically below.</li>
      </ol>
    \``,
  `howToUse: \`
      <ol>
        <li>Enter text in the input field.</li>
        <li>Hashes for all available cryptographic algorithms will be generated and displayed automatically below.</li>
      </ol>
    \`,
    interpretation: \`
      <ul>
        <li><strong>For beginners:</strong> Hashing is a one-way street. It turns any text into a fixed-length string. If even one letter changes, the hash changes completely. Useful for verifying file integrity.</li>
        <li><strong>Security:</strong> MD5 and SHA-1 are considered broken for security purposes. Always use SHA-256 or SHA-512 for hashing sensitive data like passwords or tokens.</li>
      </ul>
    \``
);

fs.writeFileSync(filePath, content, 'utf8');
console.log("Help update complete!");
