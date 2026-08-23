const path = require('path');

// In a packaged Electron app the project directory lives inside a read-only
// app.asar archive, so data/config/uploads must live under the OS's per-user
// app-data directory instead. YAA_DATA_DIR lets any deployment override this
// explicitly (e.g. a VPS or container).
function root() {
  if (process.env.YAA_DATA_DIR) return process.env.YAA_DATA_DIR;

  try {
    const { app } = require('electron');
    if (app?.getPath) return app.getPath('userData');
  } catch (_error) {
    // Not running inside Electron
  }

  return path.join(__dirname, '..');
}

const ROOT = root();

module.exports = {
  ROOT,
  dataDir: path.join(ROOT, 'data'),
  configDir: path.join(ROOT, 'config'),
  uploadsDir: path.join(ROOT, 'uploads'),
  logsDir: path.join(ROOT, 'logs'),
  dbPath: process.env.YAA_DB_PATH || path.join(ROOT, 'data', 'youtube_automation.db')
};
