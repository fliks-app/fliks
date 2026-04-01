import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tag } from './entities/tag.entity';
import { CreateTagDto } from './dto/create-tag.dto';

@Injectable()
export class TagsService {
  constructor(
    @InjectRepository(Tag)
    private readonly tagRepo: Repository<Tag>,
  ) {}

  async create(dto: CreateTagDto): Promise<Tag> {
    const existing = await this.tagRepo.findOne({
      where: { label: dto.label },
    });
    if (existing) {
      throw new ConflictException(`Tag "${dto.label}" already exists`);
    }
    return this.tagRepo.save(this.tagRepo.create(dto));
  }

  findAll(): Promise<Tag[]> {
    return this.tagRepo.find({ order: { label: 'ASC' } });
  }

  async findOne(id: number): Promise<Tag> {
    const tag = await this.tagRepo.findOne({ where: { id } });
    if (!tag) {
      throw new NotFoundException(`Tag #${id} not found`);
    }
    return tag;
  }

  async update(id: number, dto: CreateTagDto): Promise<Tag> {
    const tag = await this.findOne(id);
    tag.label = dto.label;
    return this.tagRepo.save(tag);
  }

  async remove(id: number): Promise<void> {
    const tag = await this.findOne(id);
    await this.tagRepo.remove(tag);
  }
}
