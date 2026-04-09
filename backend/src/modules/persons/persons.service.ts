import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Person } from '../media/entities/person.entity';
import { MediaCast } from '../media/entities/media-cast.entity';
import { MediaCrew } from '../media/entities/media-crew.entity';
import { TmdbProvider } from '../metadata-providers/providers/tmdb.provider';
import { PersonCombinedCredits } from '../metadata-providers/interfaces/metadata-provider.interface';
import { ImageService } from '../images/image.service';

/** Refresh person details if older than 7 days. */
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class PersonsService {
  constructor(
    @InjectRepository(Person)
    private readonly personRepo: Repository<Person>,
    @InjectRepository(MediaCast)
    private readonly castRepo: Repository<MediaCast>,
    @InjectRepository(MediaCrew)
    private readonly crewRepo: Repository<MediaCrew>,
    private readonly dataSource: DataSource,
    private readonly tmdb: TmdbProvider,
    private readonly imageService: ImageService,
  ) {}

  async search(query: string): Promise<Person[]> {
    if (!query?.trim()) {
      return this.personRepo.find({ order: { name: 'ASC' } });
    }
    const tsQuery = query
      .trim()
      .split(/\s+/)
      .map((w) => `${w}:*`)
      .join(' & ');

    return this.personRepo
      .createQueryBuilder('p')
      .where(`p."searchVector" @@ to_tsquery('simple', :q)`, { q: tsQuery })
      .orderBy(`ts_rank(p."searchVector", to_tsquery('simple', :q))`, 'DESC')
      .limit(50)
      .getMany();
  }

  async findOne(id: number): Promise<{
    person: Person;
    cast: MediaCast[];
    crew: MediaCrew[];
  }> {
    const person = await this.personRepo.findOne({ where: { id } });
    if (!person) throw new NotFoundException(`Person #${id} not found`);

    await this.ensureDetailsLoaded(person);

    const [cast, crew] = await Promise.all([
      this.castRepo.find({
        where: { person: { id: person.id } },
        relations: ['media'],
        order: { order: 'ASC' },
      }),
      this.crewRepo.find({
        where: { person: { id: person.id } },
        relations: ['media'],
      }),
    ]);

    return { person, cast, crew };
  }

  async getProviderCredits(id: number): Promise<PersonCombinedCredits> {
    const person = await this.personRepo.findOne({ where: { id } });
    if (!person) throw new NotFoundException(`Person #${id} not found`);
    return this.tmdb.getPersonCredits(person.tmdbId);
  }

  private async ensureDetailsLoaded(person: Person): Promise<void> {
    const needsRefresh =
      !person.metadataRefreshedAt ||
      Date.now() - person.metadataRefreshedAt.getTime() > REFRESH_INTERVAL_MS;

    if (!needsRefresh) return;

    try {
      const details = await this.tmdb.getPersonDetails(person.tmdbId);
      let localAvatar: string | undefined;
      if (details.avatarUrl) {
        const dl = await this.imageService.downloadAndStore(
          details.avatarUrl,
          'person',
          person.id,
        );
        if (dl) localAvatar = dl;
      }
      const updates = {
        name: details.name,
        ...(localAvatar ? { avatarUrl: localAvatar } : {}),
        biography: details.biography,
        birthday: details.birthday ?? undefined,
        deathday: details.deathday ?? undefined,
        placeOfBirth: details.placeOfBirth ?? undefined,
        knownForDepartment: details.knownForDepartment,
        metadataRefreshedAt: new Date(),
      };
      await this.personRepo.update(person.id, updates);
      Object.assign(person, updates);
    } catch {
      // If TMDB call fails, serve stale data
    }
  }
}
