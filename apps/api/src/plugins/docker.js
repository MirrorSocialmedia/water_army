/**
 * Docker client — dockerode against the unix socket (施工 MD §3).
 * The api is the ONLY process that holds the socket (compose, ro mount).
 *
 * Error classification (MD §2-7 / ADR §3): only a definitive 404 is
 * "not found"; daemon down / permission / timeout stay distinct. The
 * classification layer itself lands in P2 (DockerService) — P1 only needs
 * a ping for health/ready.
 */
import Docker from 'dockerode';

/**
 * @param {{dockerSocketPath:string}} config
 */
export function createDockerClient(config) {
  if (!config.dockerSocketPath) {
    return {
      disabled: true,
      client: null,
      ping: async () => {
        const err = new Error('Docker checks disabled via config (DOCKER_SOCKET_PATH empty)');
        err.code = 'DOCKER_DISABLED';
        throw err;
      },
    };
  }
  const client = new Docker({ socketPath: config.dockerSocketPath });
  return {
    disabled: false,
    client,
    ping: () => client.ping(),
  };
}
