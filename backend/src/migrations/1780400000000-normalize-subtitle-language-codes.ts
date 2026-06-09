import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Canonicalise stored subtitle language codes to ISO 639-1 so language
 * matching against a language-profile isoCode can never miss on a variant.
 * Providers (e.g. OpenSubtitles) return regional forms like `pt-BR`/`zh-CN`
 * and embedded streams can carry `fr-FR`/`fre`; those were stored verbatim and
 * never strict-equalled the canonical `pt`/`zh`/`fr`, so the auto-grab kept
 * re-downloading a language that was already present. New writes are folded by
 * the SubtitleFile.language column transformer; this backfills existing rows.
 */
export class NormalizeSubtitleLanguageCodes1780400000000 implements MigrationInterface {
  name = 'NormalizeSubtitleLanguageCodes1780400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) Fold regional/script subtags to the base subtag and lowercase
    //    (pt-BR -> pt, fr_FR -> fr, zh-Hans -> zh).
    await queryRunner.query(
      `UPDATE "subtitle_files"
          SET "language" = lower(split_part(split_part("language", '-', 1), '_', 1))
        WHERE "language" ~ '[-_]'`,
    );

    // 2) Map ISO 639-2 (B/T) three-letter codes to ISO 639-1, matching
    //    ISO_639_2_TO_1 in src/common/constants/app-languages.ts. Codes not in
    //    the table are left as-is (same as the runtime normalizer's fallback).
    await queryRunner.query(
      `UPDATE "subtitle_files" sf
          SET "language" = m.iso1
         FROM (VALUES
           ('eng','en'),('fre','fr'),('fra','fr'),('ger','de'),('deu','de'),
           ('spa','es'),('ita','it'),('por','pt'),('jpn','ja'),('kor','ko'),
           ('zho','zh'),('chi','zh'),('rus','ru'),('ara','ar'),('nld','nl'),
           ('dut','nl'),('pol','pl'),('tur','tr'),('swe','sv'),('dan','da'),
           ('nor','no'),('fin','fi'),('hin','hi'),('ces','cs'),('cze','cs'),
           ('ron','ro'),('rum','ro'),('hun','hu'),('tha','th'),('vie','vi'),
           ('heb','he'),('ell','el'),('gre','el'),('ukr','uk'),('bul','bg'),
           ('hrv','hr'),('srp','sr'),('slv','sl'),('slk','sk'),('slo','sk'),
           ('cat','ca'),('eus','eu'),('baq','eu'),('glg','gl'),('ind','id'),
           ('msa','ms'),('may','ms')
         ) AS m(iso2, iso1)
        WHERE lower(sf."language") = m.iso2`,
    );
  }

  public async down(): Promise<void> {
    // No rollback: the original regional/639-2 spellings aren't recoverable,
    // and the canonical codes remain valid language tags.
  }
}
