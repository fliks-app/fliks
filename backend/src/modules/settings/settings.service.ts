import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppSetting } from './entities/app-setting.entity';

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(AppSetting)
    private readonly repo: Repository<AppSetting>,
  ) {}

  async getAll(): Promise<Record<string, string | null>> {
    const rows = await this.repo.find({ order: { key: 'ASC' } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async get(key: string): Promise<string | null> {
    const row = await this.repo.findOne({ where: { key } });
    return row?.value ?? null;
  }

  async set(key: string, value: string | null): Promise<AppSetting> {
    let row = await this.repo.findOne({ where: { key } });
    if (row) {
      row.value = value;
    } else {
      row = this.repo.create({ key, value });
    }
    return this.repo.save(row);
  }

  async setBulk(data: Record<string, string | null>): Promise<void> {
    for (const [key, value] of Object.entries(data)) {
      await this.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.repo.delete({ key });
  }
}
