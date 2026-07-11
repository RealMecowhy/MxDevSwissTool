# MxDev Swiss Tool

All-in-one developer toolkit for Mendix: log viewer, JSON formatter, XPath builder, JWT decoder, and many more tools. Works in any browser.

## How to run the application?

1. **Default (Recommended):**
   Double-click the `Start-MxDevSwissTool.bat` file. This will start the local bridge server and automatically open the tool interface in your browser.

2. **Alternative option (for blocked .bat files in corporate environments):**
   Often in corporate environments, running `.bat` files is blocked for security reasons. In this situation, use the command line:
   
   - Open a terminal (Command Prompt, PowerShell, or the terminal built into your IDE, e.g., VS Code) in this directory.
   - Enter the following command and press Enter:
     ```bash
     npm start
     ```
   - *If the above command does not work, use the direct call:*
     ```bash
     node server/mendix-observability-bridge.js
     ```
   - After the server starts, open a browser and go to: [http://localhost:9999/](http://localhost:9999/)

---

### Directory Architecture

- `public/` - Main application interface (HTML, CSS, and JS code for the browser).
- `server/` - Local server script (`mendix-observability-bridge.js`), used for integration with the Mendix application (e.g., tailing logs).
- `scripts/` - Various utility scripts for developers of this tool.
