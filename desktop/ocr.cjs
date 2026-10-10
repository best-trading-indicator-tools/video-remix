const path = require('node:path');
const fs = require('node:fs/promises');
const { createWorker, PSM } = require('tesseract.js');
const cachePath = path.join(process.env.DATA_DIR || 'data', 'models', 'ocr');
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list-langs')) {
    const files = await fs.readdir(cachePath).catch(() => []);
    console.log(files.filter(name => name.endsWith('.traineddata')).map(name => name.replace('.traineddata', '')).join('\n')); return;
  }
  const download = args.includes('--download');
  const language = download ? ['eng', 'fra'] : args[args.indexOf('-l') + 1];
  if (!download && !['eng', 'fra'].includes(language)) throw new Error('Install the matching OCR language model.');
  await fs.mkdir(cachePath, { recursive: true });
  const worker = await createWorker(language, 1, { cachePath, logger: download ? message => console.error(message.status) : () => {} });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    if (download) console.log('Local caption detection is ready (English and French).');
    else { const result = await worker.recognize(args[0], {}, { tsv: true }); console.log(result.data.tsv); }
  } finally { await worker.terminate(); }
}
main().catch(() => { console.error('Local OCR failed. Open Local tools and reinstall caption detection.'); process.exitCode = 1; });
