import { readFile, writeFile } from 'node:fs/promises';
import { compareVersions, validateRelease } from '../desktop/release-utils.mjs';

const [version, ...notes] = process.argv.slice(2);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
validateRelease({ version, notes }, version);
if (compareVersions(version, pkg.version) <= 0) throw new Error('Choose a version newer than package.json.');
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
pkg.version = version; lock.version = version; lock.packages[''].version = version;
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
await writeFile('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
await writeFile('desktop/release.json', JSON.stringify({ version, notes }, null, 2) + '\n');
console.log(`Prepared v${version}. Commit the feature, version files and release.json together; pushing main builds, tests and publishes it.`);
