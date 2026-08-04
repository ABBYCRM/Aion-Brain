// Lightweight static checks. These are heuristics, not a substitute for tests,
// dependency analysis, code review, or runtime verification.

const RULES = [
  rule('P0-eval', 'P0', ['.js', '.mjs', '.cjs', '.ts', '.tsx'], 'Dynamic code execution is unsafe.',
    ({ line }) => /\b(?:eval|new\s+Function)\s*\(/.test(stripComments(line)),
    'Remove dynamic code execution and use a constrained parser.'),

  rule('P0-hardcoded-secret', 'P0', ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.yaml', '.yml'],
    'A value resembles a production credential.',
    ({ line }) => /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(line),
    'Revoke the credential and move it to a secret manager.'),

  rule('P0-sql-concatenation', 'P0', ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    'SQL appears to be assembled with string concatenation or interpolation.',
    ({ line, filePath }) => !isAuditImplementation(filePath) && /['"`]\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^'"`]*(?:\+|\$\{)/i.test(stripComments(line)),
    'Use a prepared statement with bound parameters.'),

  rule('P0-fetch-without-deadline', 'P0', ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    'A network request has no visible abort signal or deadline.',
    ({ line, window, filePath }) => !isTestOrCli(filePath) && !isAuditImplementation(filePath) && /\bfetch\s*\(/.test(stripComments(line)) && !/signal\s*:|AbortSignal|fetchWithTimeout/.test(window),
    'Pass an AbortSignal or call a deadline-enforcing wrapper.'),

  rule('P0-async-express-handler', 'P0', ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    'Express 4 async handlers require an error-forwarding wrapper.',
    ({ window, filePath }) => !isAuditImplementation(filePath) && /app\.(?:get|post|put|patch|delete)\([^,]+,\s*async\s*\(/.test(window) && !/asyncRoute|wrapAsync/.test(window),
    'Wrap the handler and forward rejected promises to next().'),

  rule('P1-sync-fs-hot-path', 'P1', ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    'Synchronous filesystem access may block the event loop.',
    ({ line, window, filePath }) => !isTestOrCli(filePath) && filePath !== 'lib/auditor.js' && /\b(?:readFileSync|writeFileSync|readdirSync|statSync|existsSync)\s*\(/.test(stripComments(line)) && !/startup-only|audit-static/.test(window),
    'Use node:fs/promises on request paths, or document a narrow startup/audit exception.'),

  rule('P1-json-parse-unprotected', 'P1', ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    'JSON.parse can throw on malformed or corrupt input.',
    ({ line, before }) => /JSON\.parse\s*\(/.test(stripComments(line)) && !/\btry\s*\{/.test(before),
    'Parse inside try/catch and return a typed error.'),

  rule('P1-open-cors', 'P1', ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.yaml', '.yml'],
    'Wildcard CORS exposes the API to every browser origin.',
    ({ line }) => !/[?].*['"]\*['"]/.test(line) && /access-control-allow-origin[^\n]*['"]\*['"]|origin\s*:\s*['"]\*['"]/.test(line),
    'Use an explicit origin allowlist.'),

  rule('P1-unprotected-operations', 'P1', ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    'Operational or audit data endpoint appears to lack an auth middleware.',
    ({ line, content }) => /app\.(?:get|post)\(['"]\/(?:audit|stats|calls)/.test(line) && !/(?:app\.use\(['"]\/(?:audit|stats|calls)['"],\s*(?:requireAdmin|adminAuth)|(?:requireAdmin|adminAuth))/.test(content),
    'Require an administrative credential before the handler.'),

  rule('P1-process-exit-server', 'P1', ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    'Direct process.exit can terminate in-flight work.',
    ({ line, filePath, before }) => !isTestOrCli(filePath) && /process\.exit\s*\(/.test(stripComments(line)) && !/shutdown|server\.close/.test(before),
    'Set process.exitCode or exit only after graceful shutdown completes.'),

  rule('P1-no-request-body-limit', 'P1', ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    'A body parser has no explicit size limit.',
    ({ line, window }) => /express\.(?:json|raw|text)\s*\(/.test(line) && !/limit\s*:/.test(window),
    'Set a conservative explicit limit.'),

  rule('P2-todo', 'P2', ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    'An unfinished-work marker remains in executable code.',
    ({ line, filePath }) => !isAuditImplementation(filePath) && /\b(?:TODO|FIXME|XXX)\b/.test(line),
    'Resolve the work or link a tracked issue with a bounded plan.'),

  rule('P2-console-debug', 'P2', ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    'Debug logging remains in executable code.',
    ({ line, filePath }) => !isTestOrCli(filePath) && /\bconsole\.(?:debug|log)\s*\(/.test(stripComments(line)),
    'Use structured logging with explicit levels.'),
];

export { RULES };

export function auditFile({ filePath, content }) {
  const extension = ext(filePath);
  if (!extension) return [];
  const lines = content.split('\n');
  const findings = [];

  for (const check of RULES) {
    if (!check.exts.includes(extension)) continue;
    for (let index = 0; index < lines.length; index += 1) {
      const context = {
        filePath,
        line: lines[index],
        lineNumber: index + 1,
        before: lines.slice(Math.max(0, index - 6), index + 1).join('\n'),
        window: lines.slice(Math.max(0, index - 2), index + 7).join('\n'),
        content,
      };
      let matched = false;
      try {
        matched = Boolean(check.match(context));
      } catch (error) {
        findings.push({
          rule: check.id,
          severity: 'P2',
          file: filePath,
          line: index + 1,
          message: `Static rule failed: ${error.message}`,
          snippet: '',
          fix: 'Correct the rule implementation.',
        });
      }
      if (!matched) continue;
      findings.push({
        rule: check.id,
        severity: check.severity,
        file: filePath,
        line: index + 1,
        message: check.message,
        snippet: lines[index].trim().slice(0, 180),
        fix: check.fix,
      });
    }
  }

  return dedupeFindings(findings);
}

export function severityRank(severity) {
  return { P0: 3, P1: 2, P2: 1 }[severity] || 0;
}

function rule(id, severity, exts, message, match, fix) {
  return { id, severity, exts, message, match, fix };
}

function ext(path) {
  const index = path.lastIndexOf('.');
  return index < 0 ? null : path.slice(index).toLowerCase();
}

function stripComments(line) {
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

function isTestOrCli(filePath) {
  return /^(?:test|bin)\//.test(filePath);
}

function isAuditImplementation(filePath) {
  return filePath === 'lib/rules.js' || filePath === 'lib/auditor.js';
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter(item => {
    const key = `${item.rule}:${item.file}:${item.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
