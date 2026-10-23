// Creates a desktop agent for a branch and prints its token once.
// Usage: npm run create-agent -- --branch <branch code> --name "<name>"
import { parseArgs } from 'node:util';
import { db } from '../db/knex.js';
import * as accessRepository from '../repositories/accessRepository.js';
import { insertAgent } from '../services/agentService.js';
import { createAgentSchema } from '../validators/agentValidators.js';

const USAGE = 'Usage: npm run create-agent -- --branch <branch code> --name "<name>"';

async function main() {
  const { values } = parseArgs({ options: { branch: { type: 'string' }, name: { type: 'string' } } });
  if (!values.branch || !values.name) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const name = createAgentSchema.shape.name.safeParse(values.name);
  if (!name.success) {
    console.error(`Invalid name: ${name.error.issues[0].message}`);
    process.exitCode = 1;
    return;
  }

  const branches = await accessRepository.listActiveBranches();
  const branch = branches.find((b) => b.code.toLowerCase() === values.branch.trim().toLowerCase());
  if (!branch) {
    console.error(`Unknown or inactive branch "${values.branch}". Active branches: ${branches.map((b) => b.code).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const { id, token } = await insertAgent({ name: name.data, branchId: branch.id, source: 'cli' });
  console.log(`Agent #${id} "${name.data}" created for ${branch.name}.\n`);
  console.log(`Token (shown only now; paste it into RxBridge's Cloud & token page):\n\n  ${token}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
