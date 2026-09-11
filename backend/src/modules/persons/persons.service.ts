import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { Media } from '../media/entities/media.entity';
import { Person } from '../media/entities/person.entity';
import { MediaCast } from '../media/entities/media-cast.entity';
import { MediaCrew } from '../media/entities/media-crew.entity';
import { MetadataProviderRegistry } from '../metadata-providers/metadata-provider.registry';
import {
  IMetadataProvider,
  PersonCreditItem,
} from '../metadata-providers/interfaces/metadata-provider.interface';
import { ImageService } from '../images/image.service';

/** A provider credit plus the id of the library media holding that work, so
 *  the card can open it instead of the "add" page. */
export type PersonCredit = PersonCreditItem & { mediaId: number | null };

export interface PersonCredits {
  provider: string;
  cast: PersonCredit[];
  crew: PersonCredit[];
}

/** Refresh person details if older than 7 days. */
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class PersonsService {
  private readonly log = new Logger(PersonsService.name);

  constructor(
    @InjectRepository(Person)
    private readonly personRepo: Repository<Person>,
    @InjectRepository(MediaCast)
    private readonly castRepo: Repository<MediaCast>,
    @InjectRepository(MediaCrew)
    private readonly crewRepo: Repository<MediaCrew>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    private readonly dataSource: DataSource,
    private readonly providers: MetadataProviderRegistry,
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

  async getProviderCredits(id: number): Promise<PersonCredits> {
    const person = await this.personRepo.findOne({ where: { id } });
    if (!person) throw new NotFoundException(`Person #${id} not found`);
    const credits = await this.callProvider(person, (p) =>
      p.getPersonCredits(String(person.tmdbId)),
    );
    const cast = credits.cast.map((c) => ({ ...c, mediaId: null }));
    const crew = credits.crew.map((c) => ({ ...c, mediaId: null }));
    await this.linkOwnedMedia([...cast, ...crew], person.provider);
    return { provider: person.provider, cast, crew };
  }

  /** Credit ids are the provider's work ids, which is exactly what the media
   *  rows store as `tmdbId`/`tvdbId`. */
  private async linkOwnedMedia(
    credits: PersonCredit[],
    provider: string,
  ): Promise<void> {
    const ids = [...new Set(credits.map((c) => c.externalId))].filter(Boolean);
    if (!ids.length) return;
    const column = provider === 'tvdb' ? 'tvdbId' : 'tmdbId';
    const owned = await this.mediaRepo.find({
      where: { [column]: In(ids) },
      select: ['id', column],
    });
    const byExternalId = new Map(owned.map((m) => [m[column], m.id]));
    for (const c of credits) {
      c.mediaId = byExternalId.get(c.externalId) ?? null;
    }
  }

  private async ensureDetailsLoaded(person: Person): Promise<void> {
    const needsRefresh =
      !person.metadataRefreshedAt ||
      Date.now() - person.metadataRefreshedAt.getTime() > REFRESH_INTERVAL_MS;

    if (!needsRefresh) return;

    try {
      const details = await this.callProvider(person, (p) =>
        p.getPersonDetails(String(person.tmdbId)),
      );
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
      // If the provider call fails, serve stale data
    }
  }

  /** `tmdbId` is provider-scoped: a 404 means the id belongs to the other
   *  provider, so retry there and pin the row to it. */
  private async callProvider<T>(
    person: Person,
    call: (provider: IMetadataProvider) => Promise<T>,
  ): Promise<T> {
    const provider = this.providers.resolve(person.provider);
    try {
      return await call(provider);
    } catch (err) {
      const fallback = this.providers.getFallback(provider.name);
      if (!fallback || !axios.isAxiosError(err) || err.response?.status !== 404)
        throw err;
      const result = await call(fallback);
      await this.personRepo.update(person.id, { provider: fallback.name });
      person.provider = fallback.name;
      this.log.log(
        `person#${person.id} id ${person.tmdbId} is a ${fallback.name} id, not ${provider.name}`,
      );
      return result;
    }
  }
}
