import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import {
  NotificationConnection,
  NotificationEvent,
} from './entities/notification-connection.entity';
import { CreateNotificationConnectionDto } from './dto/create-notification-connection.dto';
import {
  mergeSecretFields,
  redactSecretFields,
} from '../../common/utils/secret-fields.util';

/** The only credential a connection stores; the endpoint is an address, not a secret. */
export const NOTIFICATION_SECRET_FIELDS = [
  { key: 'token', secret: true },
] as const;

/** Strips the stored credential from a connection before it reaches a response. */
export function redactNotificationSecrets(
  conn: NotificationConnection,
): NotificationConnection {
  return {
    ...conn,
    settings: redactSecretFields(conn.settings, NOTIFICATION_SECRET_FIELDS),
  };
}

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

  async create(
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
    const previousType = conn.type;
    if (dto.name !== undefined) conn.name = dto.name;
    if (dto.type !== undefined) conn.type = dto.type as any;
    if (dto.settings !== undefined)
      // A credential belongs to the provider it was issued for: switching type
      // starts from an empty one instead of posting it to another host.
      conn.settings = this.normalizeSettings(
        dto.type,
        dto.settings,
        dto.type === previousType ? conn.settings : undefined,
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
          await axios.post(
            `${url}/message?token=${encodeURIComponent(token)}`,
            {
              title: `Fliks — ${event}`,
              message: this.formatMessage(event, payload),
              priority: 5,
            },
          );
          break;
        }
        case 'ntfy': {
          const url = String(s.url ?? '').replace(/\/$/, '');
          const topic = String(s.topic || 'fliks');
          if (!url) throw new Error('url not configured');
          const token = typeof s.token === 'string' ? s.token : '';
          await axios.post(
            `${url}/${topic}`,
            this.formatMessage(event, payload),
            {
              headers: {
                // Axios drops non-latin1 characters from header values, so a
                // fancier dash here reaches ntfy as a gap. Keep it ASCII.
                Title: `Fliks - ${event}`,
                // A reserved topic or a deny-all server 403s without this.
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
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

  /** Discord and Slack address a webhook, the others a server read from `url`.
   *  A `webhookUrl` from any client is folded onto the key its sender reads. */
  private normalizeSettings(
    type: string,
    settings: Record<string, unknown>,
    existing?: Record<string, unknown>,
  ): Record<string, unknown> {
    const trimmed = Object.fromEntries(
      Object.entries(settings).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.trim() : value,
      ]),
    );
    if (type === 'discord' || type === 'slack') return trimmed;
    const { webhookUrl, ...rest } = trimmed;
    const folded =
      webhookUrl === undefined
        ? trimmed
        : { ...rest, url: rest.url || webhookUrl };
    // A response never carries the stored token, so an incoming blank means
    // "unchanged" — which is also why gotify's token is checked here and not
    // in the DTO, where the merged value is not visible yet.
    const out = mergeSecretFields(existing, folded, NOTIFICATION_SECRET_FIELDS);
    if (type === 'gotify' && !out.token)
      throw new BadRequestException(
        'gotify requires a non-empty settings.token',
      );
    return out;
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
