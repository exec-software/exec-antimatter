import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import {
  assertNodeScopes,
  NODE_AGENT_PROTOCOL,
  NODE_REPORT_LIMIT_BYTES,
  NODE_REQUEST_TIMEOUT_MS,
  type NodeAccelerator,
  type NodeAgentReport,
  type NodeCheckpoint,
  type NodePairingCode,
  type NodeScope,
} from '../../api/nodeAgent';
import { assertClusterAction, parseClusterEngines, parseClusterVitals, type ClusterEngine, type ClusterEngineAction, type ClusterVitals } from '../../api/cluster';

/**
 * Asking another box what it has.
 *
 * The certificate is pinned, not trusted: a self-signed leaf cannot be validated by a chain, so
 * the connection is established with verification off and then checked against the SHA-256 the
 * pairing code carried — before a single byte of the request, bearer included, is written. A box
 * whose certificate has changed is refused rather than re-paired silently, because that is what
 * the pin is for.
 *
 * Everything a report says is treated as input from a machine this one does not control. Lengths
 * are capped, numbers must be finite and non-negative, and an unrecognised protocol is refused
 * outright rather than read optimistically.
 */

export interface NodeTarget {
  endpoint: string;
  certificatePin: string;
}

interface Answer {
  status: number;
  body: unknown;
}

const parsed = (endpoint: string): { host: string; port: number } => {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new Error('A node endpoint is an https address.');
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('A node endpoint names a port.');
  // URL keeps the brackets on a literal IPv6 host; the socket layer wants the address itself.
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port };
};

const pinOf = (raw: Buffer): string => `sha256/${createHash('sha256').update(raw).digest('base64')}`;

function pinnedSocket(host: string, port: number, pin: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => {
      const raw = socket.getPeerCertificate()?.raw;
      if (!raw?.length) {
        socket.destroy();
        reject(new Error('That box offered no certificate.'));
        return;
      }
      if (pinOf(raw) !== pin) {
        socket.destroy();
        // Worth being blunt: on a LAN this is the one error that means something is wrong rather
        // than merely off.
        reject(new Error('That box presented a different certificate than when it was paired. Pair it again only if you know why it changed.'));
        return;
      }
      socket.setTimeout(0);
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('That box did not answer in time.')));
    socket.once('error', reject);
  });
}

async function ask(
  target: NodeTarget,
  options: { method: 'GET' | 'POST'; path: string; bearer?: string; body?: unknown; timeoutMs?: number }
): Promise<Answer> {
  const { host, port } = parsed(target.endpoint);
  const timeoutMs = options.timeoutMs ?? NODE_REQUEST_TIMEOUT_MS;
  const socket = await pinnedSocket(host, port, target.certificatePin, timeoutMs);
  const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
  return new Promise<Answer>((resolve, reject) => {
    // Plain HTTP over a socket that is already TLS and already pinned. Handing the socket to
    // https.request would negotiate a second time against an unverified chain.
    const request = httpRequest({
      createConnection: () => socket,
      host,
      port,
      method: options.method,
      path: options.path,
      headers: {
        accept: 'application/json',
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    });
    const fail = (cause: unknown) => {
      socket.destroy();
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };
    request.setTimeout(timeoutMs, () => fail(new Error('That box did not answer in time.')));
    request.once('error', fail);
    request.once('response', (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > NODE_REPORT_LIMIT_BYTES) {
          response.destroy();
          fail(new Error('That box answered with more than a report can contain.'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        socket.end();
        let body: unknown;
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        } catch {
          fail(new Error('That box answered with something that is not JSON.'));
          return;
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
      response.once('error', fail);
    });
    if (payload) request.write(payload);
    request.end();
  });
}

const refusal = (answer: Answer, fallback: string): Error => {
  const body = (answer.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message.slice(0, 300) : fallback;
  return new Error(message);
};

const text = (value: unknown, limit: number): string | null =>
  typeof value === 'string' && value.trim() && value.length <= limit ? value.trim() : null;

const bytes = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** A report is a document written by another machine. Nothing in it is believed without checking. */
export function parseReport(value: unknown): NodeAgentReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('That box answered with no report.');
  const input = value as Record<string, unknown>;
  if (input.protocol !== NODE_AGENT_PROTOCOL) {
    throw new Error('That box speaks a node protocol this version does not understand. Update the older of the two.');
  }
  const name = text(input.name, 80) ?? 'an unnamed box';
  const nodeId = text(input.nodeId, 64);
  if (!nodeId) throw new Error('That box reported no identity.');
  const accelerators: NodeAccelerator[] = (Array.isArray(input.accelerators) ? input.accelerators : [])
    .slice(0, 32)
    .flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const device = entry as Record<string, unknown>;
      return [{
        name: text(device.name, 120) ?? 'an accelerator',
        memoryFree: bytes(device.memoryFree),
        memoryTotal: bytes(device.memoryTotal),
      }];
    });
  const checkpoints: NodeCheckpoint[] = (Array.isArray(input.checkpoints) ? input.checkpoints : [])
    .slice(0, 256)
    .flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const held = entry as Record<string, unknown>;
      const id = text(held.id, 120);
      return id ? [{ id, name: text(held.name, 160) ?? id, bytes: bytes(held.bytes) ?? 0 }] : [];
    });
  return {
    protocol: NODE_AGENT_PROTOCOL,
    agentVersion: text(input.agentVersion, 40) ?? 'unknown',
    nodeId,
    name,
    accelerators,
    memoryFree: bytes(input.memoryFree),
    memoryTotal: bytes(input.memoryTotal),
    checkpoints,
    observedAt: bytes(input.observedAt) ?? 0,
  };
}

export async function requestReport(
  target: NodeTarget,
  credential: string,
  timeoutMs = NODE_REQUEST_TIMEOUT_MS
): Promise<NodeAgentReport> {
  const answer = await ask(target, { method: 'GET', path: '/v1/report', bearer: credential, timeoutMs });
  if (answer.status === 401) {
    throw new Error('That box no longer trusts this one. Pair it again from the other side.');
  }
  if (answer.status !== 200) throw refusal(answer, 'That box refused to report.');
  return parseReport(answer.body);
}

export interface NodePairing {
  scopes: NodeScope[];
  nodeId: string;
  name: string;
  credential: string;
  controllerId: string;
}

export async function pairWithNode(
  code: NodePairingCode,
  controllerName: string,
  clientVersion: string,
  timeoutMs = NODE_REQUEST_TIMEOUT_MS
): Promise<NodePairing> {
  const answer = await ask(
    { endpoint: code.endpoint, certificatePin: code.certificatePin },
    {
      method: 'POST',
      path: '/v1/pair',
      timeoutMs,
      body: {
        offerId: code.offerId,
        secret: code.secret,
        controllerName,
        clientVersion,
        scopes: code.scopes ?? ['inventory'],
      },
    }
  );
  if (answer.status !== 200) throw refusal(answer, 'That box refused the pairing.');
  const body = (answer.body ?? {}) as Record<string, unknown>;
  const node = (body.node ?? {}) as Record<string, unknown>;
  const controller = (body.controller ?? {}) as Record<string, unknown>;
  const credential = text(body.credential, 200);
  const nodeId = text(node.id, 64);
  const controllerId = text(controller.id, 64);
  if (!credential || !nodeId || !controllerId) throw new Error('That box answered the pairing with something incomplete.');
  // The box in the code must be the box that answered. A pin match already proves it holds the
  // paired key; this catches a code pasted against the wrong endpoint.
  if (nodeId !== code.nodeId) throw new Error('That pairing code belongs to a different box than the one that answered.');
  const scopes = assertNodeScopes(controller.scopes);
  if (scopes.some((scope) => !(code.scopes ?? ['inventory']).includes(scope))) throw new Error('That node returned permissions beyond this pairing offer.');
  return { nodeId, name: text(node.name, 80) ?? 'an unnamed box', credential, controllerId, scopes };
}

export async function requestNodeVitals(target: NodeTarget, credential: string): Promise<ClusterVitals> {
  const answer = await ask(target, { method: 'GET', path: '/v1/vitals', bearer: credential });
  if (answer.status !== 200) throw refusal(answer, 'That node refused vitals access.');
  return parseClusterVitals(answer.body);
}
export async function requestNodeEngines(target: NodeTarget, credential: string): Promise<ClusterEngine[]> {
  const answer = await ask(target, { method: 'GET', path: '/v1/engines', bearer: credential });
  if (answer.status !== 200) throw refusal(answer, 'That node refused engine access.');
  return parseClusterEngines((answer.body as { engines?: unknown })?.engines);
}
export async function requestNodeEngineAction(target: NodeTarget, credential: string, input: ClusterEngineAction): Promise<ClusterEngine[]> {
  const body = assertClusterAction(input);
  const answer = await ask(target, { method: 'POST', path: '/v1/engines/action', bearer: credential, body, timeoutMs: 120_000 });
  if (answer.status !== 200) throw refusal(answer, 'The engine action failed.');
  return parseClusterEngines((answer.body as { engines?: unknown })?.engines);
}
