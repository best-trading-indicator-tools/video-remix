// Use the browser revision expected by the bundled renderers, in this app's cache.
process.env.PUPPETEER_SKIP_DOWNLOAD = 'false';
process.env.PUPPETEER_CHROME_SKIP_DOWNLOAD = 'false';
process.env.PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_FIREFOX_SKIP_DOWNLOAD = 'true';
const { downloadBrowsers } = await import('puppeteer/internal/node/install.js');
await downloadBrowsers();
const { executablePath } = await import('puppeteer');
const { access } = await import('node:fs/promises');
await access(await executablePath());
console.log('Animated card renderer is ready.');
