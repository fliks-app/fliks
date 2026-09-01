import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomFormat, CustomFormatSpec } from './entities/custom-format.entity';
import { CreateCustomFormatDto } from './dto/create-custom-format.dto';
import {
  parseReleaseAttributes,
  parseReleaseLanguage,
  type ReleaseAttributes,
} from '../../common/release-parsing';

/** Torrent-level facts a release carries outside its name. */
export interface ReleaseFlagMeta {
  freeleech?: boolean;
  downloadVolumeFactor?: number;
}

export interface CustomFormatMatch {
  formatId: number;
  formatName: string;
  matched: boolean;
  score: number;
}

/** Collapses the spelling variants of one tag ("WEB-DL", "web.dl", "WEBDL"). */
function norm(value: string | null | undefined): string {
  return (value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

@Injectable()
export class CustomFormatsService {
  constructor(
    @InjectRepository(CustomFormat)
    private readonly repo: Repository<CustomFormat>,
  ) {}

  create(dto: CreateCustomFormatDto): Promise<CustomFormat> {
    this.assertRegexesCompile(dto.specs);
    const row = this.repo.create({
      name: dto.name,
      score: dto.score ?? 0,
      specs: dto.specs as CustomFormatSpec[],
    });
    return this.repo.save(row);
  }

  findAll(): Promise<CustomFormat[]> {
    return this.repo.find({ order: { name: 'ASC' } });
  }

  async findOne(id: number): Promise<CustomFormat> {
    const cf = await this.repo.findOne({ where: { id } });
    if (!cf) throw new NotFoundException(`Custom format #${id} not found`);
    return cf;
  }

  async update(id: number, dto: CreateCustomFormatDto): Promise<CustomFormat> {
    const cf = await this.findOne(id);
    this.assertRegexesCompile(dto.specs);
    cf.name = dto.name;
    cf.score = dto.score ?? 0;
    cf.specs = dto.specs as CustomFormatSpec[];
    return this.repo.save(cf);
  }

  async remove(id: number): Promise<void> {
    const cf = await this.findOne(id);
    await this.repo.remove(cf);
  }

  /** Per-format verdict for one release title — the settings page's tester. */
  async testRelease(
    title: string,
    meta?: ReleaseFlagMeta,
  ): Promise<CustomFormatMatch[]> {
    const formats = await this.findAll();
    return formats.map((cf) => {
      const matched = this.matchesFormat(title, cf, meta);
      return {
        formatId: cf.id,
        formatName: cf.name,
        matched,
        score: matched ? cf.score : 0,
      };
    });
  }

  /**
   * Total custom-format score for a release title — the grab flow's ranking
   * signal beyond basic quality. Takes the format list the caller already read:
   * the release scorer runs this once per candidate, so re-reading the table per
   * release is an N+1.
   */
  scoreReleaseWith(
    formats: CustomFormat[],
    releaseTitle: string,
    meta?: ReleaseFlagMeta,
  ): number {
    let total = 0;
    for (const fmt of formats) {
      if (this.matchesFormat(releaseTitle, fmt, meta)) total += fmt.score;
    }
    return total;
  }

  /**
   * Conditions of the same type are alternatives (OR); different types must all
   * hold (AND). So `resolution:1080p` + `resolution:2160p` accepts either, while
   * adding `source:bluray` narrows both. A `required` condition must hold on its
   * own, whatever the rest of its group does.
   *
   * A format with no condition matches nothing: it would otherwise score every
   * release in the library.
   */
  private matchesFormat(
    title: string,
    fmt: CustomFormat,
    meta?: ReleaseFlagMeta,
  ): boolean {
    const specs = fmt.specs ?? [];
    if (!specs.length) return false;

    const attrs = parseReleaseAttributes(title);
    const groups = new Map<string, CustomFormatSpec[]>();
    for (const spec of specs) {
      const group = groups.get(spec.type);
      if (group) group.push(spec);
      else groups.set(spec.type, [spec]);
    }

    for (const group of groups.values()) {
      let anyMatched = false;
      for (const spec of group) {
        const raw = this.evalSpec(title, attrs, spec, meta);
        const result = spec.negate ? !raw : raw;
        if (spec.required && !result) return false;
        if (result) anyMatched = true;
      }
      if (!anyMatched) return false;
    }
    return true;
  }

  private evalSpec(
    title: string,
    attrs: ReleaseAttributes,
    spec: CustomFormatSpec,
    meta?: ReleaseFlagMeta,
  ): boolean {
    const value = norm(spec.value);
    switch (spec.type) {
      case 'title_regex':
        // Tested against the untouched title so a pattern can still assert case.
        try {
          return new RegExp(spec.value, 'i').test(title);
        } catch {
          return false;
        }
      case 'source':
        return norm(attrs.source) === value;
      case 'resolution':
        return attrs.resolution > 0 && attrs.resolution === parseInt(value, 10);
      case 'language': {
        const lang = parseReleaseLanguage(title);
        return (
          norm(lang.isoCode) === value ||
          norm(lang.name) === value ||
          (lang.iso639_2 ?? []).some((code) => norm(code) === value)
        );
      }
      case 'release_flag':
        if (value === 'freeleech') return meta?.freeleech === true;
        if (value === 'halfleech') return meta?.downloadVolumeFactor === 0.5;
        return false;
      case 'release_group':
        return norm(attrs.releaseGroup) === value;
      case 'edition':
        return norm(attrs.edition) === value;
      case 'video_codec':
        return norm(attrs.videoCodec) === value;
      case 'audio_codec':
        return norm(attrs.audioCodec) === value;
      default:
        return false;
    }
  }

  /** A pattern that doesn't compile would match nothing for ever, silently —
   *  refuse it at the edit instead of at every search. */
  private assertRegexesCompile(specs: readonly { type: string; value: string }[]) {
    for (const spec of specs) {
      if (spec.type !== 'title_regex') continue;
      try {
        new RegExp(spec.value, 'i');
      } catch {
        throw new BadRequestException(
          `Invalid regular expression: ${spec.value}`,
        );
      }
    }
  }
}
