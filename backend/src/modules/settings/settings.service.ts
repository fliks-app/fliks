import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppSetting } from './entities/app-setting.entity';
import { EventsService } from '../scheduler/events.service';

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(AppSetting)
    private readonly repo: Repository<AppSetting>,
    private readonly events: EventsService,
  ) {}

  private readonly changeListeners: Array<(key: string, origin?: string) => void> = [];

  /** `origin` names whoever wrote the key, so a listener can skip echoing a change back to it. */
  addChangeListener(listener: (key: string, origin?: string) => void): void {
    this.changeListeners.push(listener);
  }

  private notifyChange(key: string, origin?: string): void {
    for (const l of this.changeListeners) {
      try {
        l(key, origin);
      } catch {
        /* listener errors must not break writes */
      }
    }
    this.events.emitDomain({ type: 'settings.changed', key });
  }

  async getAll(): Promise<Record<string, string | null>> {
    const rows = await this.repo.find({ order: { key: 'ASC' } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async get(key: string): Promise<string | null> {
    const row = await this.repo.findOne({ where: { key } });
    return row?.value ?? null;
  }

  async set(key: string, value: string | null, origin?: string): Promise<AppSetting> {
    let row = await this.repo.findOne({ where: { key } });
    if (row) {
      row.value = value;
    } else {
      row = this.repo.create({ key, value });
    }
    const saved = await this.repo.save(row);
    this.notifyChange(key, origin);
    return saved;
  }

  async setBulk(data: Record<string, string | null>): Promise<void> {
    for (const [key, value] of Object.entries(data)) {
      await this.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.repo.delete({ key });
    this.notifyChange(key);
  }
}
