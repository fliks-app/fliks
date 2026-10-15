UPDATE "subtitle_files"
          SET "language" = lower(split_part(split_part("language", '-', 1), '_', 1))
        WHERE "language" ~ '[-_]';

UPDATE "subtitle_files" sf
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
        WHERE lower(sf."language") = m.iso2;
