import { appendFile, writeFile } from 'node:fs/promises';
import { inspect } from './sign.mjs';
import { createHash } from 'node:crypto';
const {files} = await inspect(process.argv[2], process.env.RELEASE_VERSION);
const lines = Object.entries(files).map(([name, value]) => `| ${name} | ${value.size} | ${value.sha256} |`);
await appendFile(process.env.GITHUB_STEP_SUMMARY, '\n| 파일 | 바이트 | SHA-256 |\n|---|---:|---|\n' + lines.join('\n') + '\n');
await writeFile(process.argv[3], JSON.stringify(files));
await appendFile(process.env.GITHUB_OUTPUT, `files_sha256=${createHash('sha256').update(JSON.stringify(files)).digest('hex')}\n`);
