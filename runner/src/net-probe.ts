// Whether a provider's API can be reached again, after a turn failed
// because it couldn't be (errorKind network). The runner asks this while
// such threads wait, and carries them on once it says yes
// (Runner.onNetworkLost).
//
// A TCP connection to the API host's port 443 is enough: the turn failed
// before any answer (DNS, no route, a dropped line), and a connection that
// opens means the CLI's own request would get through too. Through a proxy
// (HTTPS_PROXY, which the CLIs use as well) the proxy is asked for a
// tunnel to the host, as the CLI's request would.
import net from 'node:net';
import tls from 'node:tls';
import type { Provider } from './protocol.ts';

export type Reachable = (provider: Provider) => Promise<boolean>;

const HOSTS: Record<Provider, string> = {
  claude: 'api.anthropic.com',
  // Codex logins are ChatGPT ones; its requests go to chatgpt.com.
  codex: 'chatgpt.com',
};

// How long a probe may take in all, whatever arrives meanwhile: a proxy
// sending a little at a time mustn't keep one going (Daybreak, 8 Nov).
const PROBE_TIMEOUT_MS = 5_000;
// The most of a proxy's answer read for its status line. A real one is a few
// dozen bytes; one sending more without a line end is no proxy to trust, and
// what it sends is never kept past this.
export const PROXY_HEAD_MAX = 1024;

export type ProbeTarget = { host: string; port: number; proxy?: { host: string; port: number; tls: boolean } };

export function probeTarget(provider: Provider, env: NodeJS.ProcessEnv = process.env): ProbeTarget {
  const host = HOSTS[provider] ?? HOSTS.claude;
  const proxy = env.HTTPS_PROXY || env.https_proxy;
  if (proxy) {
    try {
      const u = new URL(proxy);
      // An https:// proxy is spoken to over TLS, its certificate checked, as
      // the CLIs do: not a plain connection anyone on the way can answer.
      const secure = u.protocol === 'https:';
      return { host, port: 443, proxy: { host: u.hostname, port: Number(u.port) || (secure ? 443 : 80), tls: secure } };
    } catch {
      // Not a URL; try the host directly.
    }
  }
  return { host, port: 443 };
}

export function makeReachable(opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Reachable {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  return (provider) => {
    const { host, port, proxy } = probeTarget(provider, opts.env ?? process.env);
    return new Promise((resolve) => {
      let settled = false;
      const socket = proxy?.tls ? tls.connect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host }) : net.connect(proxy ?? { host, port });
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        socket.destroy();
        resolve(ok);
      };
      const deadline = setTimeout(() => done(false), timeoutMs);
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once('error', () => done(false));
      socket.once(proxy?.tls ? 'secureConnect' : 'connect', () => {
        if (!proxy) return done(true);
        // The proxy's answer to CONNECT: a 2xx means it reached the host.
        socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
        let head = '';
        socket.on('data', (b: Buffer) => {
          if (settled) return;
          head += b.subarray(0, PROXY_HEAD_MAX + 2 - head.length).toString('latin1');
          const end = head.indexOf('\r\n');
          if (end >= 0) done(/^HTTP\/1\.[01] 2\d\d/.test(head.slice(0, end)));
          else if (head.length > PROXY_HEAD_MAX) done(false);
        });
        socket.once('end', () => done(false));
      });
    });
  };
}

export const reachable: Reachable = makeReachable();
