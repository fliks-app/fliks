import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MediaServer } from '../users/entities/media-server.entity';
import { CreateMediaServerDto } from './dto/create-media-server.dto';
import { MediaServerProvider } from './providers/media-server-provider.interface';
import { EmbyProvider } from './providers/emby.provider';

@Injectable()
export class MediaServersService {
  private readonly log = new Logger(MediaServersService.name);
  private readonly providers: Map<string, MediaServerProvider>;

  constructor(
    @InjectRepository(MediaServer)
    private readonly repo: Repository<MediaServer>,
    private readonly embyProvider: EmbyProvider,
  ) {
    this.providers = new Map<string, MediaServerProvider>([
      [embyProvider.type, embyProvider],
    ]);
  }

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  getTypes(): { type: string; label: string; supportedEvents: string[] }[] {
    return [...this.providers.values()].map((p) => ({
      type: p.type,
      label: p.label,
      supportedEvents: p.supportedEvents,
    }));
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  create(dto: CreateMediaServerDto): Promise<MediaServer> {
    const row = this.repo.create({
      name: dto.name,
      type: dto.type,
      url: dto.url,
      apiKey: dto.apiKey ?? '',
      events: dto.events ?? [],
      enabled: dto.enabled ?? true,
    });
    return this.repo.save(row);
  }

  findAll(): Promise<MediaServer[]> {
    return this.repo.find({ order: { name: 'ASC' } });
  }

  async findOne(id: number): Promise<MediaServer> {
    const ms = await this.repo.findOne({ where: { id } });
    if (!ms) throw new NotFoundException(`MediaServer #${id} not found`);
    return ms;
  }

  async update(id: number, dto: CreateMediaServerDto): Promise<MediaServer> {
    const ms = await this.findOne(id);
    if (dto.name !== undefined) ms.name = dto.name;
    if (dto.type !== undefined) ms.type = dto.type;
    if (dto.url !== undefined) ms.url = dto.url;
    if (dto.apiKey !== undefined) ms.apiKey = dto.apiKey;
    if (dto.events !== undefined) ms.events = dto.events;
    if (dto.enabled !== undefined) ms.enabled = dto.enabled;
    return this.repo.save(ms);
  }

  async remove(id: number): Promise<void> {
    const ms = await this.findOne(id);
    await this.repo.remove(ms);
  }

  // ---------------------------------------------------------------------------
  // Test
  // ---------------------------------------------------------------------------

  async testConnection(id: number): Promise<{ ok: boolean; message: string }> {
    const ms = await this.findOne(id);
    const provider = this.providers.get(ms.type);
    if (!provider) {
      return { ok: false, message: `Type "${ms.type}" non supporte` };
    }
    return provider.testConnection(ms.url, ms.apiKey);
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  async dispatch(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const servers = await this.repo.find({ where: { enabled: true } });
    const relevant = servers.filter((s) => s.events.includes(event));
    if (!relevant.length) return;

    await Promise.allSettled(
      relevant.map(async (server) => {
        const provider = this.providers.get(server.type);
        if (!provider) return;
        try {
          await provider.refreshLibrary(
            server.url,
            server.apiKey,
            payload.path as string | undefined,
          );
        } catch (e) {
          this.log.warn(
            `Failed to dispatch ${event} to ${server.name}: ${(e as Error).message}`,
          );
        }
      }),
    );
  }
}
