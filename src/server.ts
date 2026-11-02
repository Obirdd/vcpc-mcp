// Keep the original owned-test service isolated from the borrowed-browser service.
const mode = process.env.VCPC_BROWSER_MODE ?? 'owned-test';
if (mode === 'owned-test') await import('./owned-server.js');
else if (mode === 'existing-user') await import('./existing-server.js');
else throw new Error('invalid_browser_mode');
