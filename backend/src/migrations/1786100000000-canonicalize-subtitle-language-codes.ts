import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Re-canonicalise stored subtitle language codes with the complete ISO 639-2 → 639-1
 * table (`iso-639-2.ts`): the previous migration only knew 37 codes, so `est`, `isl`,
 * `per`, `nob`… stayed 3-letter and never matched what the players report. Also folds
 * the deprecated and Norwegian variants (`iw`, `in`, `nb`, `nn`…) like the runtime
 * normalizer. New writes are folded by the SubtitleFile.language column transformer.
 */
export class CanonicalizeSubtitleLanguageCodes1786100000000 implements MigrationInterface {
  name = 'CanonicalizeSubtitleLanguageCodes1786100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "subtitle_files"
          SET "language" = lower(split_part(split_part("language", '-', 1), '_', 1))
        WHERE "language" ~ '[-_]'`,
    );

    await queryRunner.query(
      `UPDATE "subtitle_files" sf
          SET "language" = m.canonical
         FROM (VALUES
           ('aar','aa'),('abk','ab'),('afr','af'),('aka','ak'),('alb','sq'),('amh','am'),
           ('ara','ar'),('arb','ar'),('arg','an'),('arm','hy'),('asm','as'),('ava','av'),
           ('ave','ae'),('aym','ay'),('aze','az'),('bak','ba'),('bam','bm'),('baq','eu'),
           ('bel','be'),('ben','bn'),('bis','bi'),('bod','bo'),('bos','bs'),('bre','br'),
           ('bul','bg'),('bur','my'),('cat','ca'),('ces','cs'),('cha','ch'),('che','ce'),
           ('chi','zh'),('chu','cu'),('chv','cv'),('cmn','zh'),('cor','kw'),('cos','co'),
           ('cre','cr'),('cym','cy'),('cze','cs'),('dan','da'),('deu','de'),('div','dv'),
           ('dut','nl'),('dzo','dz'),('ell','el'),('eng','en'),('epo','eo'),('est','et'),
           ('eus','eu'),('ewe','ee'),('fao','fo'),('fas','fa'),('fij','fj'),('fin','fi'),
           ('fra','fr'),('fre','fr'),('fry','fy'),('ful','ff'),('geo','ka'),('ger','de'),
           ('gla','gd'),('gle','ga'),('glg','gl'),('glv','gv'),('gre','el'),('grn','gn'),
           ('guj','gu'),('hat','ht'),('hau','ha'),('heb','he'),('her','hz'),('hin','hi'),
           ('hmo','ho'),('hrv','hr'),('hun','hu'),('hye','hy'),('ibo','ig'),('ice','is'),
           ('ido','io'),('iii','ii'),('iku','iu'),('ile','ie'),('in','id'),('ina','ia'),
           ('ind','id'),('ipk','ik'),('isl','is'),('ita','it'),('iw','he'),('jav','jv'),
           ('ji','yi'),('jpn','ja'),('jw','jv'),('kal','kl'),('kan','kn'),('kas','ks'),
           ('kat','ka'),('kau','kr'),('kaz','kk'),('khm','km'),('kik','ki'),('kin','rw'),
           ('kir','ky'),('kom','kv'),('kon','kg'),('kor','ko'),('kua','kj'),('kur','ku'),
           ('lao','lo'),('lat','la'),('lav','lv'),('lim','li'),('lin','ln'),('lit','lt'),
           ('ltz','lb'),('lub','lu'),('lug','lg'),('mac','mk'),('mah','mh'),('mal','ml'),
           ('mao','mi'),('mar','mr'),('may','ms'),('mkd','mk'),('mlg','mg'),('mlt','mt'),
           ('mo','ro'),('mon','mn'),('mri','mi'),('msa','ms'),('mya','my'),('nau','na'),
           ('nav','nv'),('nb','no'),('nbl','nr'),('nde','nd'),('ndo','ng'),('nep','ne'),
           ('nld','nl'),('nn','no'),('nno','no'),('nob','no'),('nor','no'),('nya','ny'),
           ('oci','oc'),('oji','oj'),('ori','or'),('orm','om'),('oss','os'),('pan','pa'),
           ('per','fa'),('pli','pi'),('pol','pl'),('por','pt'),('pus','ps'),('que','qu'),
           ('roh','rm'),('ron','ro'),('rum','ro'),('run','rn'),('rus','ru'),('sag','sg'),
           ('san','sa'),('scc','sr'),('scr','hr'),('sin','si'),('slk','sk'),('slo','sk'),
           ('slv','sl'),('sme','se'),('smo','sm'),('sna','sn'),('snd','sd'),('som','so'),
           ('sot','st'),('spa','es'),('sqi','sq'),('srd','sc'),('srp','sr'),('ssw','ss'),
           ('sun','su'),('swa','sw'),('swe','sv'),('tah','ty'),('tam','ta'),('tat','tt'),
           ('tel','te'),('tgk','tg'),('tgl','tl'),('tha','th'),('tib','bo'),('tir','ti'),
           ('ton','to'),('tsn','tn'),('tso','ts'),('tuk','tk'),('tur','tr'),('tw','ak'),
           ('twi','ak'),('uig','ug'),('ukr','uk'),('urd','ur'),('uzb','uz'),('ven','ve'),
           ('vie','vi'),('vol','vo'),('wel','cy'),('wln','wa'),('wol','wo'),('xho','xh'),
           ('yid','yi'),('yor','yo'),('zha','za'),('zho','zh'),('zul','zu')
         ) AS m(code, canonical)
        WHERE lower(sf."language") = m.code`,
    );
  }

  public async down(): Promise<void> {
    // No rollback: the original spellings aren't recoverable and the canonical
    // codes remain valid language tags.
  }
}
