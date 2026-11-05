// The single place anything reaches stdout or stderr. Every line, including
// thrown error messages and their causes, passes through the redactor.

const REPLACEMENT = '[redacted]';
const MAX_CAUSE_DEPTH = 5;

function variants(secret) {
  const forms = new Set([secret]);
  for (const encoded of [
    encodeURIComponent(secret),
    encodeURI(secret),
    new URLSearchParams({ v: secret }).toString().slice(2),
    encodeURIComponent(encodeURIComponent(secret)),
  ]) {
    forms.add(encoded);
  }
  return forms;
}

export function createRedactor(secrets) {
  const needles = new Set();
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret === '') continue;
    for (const form of variants(secret)) needles.add(form);
  }
  if (needles.size === 0) return (text) => String(text);
  const alternation = [...needles]
    .sort((a, b) => b.length - a.length) // longest first, so a URL is not half-replaced
    .map((needle) => needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const pattern = new RegExp(alternation, 'gi');
  return (text) => String(text).replace(pattern, REPLACEMENT);
}

// Message, code and cause chain only. Stacks add nothing for an operator and
// widen what could leak.
export function describeError(error, depth = 0) {
  if (error === null || typeof error !== 'object') return String(error);
  const parts = [];
  const name = typeof error.name === 'string' && error.name !== 'Error' ? `${error.name}: ` : '';
  parts.push(`${name}${error.message ?? String(error)}`);
  if (typeof error.code === 'string') parts.push(`code=${error.code}`);
  if (depth < MAX_CAUSE_DEPTH) {
    if (Array.isArray(error.errors)) {
      for (const inner of error.errors) parts.push(`[${describeError(inner, depth + 1)}]`);
    }
    if (error.cause !== undefined) parts.push(`cause: ${describeError(error.cause, depth + 1)}`);
  }
  return parts.join(' ');
}

function defaultSink(level, line) {
  (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
}

export function createLogger({ secrets = [], sink = defaultSink } = {}) {
  const redact = createRedactor(secrets);
  const emit = (level, message, error) => {
    let line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
    if (error !== undefined) line += `: ${describeError(error)}`;
    sink(level, redact(line));
  };
  return {
    info: (message, error) => emit('info', message, error),
    warn: (message, error) => emit('warn', message, error),
    error: (message, error) => emit('error', message, error),
    redact,
  };
}
