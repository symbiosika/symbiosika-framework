const fs = require('fs');

const FILE = 'src/lib/jobs/index.ts';
const JOB_SCHEMA_FILE = 'src/lib/db/schema/jobs.ts';
const OUTPUT = 'docs/README_Jobs_API.md';

const DESCRIPTIONS = {
  defineJob: 'Register a job handler.',
  startJobQueue: 'Start the job queue polling loop.',
  getJob: 'Retrieve a job by id.',
  getJobsByOrganisation: 'List jobs for an organisation.',
  createJob: 'Create a new job.',
  updateJobProgress: 'Update progress information of a job.',
  cancelJob: 'Cancel a pending or running job.'
};

function collectInterfaces(content, interfaces) {
  let m;
  const regexInterfaceExport = /^export\s+interface\s+(\w+)\s*{[^}]*}/gm;
  while ((m = regexInterfaceExport.exec(content))) {
    interfaces[m[1]] = m[0].trim();
  }
  const regexInterface = /^interface\s+(\w+)\s*{[^}]*}/gm;
  while ((m = regexInterface.exec(content))) {
    interfaces[m[1]] = m[0].trim();
  }
  const regexType = /^export\s+type\s+(\w+)\s*=\s*[^;]+;/gm;
  while ((m = regexType.exec(content))) {
    interfaces[m[1]] = m[0].trim();
  }
}

const interfaces = {};
collectInterfaces(fs.readFileSync(FILE, 'utf8'), interfaces);
collectInterfaces(fs.readFileSync(JOB_SCHEMA_FILE, 'utf8'), interfaces);

const file = fs.readFileSync(FILE, 'utf8');
const funcRegex = /^export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm;
const functions = [];
let m;
while ((m = funcRegex.exec(file))) {
  const name = m[1];
  const params = m[2]
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);
  const async = m[0].includes('async');
  functions.push({ name, params, async });
}

let md = '# Job Service API\n\n';
md += '(This file is generated automatically by a GitHub action)\n\n';

for (const fn of functions) {
  md += `## ${fn.name}\n`;
  if (DESCRIPTIONS[fn.name]) md += DESCRIPTIONS[fn.name] + '\n\n';
  const paramStr = fn.params.join(', ');
  md += '```typescript\n';
  md += `function ${fn.name}(${paramStr}): ${fn.async ? 'Promise<any>' : 'any'}`;
  md += '\n```\n\n';
}

if (Object.keys(interfaces).length) {
  md += '## Interfaces\n\n';
  for (const name of Object.keys(interfaces)) {
    md += '```typescript\n' + interfaces[name] + '\n```\n\n';
  }
}

fs.writeFileSync(OUTPUT, md);
