import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import {
  NotificationConnection,
  NotificationEvent,
} from './entities/notification-connection.entity';
import { CreateNotificationConnectionDto } from './dto/create-notification-connection.dto';

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(NotificationConnection)
    private readonly repo: Repository<NotificationConnection>,
  ) {}

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  create(
    dto: CreateNotificationConnectionDto,
  ): Promise<NotificationConnection> {
    const row = this.repo.create({
      name: dto.name,
      type: dto.type as any,
      settings: this.normalizeSettings(dto.type, dto.settings ?? {}),
      events: (dto.events ?? []) as NotificationEvent[],
      enabled: dto.enabled ?? true,
    });
    return this.repo.save(row);
  }

  findAll(): Promise<NotificationConnection[]> {
    return this.repo.find({ order: { name: 'ASC' } });
  }

  async findOne(id: number): Promise<NotificationConnection> {
    const conn = await this.repo.findOne({ where: { id } });
    if (!conn)
      throw new NotFoundException(`Notification connection #${id} not found`);
    return conn;
  }

  async update(
    id: number,
    dto: CreateNotificationConnectionDto,
  ): Promise<NotificationConnection> {
    const conn = await this.findOne(id);
    if (dto.name !== undefined) conn.name = dto.name;
    if (dto.type !== undefined) conn.type = dto.type as any;
    if (dto.settings !== undefined)
      conn.settings = this.normalizeSettings(
        dto.type ?? conn.type,
        dto.settings,
      );
    if (dto.events !== undefined)
      conn.events = dto.events as NotificationEvent[];
    if (dto.enabled !== undefined) conn.enabled = dto.enabled;
    return this.repo.save(conn);
  }

  async remove(id: number): Promise<void> {
    const conn = await this.findOne(id);
    await this.repo.remove(conn);
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  async dispatch(
    event: NotificationEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const connections = await this.repo.find({ where: { enabled: true } });
    const relevant = connections.filter((c) => c.events.includes(event));

    await Promise.allSettled(relevant.map((c) => this.send(c, event, payload)));
  }

  async testConnection(id: number): Promise<{ ok: boolean; message: string }> {
    const conn = await this.findOne(id);
    try {
      await this.send(conn, 'health.issue', {
        test: true,
        message: 'Test notification from Fliks',
      });
      return { ok: true, message: 'Test notification sent' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  private async send(
    conn: NotificationConnection,
    event: NotificationEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const s = conn.settings;
    try {
      switch (conn.type) {
        case 'discord': {
          const webhookUrl = String(s.webhookUrl ?? '');
          if (!webhookUrl) throw new Error('webhookUrl not configured');
          await axios.post(webhookUrl, {
            username: String(s.username ?? 'Fliks'),
            content: this.formatMessage(event, payload),
          });
          break;
        }
        case 'slack': {
          const webhookUrl = String(s.webhookUrl ?? '');
          if (!webhookUrl) throw new Error('webhookUrl not configured');
          await axios.post(webhookUrl, {
            text: this.formatMessage(event, payload),
          });
          break;
        }
        case 'webhook': {
          const url = String(s.url ?? '');
          if (!url) throw new Error('url not configured');
          await axios.post(
            url,
            { event, ...payload },
            {
              headers: s.token ? { Authorization: `Bearer ${s.token}` } : {},
            },
          );
          break;
        }
        case 'gotify': {
          const url = String(s.url ?? '').replace(/\/$/, '');
          const token = String(s.token ?? '');
          if (!url || !token) throw new Error('url and token required');
          await axios.post(`${url}/message?token=${token}`, {
            title: `Fliks — ${event}`,
            message: this.formatMessage(event, payload),
            priority: 5,
          });
          break;
        }
        case 'ntfy': {
          const url = String(s.url ?? '').replace(/\/$/, '');
          const topic = String(s.topic ?? 'fliks');
          if (!url) throw new Error('url not configured');
          await axios.post(
            `${url}/${topic}`,
            this.formatMessage(event, payload),
            {
              // Axios drops non-latin1 characters from header values, so a
              // fancier dash here reaches ntfy as a gap. Keep it ASCII.
              headers: { Title: `Fliks - ${event}` },
            },
          );
          break;
        }
        default:
          this.log.warn(`Unknown notification type: ${conn.type}`);
      }
    } catch (e) {
      this.log.warn(
        `Failed to send notification via ${conn.name}: ${(e as Error).message}`,
      );
      throw e;
    }
  }

  /** Only Discord and Slack address a webhook; the rest read `url`. Older
   *  clients sent every endpoint as `webhookUrl`, so fold it in on write —
   *  a stale cached SPA still saves a usable row. */
  private normalizeSettings(
    type: string,
    settings: Record<string, unknown>,
  ): Record<string, unknown> {
    if (type === 'discord' || type === 'slack') return settings;
    if (!('webhookUrl' in settings)) return settings;
    const { webhookUrl, ...rest } = settings;
    return { ...rest, url: rest.url ?? webhookUrl };
  }

  private formatMessage(
    event: NotificationEvent,
    payload: Record<string, unknown>,
  ): string {
    const title = (payload.title as string) ?? '';
    switch (event) {
      case 'request.created':
        return `New request: ${title}`;
      case 'request.approved':
        return `Request approved: ${title}`;
      case 'request.declined':
        return `Request declined: ${title}`;
      case 'request.delete.created':
        return `New deletion request: ${title}`;
      case 'request.delete.approved':
        return `Deletion request approved: ${title}`;
      case 'request.delete.declined':
        return `Deletion request declined: ${title}`;
      case 'request.processing':
        return `Request downloading: ${title}`;
      case 'request.available':
        return `Request available: ${title}`;
      case 'grab.started':
        return `Grabbing: ${title}`;
      case 'download.complete':
        return `Download complete: ${title}`;
      case 'health.issue':
        return String(payload.message ?? 'Health issue detected');
      default:
        return `${event}: ${JSON.stringify(payload)}`;
    }
  }
}
