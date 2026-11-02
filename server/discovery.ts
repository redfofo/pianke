import dgram, { type Socket } from 'node:dgram';
import os from 'node:os';
import type { FastifyBaseLogger } from 'fastify';

export class EmbyDiscovery {
  private socket: Socket | undefined;

  constructor(
    private readonly serverId: string,
    private readonly logger: FastifyBaseLogger,
  ) {}

  start(): void {
    if (this.socket || process.env.EMBY_DISCOVERY_ENABLED === 'false') return;
    const port = Number(process.env.EMBY_DISCOVERY_PORT || 7359);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.logger.warn('Invalid EMBY_DISCOVERY_PORT; LAN discovery is disabled');
      return;
    }
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (message, remote) => {
      if (message.toString('utf8').trim() !== 'who is EmbyServer?') return;
      const publicPort = Number(process.env.PLAYER_PORT || process.env.PORT || 8788);
      const configuredAddress = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
      const address = configuredAddress || `http://${os.hostname()}:${publicPort}`;
      const payload = Buffer.from(JSON.stringify({ Address: address, Id: this.serverId, Name: process.env.SERVER_NAME || '片刻' }));
      socket.send(payload, remote.port, remote.address, error => {
        if (error) this.logger.warn({ err: error, remote }, 'Emby discovery response failed');
      });
    });
    socket.on('error', error => {
      this.logger.warn({ err: error }, 'Emby LAN discovery unavailable');
      socket.close();
      if (this.socket === socket) this.socket = undefined;
    });
    socket.bind(port, process.env.EMBY_DISCOVERY_HOST || '0.0.0.0');
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }
}
