#!/usr/bin/env node

import { resolve } from 'node:path';
import { Auditor } from '../lib/auditor.js';

const args = process.argv.slice(2);
const mode = args.includes('--quick') ? 'quick' : 'full';
const json = args.includes('--json');
const baseUrlArg = args.find(arg => arg.startsWith('--base-url='));
const baseUrl = baseUrlArg?.slice('--base-url='.length) || process.env.LLM_GATEWAY_SELF_URL;
const root = resolve(process.env.LLM_GATEWAY_ROOT || process.cwd());
const report = await new Auditor({ root, mode, selfFetch: baseUrl }).run();

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`\n=== llm-gateway audit (${report.mode}) ===`);
  console.log(`status:            ${report.status}`);
  console.log(`assurance:         ${report.assurance}`);
  console.log(`duration:          ${report.duration_ms}ms`);
  console.log(`files inventoried: ${report.inventory_files}`);
  console.log(`findings:          P0=${report.p0_count} P1=${report.p1_count} P2=${report.p2_count}`);
  console.log(`fix claims:        verified=${report.verified_fixes} unverified=${report.unverified_fixes}`);
  for (const limitation of report.limitations) console.log(`limitation:        ${limitation}`);

  const blocking = report.phases.static?.findings?.filter(item => item.severity === 'P0') || [];
  if (blocking.length) {
    console.log('\nP0 findings:');
    for (const finding of blocking) console.log(`- ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
  }
  if (report.phases.claims?.unverified?.length) {
    console.log('\nUnverified claims:');
    for (const claim of report.phases.claims.unverified) console.log(`- ${claim.token}`);
  }
  console.log('');
}

process.exitCode = ['HEALTH_VERIFIED', 'STATIC_HEALTH_VERIFIED'].includes(report.status) ? 0 : 1;
