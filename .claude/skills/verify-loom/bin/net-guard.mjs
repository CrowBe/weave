// Verification scaffolding for verify-loom, not product code.
// Preloaded with `node --import` into a drive's child process. It records and
// refuses every outbound network attempt (fetch, net/tls connect, http(s)
// request, dns lookup) so a drive can prove an "offline" entry point really
// stayed offline. Attempts are appended as JSON lines to $LOOM_VERIFY_NET_LOG.
// It covers only the process it is preloaded into: children spawned with an
// explicit argv (the AgentFabric isolate worker) do not inherit it.
import { appendFileSync } from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const log = process.env.LOOM_VERIFY_NET_LOG;

function record(kind, target) {
  const line = JSON.stringify({ kind, target: String(target ?? '') });
  if (log) appendFileSync(log, `${line}\n`);
  return new Error(`verify-loom net-guard refused ${kind} ${target ?? ''}`);
}

globalThis.fetch = async (input) => {
  throw record('fetch', typeof input === 'string' ? input : (input?.url ?? input));
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  // net.connect() hands the socket its normalized args as one array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  // Local IPC (a path, or { path }) is not network; let it through.
  if (typeof first === 'string' || (first && typeof first === 'object' && 'path' in first && first.path)) {
    return connect.apply(this, args);
  }
  const target =
    typeof first === 'object' && first ? `${first.host ?? ''}:${first.port ?? ''}` : `${args[1] ?? ''}:${first}`;
  throw record('net.connect', target);
};
tls.connect = (...args) => {
  throw record('tls.connect', JSON.stringify(args[0]?.host ?? args[1] ?? args[0]));
};
for (const [name, mod] of [
  ['http', http],
  ['https', https],
]) {
  for (const fn of ['request', 'get']) {
    mod[fn] = (target) => {
      throw record(`${name}.${fn}`, typeof target === 'string' ? target : (target?.href ?? target?.host ?? ''));
    };
  }
}
dns.lookup = (host) => {
  throw record('dns.lookup', host);
};
dns.promises.lookup = async (host) => {
  throw record('dns.promises.lookup', host);
};
